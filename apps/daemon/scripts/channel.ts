// Publishing the daemon to its release channel (src/channel.ts has the format; docs/daemon.md "自动更新", CYC-538). Run by
// the daemon-release workflow on each commit on main, in three steps:
//
//   plan      after the build: what each file of the built folder is before it is signed, and a hash of everything
//             the build read; `changed=true|false` against what is published for this platform
//   assemble  after the checks (and, on macOS, the signing): the manifest and the gzipped files not already published
//   publish   with the signing key: the files that are not there yet, then the signature, then the manifest; and what
//             no manifest needs any more is removed
//
// Written so that it is safe to run twice and out of order: a manifest that is not newer than the published one for the
// same platform is not published.
import { createHash, createPrivateKey, type KeyObject, sign } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { CYCLE_PROTOCOL_VERSION } from "@cycle/protocol";
import {
  blobName,
  type ChannelFile,
  channelBaseUrl,
  DAEMON_CHANNEL_REPO,
  DAEMON_CHANNEL_TAG,
  type DaemonManifest,
  daemonManifestName,
  daemonSignatureName,
  parseDaemonManifest,
} from "../src/channel.ts";
import { RELEASE_KEYS } from "../src/release-keys.ts";
import { olderThan } from "../src/version.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DAEMON = join(ROOT, "apps", "daemon");

/** Files of the built folder that are not part of the daemon: the installer is published apart from it. */
const NOT_SHIPPED = new Set(["install.sh"]);

/** How long a file no manifest needs is kept: a daemon may be downloading the version before. */
export const KEEP_UNUSED_MS = 24 * 3600 * 1000;

const sha256OfFile = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
};

/** Every file in a folder, by its path in it, sorted. */
export const filesIn = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out.push(relative(dir, path));
      else throw new Error(`${path} is neither a file nor a folder.`);
    }
  };
  await walk(dir);
  return out.filter((p) => !NOT_SHIPPED.has(p)).sort();
};

const modeOf = async (path: string): Promise<0o755 | 0o644> =>
  ((await stat(path)).mode & 0o111) !== 0 ? 0o755 : 0o644;

export type Plan = {
  /** Of everything the build read, the daemon's sources and every file shipped beside it. */
  inputs: string;
  /** Each file before it is signed. */
  files: Record<string, { sha256: string; size: number; mode: 0o755 | 0o644 }>;
};

/**
 * What the daemon's executable is made of: the bundler's inputs (its sources and the packages it uses) and the build's
 * own recipe, with the Bun that compiles it. Not the executable's bytes: the version is put in it, so they change with
 * every commit even when nothing else does.
 */
export const daemonSourcesHash = async (): Promise<string> => {
  const result = await Bun.build({
    entrypoints: [join(DAEMON, "src/main.ts")],
    target: "bun",
    metafile: true,
    throw: false,
  } as Parameters<typeof Bun.build>[0]);
  const metafile = (result as unknown as { metafile?: { inputs: Record<string, unknown> } })
    .metafile;
  if (!result.success || metafile === undefined)
    throw new Error("The daemon's sources could not be bundled to list them.");
  const hash = createHash("sha256");
  hash.update(`bun ${Bun.version}\n`);
  const recipe = ["apps/daemon/scripts/build.ts", "apps/daemon/scripts/binaries.ts"].map((p) =>
    join(ROOT, p),
  );
  // The bundler names its inputs from the working directory: each is hashed by its place in the repository instead.
  const inputs = Object.keys(metafile.inputs).map((p) => resolve(process.cwd(), p));
  let missing = 0;
  for (const absolute of [...recipe, ...inputs.sort()]) {
    const known = existsSync(absolute);
    // Inputs the bundler made up (a `bun:` module) have no file to read: their name is enough.
    if (!known) missing++;
    hash.update(
      `${relative(ROOT, absolute)}\n${known ? await sha256OfFile(absolute) : "virtual"}\n`,
    );
  }
  if (missing > inputs.length / 10)
    throw new Error(`${missing} of the daemon's ${inputs.length} sources could not be read.`);
  return hash.digest("hex");
};

