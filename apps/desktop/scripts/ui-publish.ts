// `bun run ui-publish` (the ui-release workflow): puts the bundle `ui-package` made on the repository's `ui-latest` release,
// and removes the bundles that are no longer needed. Written so that it is safe to run twice, and out of order:
//
//  - the archive goes up first, then the signature, then the manifest: the manifest is what an app reads to find the rest,
//    so it is the last thing to change;
//  - a bundle that is not newer than the one published for the same contract major is not published (a run that waited
//    its turn for a newer commit's run must not put its older page over it);
//  - what is removed is the older archives of a line (three are kept), and the bundles of a line no recent release was
//    built with and that nobody has published for a week. A line is a contract major (`ui-c<major>…`), or, for the
//    apps before CYC-539, the hash of a shell (`ui-<hash>…`), to which nothing is published any more.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RELEASE_REPO } from "../src/shared/release.ts";
import {
  parseManifest,
  UI_RELEASE_TAG,
  uiManifestName,
  uiSignatureName,
} from "../src/shared/ui-bundle.ts";
import { UI_OUT_DIR } from "./ui-package.ts";

export const KEEP_ARCHIVES = 3;
export const KEEP_UNUSED_LINE_MS = 7 * 24 * 3600 * 1000;

export type Asset = { name: string; updatedAt: string };

const NAME = /^ui-([0-9a-f]{32}|c\d+)(?:\.json|\.json\.sig|-(\d+)\.zip)$/;

/** The line of the apps of a release, from what its manifest says (release-assets.ts). */
export const lineOfRelease = (info: { contract?: unknown; shell?: unknown }): string | undefined =>
  typeof info.contract === "number"
    ? `c${info.contract}`
    : typeof info.shell === "string"
      ? info.shell
      : undefined;

/** The names of the assets to remove: see the top of this file. */
export const assetsToDelete = (
  assets: readonly Asset[],
  options: { keepLines: ReadonlySet<string>; now: number },
): string[] => {
  const byLine = new Map<
    string,
    { name: string; updatedAt: number; version?: number; manifest: boolean }[]
  >();
  for (const asset of assets) {
    const match = NAME.exec(asset.name);
    if (match === null) continue;
    const line = match[1] as string;
    const list = byLine.get(line) ?? [];
    list.push({
      name: asset.name,
      updatedAt: Date.parse(asset.updatedAt),
      manifest: asset.name.endsWith(".json"),
      ...(match[2] !== undefined ? { version: Number(match[2]) } : {}),
    });
    byLine.set(line, list);
  }
  const doomed: string[] = [];
  for (const [line, list] of byLine) {
    const manifest = list.find((a) => a.manifest);
    const unused =
      !options.keepLines.has(line) &&
      (manifest === undefined || options.now - manifest.updatedAt > KEEP_UNUSED_LINE_MS);
    if (unused) {
      doomed.push(...list.map((a) => a.name));
      continue;
    }
    const archives = list
      .filter((a) => a.version !== undefined)
      .sort((a, b) => (b.version as number) - (a.version as number));
    doomed.push(...archives.slice(KEEP_ARCHIVES).map((a) => a.name));
  }
  return doomed;
};

export type Gh = (args: string[]) => Promise<string>;

export const publish = async (options: {
  gh: Gh;
  repo: string;
  outDir: string;
  /** The commit the release's tag is made at, the first time. */
  sha: string;
  now: number;
  log?: (message: string) => void;
}): Promise<{ published: boolean; deleted: string[] }> => {
  const { gh, repo, outDir } = options;
  const log = options.log ?? console.log;
  const tag = UI_RELEASE_TAG;
  const made = parseManifest(
    await readFile(join(outDir, (await findManifestName(outDir)) as string)),
  );
  if (made === undefined) throw new Error("The manifest to publish is not valid.");
  const { contract, uiVersion } = made;

  // A pre-release, and not the latest: it is not an app, and must not be what the repository shows as one.
  await gh(["release", "view", tag, "--repo", repo]).catch(() =>
    gh([
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--target",
      options.sha,
      "--prerelease",
      "--latest=false",
      "--title",
      "Interface bundles",
      "--notes",
      "Rolling: the pages the installed app can take without a new version (docs/desktop.md, Interface updates). Not an app.",
    ]),
  );

  const published = await gh([
    "release",
    "download",
    tag,
    "--repo",
    repo,
    "-p",
    uiManifestName(contract),
    "-O",
    "-",
  ])
    .then((text) => parseManifest(text)?.uiVersion ?? -1)
    .catch(() => -1);
  if (published >= uiVersion) {
    log(
      `Interface ${published} is already published for contract ${contract}; not publishing ${uiVersion}.`,
    );
    return { published: false, deleted: [] };
  }
  for (const file of [made.file, uiSignatureName(contract), uiManifestName(contract)])
    await gh(["release", "upload", tag, join(outDir, file), "--repo", repo, "--clobber"]);
  log(`Published interface ${uiVersion} for contract ${contract}.`);

  // The lines of the last three releases are in use by someone.
  const keep = new Set([`c${contract}`]);
  const releases = JSON.parse(
    await gh([
      "release",
      "list",
      "--repo",
      repo,
      "--exclude-pre-releases",
      "--exclude-drafts",
      "--limit",
      "3",
      "--json",
      "tagName",
    ]),
  ) as { tagName: string }[];
  for (const { tagName } of releases) {
    const text = await gh([
      "release",
      "download",
      tagName,
      "--repo",
      repo,
      "-p",
      "latest-darwin-arm64.json",
      "-O",
      "-",
    ]).catch(() => "");
    try {
      const line = lineOfRelease(JSON.parse(text) as { contract?: unknown; shell?: unknown });
      if (line !== undefined) keep.add(line);
    } catch {}
  }
  const assets = (
    JSON.parse(await gh(["release", "view", tag, "--repo", repo, "--json", "assets"])) as {
      assets: Asset[];
    }
  ).assets;
  const deleted = assetsToDelete(assets, { keepLines: keep, now: options.now });
  for (const name of deleted)
    await gh(["release", "delete-asset", tag, name, "--repo", repo, "--yes"]);
  if (deleted.length > 0) log(`Removed ${deleted.join(", ")}.`);
  return { published: true, deleted };
};

const findManifestName = async (outDir: string): Promise<string | undefined> => {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(outDir)).find((n) => /^ui-c\d+\.json$/.test(n));
};

if (import.meta.main) {
  const gh: Gh = async (args) => {
    const result = Bun.spawnSync(["gh", ...args], { stderr: "pipe" });
    if (!result.success)
      throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr.toString()}`);
    return result.stdout.toString();
  };
  const result = await publish({
    gh,
    repo: process.env.GITHUB_REPOSITORY || RELEASE_REPO,
    outDir: UI_OUT_DIR,
    sha: process.env.GITHUB_SHA ?? "main",
    now: Date.now(),
  });
  console.log(JSON.stringify(result));
}
