// The app updating itself, for real, on macOS: an installed copy of the app that was just built finds
// a newer release (served from this machine, standing in for GitHub), downloads it, swaps the bundle
// and opens itself again as the new version, and the daemon the old one started is gone.
//
// The daemon uses a temporary data directory, set for the
// relaunched app too through launchd (an app opened by `open` does not inherit this process's
// environment) for as long as the test runs, and removed afterwards. launchd's environment is the whole login
// session's, so what was set there before is put back, not removed (test/launchd-env.ts).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CycleClient, connectUnix } from "@cycle/client";
import { scanBundle } from "../../src/main/delta.ts";
import {
  archiveName,
  isNewer,
  manifestFor,
  manifestName,
  RELEASE_REPO,
} from "../../src/shared/release.ts";
import { setLaunchdEnv } from "../launchd-env.ts";
import { evaluate } from "./cdp.ts";
import { signedIn } from "./signed-in.ts";
import { run, signedTeam, unpackSignedRelease } from "./update-release.ts";

const given = process.env.CYCLE_PACKAGED_APP;
const from = process.env.CYCLE_SIGNED_FROM;
const to = process.env.CYCLE_SIGNED_TO;
const signed = from !== undefined || to !== undefined;
const differentTeam = process.env.CYCLE_EXPECT_DIFFERENT_TEAM === "1";
if ((signed || differentTeam) && (!from || !to || process.platform !== "darwin"))
  throw new Error("Signed update tests require macOS, CYCLE_SIGNED_FROM and CYCLE_SIGNED_TO.");