/** The plan of a built folder: see the top of this file. `sources` is `daemonSourcesHash`, given for the tests. */
export const plan = async (dir: string, sources: string, majorMinor: string): Promise<Plan> => {
  const files: Plan["files"] = {};
  const hash = createHash("sha256");
  hash.update(`daemon-inputs v1\n${majorMinor}\ncycle ${sources}\n`);
  for (const path of await filesIn(dir)) {
    const full = join(dir, path);
    const entry = {
      sha256: await sha256OfFile(full),
      size: (await stat(full)).size,
      mode: await modeOf(full),
    };
    files[path] = entry;
    // The executable's bytes carry the version: what it is made of is `sources`.
    if (path !== "cycle") hash.update(`${path} ${entry.mode.toString(8)} ${entry.sha256}\n`);
  }
  if (files.cycle === undefined) throw new Error(`${dir} has no daemon (cycle).`);
  return { inputs: hash.digest("hex"), files };
};

/**
 * The manifest of a built (and on macOS signed) folder, and the files to upload. A file whose unsigned bytes are the
 * same as the published one's (`source`, macOS) is the published one: its entry is kept and nothing is uploaded, so a
 * daemon that has it downloads nothing. Elsewhere the same bytes have the same hash and name, which comes to the same.
 */
export const assemble = async (o: {
  dir: string;
  plan: Plan;
  previous: DaemonManifest | undefined;
  version: string;
  commit: string;
  platform: string;
  arch: string;
  keyId: string;
  /** Whether the files were signed after the plan: then each entry says its unsigned hash. */
  signed: boolean;
}): Promise<{ manifest: DaemonManifest; upload: string[] }> => {
  const files: Record<string, ChannelFile> = {};
  const upload: string[] = [];
  for (const path of await filesIn(o.dir)) {
    const before = o.plan.files[path];
    if (before === undefined) throw new Error(`${path} was not in the folder when it was planned.`);
    const earlier = o.previous?.files[path];
    if (o.signed && earlier?.source !== undefined && earlier.source === before.sha256) {
      files[path] = earlier;
      continue;
    }
    const full = join(o.dir, path);
    files[path] = {
      sha256: await sha256OfFile(full),
      size: (await stat(full)).size,
      mode: await modeOf(full),
      ...(o.signed ? { source: before.sha256 } : {}),
    };
    upload.push(path);
  }
  const manifest: DaemonManifest = {
    v: 1,
    kind: "daemon",
    version: o.version,
    commit: o.commit,
    platform: o.platform,
    arch: o.arch,
    protocol: CYCLE_PROTOCOL_VERSION,
    inputs: o.plan.inputs,
    keyId: o.keyId,
    files,
  };
  if (parseDaemonManifest(JSON.stringify(manifest)) === undefined)
    throw new Error("The manifest made is not one a daemon takes.");
  return { manifest, upload };
};

/** Gzips a file without a name or time in it, so the same bytes give the same file. */
const gzipTo = async (from: string, to: string): Promise<void> => {
  const child = Bun.spawn(["gzip", "-n", "-9", "-c", from], { stdout: Bun.file(to) });
  if ((await child.exited) !== 0) throw new Error(`gzip failed on ${from}`);
};

/** The signing key: Ed25519, PKCS#8, as PEM or as base64 of its DER (the same as the interface bundles'). */
export const signingKey = (text: string): KeyObject => {
  const trimmed = text.trim();
  return trimmed.startsWith("-----")
    ? createPrivateKey(trimmed)
    : createPrivateKey({ key: Buffer.from(trimmed, "base64"), format: "der", type: "pkcs8" });
};

export type Gh = (args: string[]) => Promise<string>;
export type Asset = { name: string; updatedAt: string };

const BLOB = /^daemon-blob-([0-9a-f]{64})\.gz$/;

