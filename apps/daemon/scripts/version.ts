// The daemon's version (docs/daemon.md "版本", CYC-538): the major and minor of the desktop app, and the number of
// commits on the branch it is built from. It rises with every commit on main, apart from the app's version, so a daemon
// published from the channel and the one an app release carries compare by number. `bun scripts/version.ts` prints it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION_FORMAT } from "../src/version.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

const git = (...args: string[]): string => {
  const result = Bun.spawnSync(["git", ...args], { cwd: ROOT, stderr: "ignore" });
  return result.success ? result.stdout.toString().trim() : "";
};

/**
 * `CYCLE_DAEMON_VERSION` when it is set (a test); else `<major>.<minor>.<commits>`. A shallow clone does not know how
 * many commits there are: it builds `<major>.<minor>.0`, older than any published daemon, and the release workflows
 * check that what they build is not that.
 */
export const daemonVersion = (env: Record<string, string | undefined> = process.env): string => {
  const given = env.CYCLE_DAEMON_VERSION;
  if (given !== undefined && given !== "") {
    if (!VERSION_FORMAT.test(given)) throw new Error(`CYCLE_DAEMON_VERSION=${given} is not x.y.z.`);
    return given;
  }
  const app = String(
    (
      JSON.parse(readFileSync(join(ROOT, "apps/desktop/package.json"), "utf8")) as {
        version?: string;
      }
    ).version ?? "",
  );
  const [major, minor] = app.split(".");
  if (!/^\d+$/.test(major ?? "") || !/^\d+$/.test(minor ?? ""))
    throw new Error(`The app's version ${app} has no major and minor.`);
  const shallow = git("rev-parse", "--is-shallow-repository") === "true";
  const count = shallow ? 0 : Number(git("rev-list", "--count", "HEAD")) || 0;
  return `${major}.${minor}.${count}`;
};

if (import.meta.main) console.log(daemonVersion());