const ready = process.platform === "darwin" && (signed || given !== undefined);

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cv1-update-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async <T>(
  what: string,
  ms: number,
  probe: () => Promise<T | undefined> | T | undefined,
) => {
  const started = Date.now();
  for (;;) {
    const value = await Promise.resolve(probe()).catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
};

const resources = "Contents/Resources/app";

const syntheticRelease = async (next: string) => {
  // A newer build: the same app with its version raised, signed again as ad hoc as the build is.
  const info = JSON.parse(await readFile(join(next, resources, "build.json"), "utf8")) as {
    version: string;
    platform: string;
    arch: string;
  };
  const [major, minor, patch] = info.version.split(".").map(Number);
  const newer = `${major}.${minor}.${(patch ?? 0) + 1}`;
  for (const file of ["build.json", "package.json"]) {
    const path = join(next, resources, file);
    const json = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, `${JSON.stringify({ ...json, version: newer }, null, 2)}\n`);
  }
  run(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", next]);
  const zip = join(root, archiveName(newer, info.platform, info.arch));
  run(["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", next, zip]);

  const bytes = await readFile(zip);
  const manifest = manifestFor(
    { version: newer, platform: info.platform, arch: info.arch },
    { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length },
    await scanBundle(next),
  );
  return { json: JSON.stringify(manifest), manifest, zip };
};

const daemonVersion = async (data: string) => {
  const client = new CycleClient({ connect: () => connectUnix(join(data, "daemon.sock")) });
  try {
    await client.start();
    return client.serverVersion;
  } finally {
    await client.close();
  }
};

test.skipIf(!ready)(
  differentTeam
    ? "an installed signed app rejects a different team's update"
    : "an installed app updates itself to a newer release and opens again as it",
  async () => {
    const installedDir = join(root, "apps");
    const nextDir = join(root, "next");
    const installed = join(installedDir, "Cycle.app");
    const next = join(nextDir, "Cycle.app");
    await mkdir(installedDir);
    await mkdir(nextDir);
    const previous = from ? await unpackSignedRelease(from, installedDir) : undefined;
    if (!previous) {
      run(["/bin/cp", "-cR", given as string, installed]);
      run(["/bin/cp", "-cR", installed, next]);
    }
    const release = to ? await unpackSignedRelease(to, nextDir) : await syntheticRelease(next);
    const { manifest } = release;
    const newer = manifest.version;
    if (previous && "team" in release) {
      expect(isNewer(newer, previous.manifest.version)).toBe(true);
      expect(previous.team === release.team).toBe(!differentTeam);
    }
    const archive = Bun.file(release.zip);
    // What was asked of the archive: its end, and then only the files that are not in the installed app.
    let ranged = 0;
    let whole = 0;
    const archivePath = `/dl/${manifest.file}`;
    const manifestPath = `/dl/${manifestName(manifest.platform, manifest.arch)}`;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request): Response {
        const url = new URL(request.url);
        if (url.pathname === `/repos/${RELEASE_REPO}/releases`) {
          return Response.json([
            {
              tag_name: `v${newer}`,
              draft: false,
              assets: [archivePath, manifestPath].map((path) => ({
                name: path.split("/").at(-1),
                browser_download_url: `${url.origin}${path}`,
              })),
            },
          ]);
        }
        if (url.pathname === manifestPath) return new Response(release.json);
        if (url.pathname !== archivePath) return new Response("missing", { status: 404 });
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
        if (range === null) {
          whole++;
          return new Response(archive);
        }
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), archive.size - 1);
        ranged += end - start + 1;
        return new Response(archive.slice(start, end + 1), {
          status: 206,
          headers: { "content-range": `bytes ${start}-${end}/${archive.size}` },
        });
      },
    });

    const data = join(root, "data");
    const url = `http://127.0.0.1:${server.port}`;
    const port = 20000 + Math.floor(Math.random() * 20000);
    // Signed in to a stand-in, in the test's own folder: the app opened again by the update finds the same login there
    // (and never the person's own, nor the keychain).
    const userData = join(root, "electron");
    const sso = await signedIn(userData);
    const environment = {
      CYCLE_HOME: data,
      CYCLE_UPDATE_URL: url,
      CYCLE_ANALYTICS: "off",
      CYCLE_USER_DATA: userData,
      ...sso.env,
    };
    const exe = join(installed, "Contents/MacOS/Electron");
    let old: ReturnType<typeof Bun.spawn> | undefined;
    let putBack: (() => void) | undefined;
    try {
      // What `open` starts does not get this process's environment; launchd's is where it can be set.
      putBack = setLaunchdEnv((args) => run(["/bin/launchctl", ...args]), environment);
      old = Bun.spawn(
        [exe, "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`],
        {
          // The packaged app carries the real project key: a test must say that nothing is to be reported.
          env: { PATH: "/usr/bin:/bin", HOME: root, ...environment },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      const line = await until("the update to be offered", 60_000, () =>
        evaluate(
          port,
          // The update is one of the app's notices over the sidebar's foot (the account's and analytics' may be there too).
          `[...document.querySelectorAll('[data-slot="app-notice-text"]')].map((e) => e.textContent).find((t) => t.includes(${JSON.stringify(newer)})) ?? null`,
        ).then((text) => (typeof text === "string" && text.includes(newer) ? text : undefined)),
      );
      expect(line).toBe(`Version ${newer} is available`);
      const oldDaemon = await until("the old app's daemon", 45_000, async () => {
        const pid = Number((await readFile(join(data, "daemon.pid"), "utf8")).trim());
        return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
      });

      if (previous) expect(await daemonVersion(data)).toBe(previous.manifest.version);
      // The button asks first; here the answer is given straight to main, as the dialog's would.
      await evaluate(port, "void window.cycle.installUpdate(); 1");

      if (differentTeam && previous) {
        await until("the signing team rejection", 120_000, async () => {
          const line = await evaluate(
            port,
            'document.querySelector(\'[data-slot="app-notice"][data-tone="error"] [data-slot="app-notice-text"]\')?.textContent',
          );
          return typeof line === "string" && line.includes("not signed by the same team")
            ? true
            : undefined;
        });
        expect(whole > 0 || ranged > 0).toBe(true);
        expect(alive(old.pid)).toBe(true);
        expect(alive(oldDaemon)).toBe(true);
        expect(await daemonVersion(data)).toBe(previous.manifest.version);
        expect((await Bun.file(join(installed, resources, "build.json")).json()).version).toBe(
          previous.manifest.version,
        );
        expect(await readdir(installedDir)).toEqual(["Cycle.app"]);
        return;
      }
      await until("the old app to quit", 120_000, () => (alive(old?.pid ?? 0) ? undefined : true));
      // The bundle in place is the new one, opened again.
      const installedVersion = await until("the new bundle", 60_000, async () => {
        const text = await readFile(join(installed, resources, "build.json"), "utf8");
        return JSON.parse(text).version === newer ? newer : undefined;
      });
      expect(installedVersion).toBe(newer);
      if (previous) {
        expect(whole > 0 || ranged > 0).toBe(true);
        expect(signedTeam(installed)).toBe(previous.team);
      } else {
        // Only version files and signatures changed in the synthetic release.
        expect(whole).toBe(0);
        expect(ranged).toBeGreaterThan(0);
        expect(ranged).toBeLessThan(archive.size / 4);
      }
      const reopened = await until("the app to open again", 60_000, () => {
        const ps = Bun.spawnSync(["/usr/bin/pgrep", "-f", `${installed}/Contents/MacOS/Electron`]);
        const pid = Number(ps.stdout.toString().split("\n")[0]);
        return Number.isInteger(pid) && pid > 0 && pid !== old?.pid ? pid : undefined;
      });
      expect(alive(reopened)).toBe(true);
      // The daemon the old app started is gone (the new one may be starting its own).
      await until("the old daemon to stop", 30_000, () => (alive(oldDaemon) ? undefined : true));
      if (previous) {
        const version = await until("the relaunched app's daemon", 30_000, () =>
          daemonVersion(data),
        );
        expect(version).toBe(newer);
      }
      const runningPid = await until("the replacement daemon", 30_000, async () => {
        const pid = Number(await readFile(join(data, "daemon.pid"), "utf8"));
        return Number.isInteger(pid) && pid > 0 && pid !== oldDaemon && alive(pid)
          ? pid
          : undefined;
      });
      // A synthetic release carries the same daemon version. Match its mapped executable to the
      // installed file by inode, so a daemon restarted by the old desktop also fails that test.
      const mapped = Bun.spawnSync([
        "/usr/sbin/lsof",
        "-nP",
        "-a",
        "-p",
        String(runningPid),
        "-d",
        "txt",
        join(installed, resources, "bin/cycle"),
      ]);
      expect(mapped.success).toBe(true);
      if (previous) {
        console.log(
          `Signed update ${previous.manifest.version} -> ${newer}, team ${previous.team}; daemon ${runningPid} running from installed bundle; range bytes ${ranged}, whole downloads ${whole}.`,
        );
      }
      // And nothing of the update is left beside the app.
      expect(await readdir(join(root, "apps"))).toEqual(["Cycle.app"]);
      expect(existsSync(join(root, "apps", ".Cycle-old"))).toBe(false);
    } finally {
      putBack?.();
      server.stop(true);
      await sso.idp.close();
      old?.kill();
      // Whatever of the app, new or old, runs from the test's own folder, and the daemon it started.
      Bun.spawnSync(["/usr/bin/pkill", "-f", join(root, "apps")]);
      try {
        const pid = Number(await readFile(join(data, "daemon.pid"), "utf8"));
        if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGTERM");
      } catch {}
    }
  },
  360_000,
);