/** The blobs to remove: those no current manifest names, once nobody can be downloading them. */
export const blobsToDelete = (
  assets: readonly Asset[],
  needed: ReadonlySet<string>,
  now: number,
): string[] =>
  assets
    .filter((a) => BLOB.test(a.name) && !needed.has(a.name))
    .filter((a) => now - Date.parse(a.updatedAt) > KEEP_UNUSED_MS)
    .map((a) => a.name);

/**
 * Puts one or more assembled platforms (`<in>/<platform>-<arch>/`: the manifest and `blobs/`) on the channel. For each:
 * the blobs that are not there yet, then the signature, then the manifest, which is what a daemon reads first.
 */
export const publish = async (o: {
  gh: Gh;
  repo: string;
  sha: string;
  dirs: string[];
  key: KeyObject;
  now: number;
  log?: (line: string) => void;
}): Promise<{ published: string[]; deleted: string[] }> => {
  const log = o.log ?? console.log;
  const tag = DAEMON_CHANNEL_TAG;
  await o
    .gh(["release", "view", tag, "--repo", o.repo])
    .catch(() =>
      o.gh([
        "release",
        "create",
        tag,
        "--repo",
        o.repo,
        "--target",
        o.sha,
        "--prerelease",
        "--latest=false",
        "--title",
        "Daemon",
        "--notes",
        "Rolling: the newest daemon for each platform, which installed daemons update themselves to when idle (docs/daemon.md). Not an app.",
      ]),
    );
  const listed = async () =>
    (
      JSON.parse(await o.gh(["release", "view", tag, "--repo", o.repo, "--json", "assets"])) as {
        assets: Asset[];
      }
    ).assets;
  const have = new Set((await listed()).map((a) => a.name));
  const published: string[] = [];
  const manifests = new Map<string, DaemonManifest>();
  for (const dir of o.dirs) {
    const name = (await readdir(dir)).find((n) => /^daemon-[a-z0-9]+-[a-z0-9]+\.json$/.test(n));
    if (name === undefined) throw new Error(`${dir} has no manifest.`);
    const text = await readFile(join(dir, name), "utf8");
    const made = parseDaemonManifest(text);
    if (made === undefined) throw new Error(`${dir}/${name} is not a valid manifest.`);
    if (!Object.hasOwn(RELEASE_KEYS, made.keyId))
      throw new Error(`No key ${made.keyId} is built into the daemon (src/release-keys.ts).`);
    const current = await o
      .gh(["release", "download", tag, "--repo", o.repo, "-p", name, "-O", "-"])
      .then((t) => parseDaemonManifest(t))
      .catch(() => undefined);
    if (current !== undefined && !olderThan(current.version, made.version)) {
      log(
        `${current.version} is already published for ${made.platform}-${made.arch}; not ${made.version}.`,
      );
      manifests.set(name, current);
      continue;
    }
    for (const file of Object.values(made.files)) {
      const blob = blobName(file.sha256);
      if (have.has(blob)) continue;
      const path = join(dir, "blobs", blob);
      if (!existsSync(path)) throw new Error(`${blob} is neither published nor in ${dir}/blobs.`);
      await o.gh(["release", "upload", tag, path, "--repo", o.repo, "--clobber"]);
      have.add(blob);
    }
    const signature = `${sign(null, Buffer.from(text), o.key).toString("base64")}\n`;
    const sigPath = join(dir, daemonSignatureName(made.platform, made.arch));
    await writeFile(sigPath, signature);
    await o.gh(["release", "upload", tag, sigPath, "--repo", o.repo, "--clobber"]);
    await o.gh(["release", "upload", tag, join(dir, name), "--repo", o.repo, "--clobber"]);
    manifests.set(name, made);
    published.push(`${made.platform}-${made.arch} ${made.version}`);
    log(`Published daemon ${made.version} for ${made.platform}-${made.arch}.`);
  }
  // What any platform's current manifest names stays, including the platforms not published this time.
  const assets = await listed();
  for (const asset of assets) {
    if (!/^daemon-[a-z0-9]+-[a-z0-9]+\.json$/.test(asset.name) || manifests.has(asset.name))
      continue;
    const other = await o
      .gh(["release", "download", tag, "--repo", o.repo, "-p", asset.name, "-O", "-"])
      .then((t) => parseDaemonManifest(t))
      .catch(() => undefined);
    if (other !== undefined) manifests.set(asset.name, other);
  }
  const needed = new Set(
    [...manifests.values()].flatMap((m) => Object.values(m.files).map((f) => blobName(f.sha256))),
  );
  const deleted = blobsToDelete(assets, needed, o.now);
  for (const blob of deleted)
    await o.gh(["release", "delete-asset", tag, blob, "--repo", o.repo, "--yes"]);
  if (deleted.length > 0) log(`Removed ${deleted.length} files no manifest needs.`);
  return { published, deleted };
};

const arg = (name: string): string | undefined => {
  const i = Bun.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : Bun.argv[i + 1];
};
const need = (name: string): string => {
  const value = arg(name);
  if (value === undefined) throw new Error(`--${name} is required.`);
  return value;
};

/** The published manifest for a platform, or undefined when there is none. */
const publishedManifest = async (platform: string, arch: string) => {
  const response = await fetch(
    `${channelBaseUrl(process.env.GITHUB_REPOSITORY || DAEMON_CHANNEL_REPO)}${daemonManifestName(platform, arch)}`,
    {
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    },
  ).catch(() => undefined);
  return response?.ok === true ? parseDaemonManifest(await response.text()) : undefined;
};

const output = async (line: string) => {
  console.log(line);
  if (process.env.GITHUB_OUTPUT)
    await writeFile(process.env.GITHUB_OUTPUT, `${line}\n`, { flag: "a" });
};

if (import.meta.main) {
  const command = Bun.argv[2];
  const platform = arg("platform") ?? process.platform;
  const arch = arg("arch") ?? process.arch;
  if (command === "plan") {
    const dir = need("dir");
    const version = need("version");
    const majorMinor = version.split(".").slice(0, 2).join(".");
    const made = await plan(dir, await daemonSourcesHash(), majorMinor);
    await writeFile(need("out"), `${JSON.stringify(made, null, 2)}\n`);
    const current = await publishedManifest(platform, arch);
    await output(`changed=${current?.inputs !== made.inputs}`);
  } else if (command === "assemble") {
    const dir = need("dir");
    const out = need("out");
    const made = await assemble({
      dir,
      plan: JSON.parse(await readFile(need("plan"), "utf8")) as Plan,
      previous: await publishedManifest(platform, arch),
      version: need("version"),
      commit: need("commit"),
      platform,
      arch,
      keyId: process.env.UI_SIGNING_KEY_ID || "k1",
      signed: arg("signed") === "true",
    });
    await mkdir(join(out, "blobs"), { recursive: true });
    for (const path of made.upload)
      await gzipTo(
        join(dir, path),
        join(out, "blobs", blobName(made.manifest.files[path]?.sha256 ?? "")),
      );
    await writeFile(
      join(out, daemonManifestName(platform, arch)),
      `${JSON.stringify(made.manifest, null, 2)}\n`,
    );
    console.log(
      `${made.manifest.version} ${platform}-${arch}: ${made.upload.length} files to upload`,
    );
  } else if (command === "publish") {
    const key = process.env.UI_SIGNING_KEY;
    if (!key) throw new Error("UI_SIGNING_KEY is not set.");
    const dirs = (await readdir(need("in"), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => join(need("in"), e.name));
    const gh: Gh = async (args) => {
      const result = Bun.spawnSync(["gh", ...args], { stderr: "pipe" });
      if (!result.success)
        throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr.toString()}`);
      return result.stdout.toString();
    };
    console.log(
      JSON.stringify(
        await publish({
          gh,
          repo: process.env.GITHUB_REPOSITORY || DAEMON_CHANNEL_REPO,
          sha: process.env.GITHUB_SHA ?? "main",
          dirs,
          key: signingKey(key),
          now: Date.now(),
        }),
      ),
    );
  } else {
    console.error("bun scripts/channel.ts plan|assemble|publish ...");
    process.exit(2);
  }
}
