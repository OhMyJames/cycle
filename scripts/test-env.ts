// Preloaded by `bun test` (bunfig.toml): the tests must not find the agent programs installed on this machine.
// A daemon a test starts inherits this process's HOME and PATH; with the real ones it finds ~/.local/bin/agy, runs
// `agy plugin list`, and sets up agy's keychain with /usr/bin/security, which on a Mac pops up keychain and agy
// sign-in windows. So HOME is a fresh empty folder and PATH loses every directory that holds an `agy`.
// `bun run test:integration` starts real agents on purpose and sets CYCLE_TEST_REAL_AGENTS=1 to keep the real ones.
// On a Mac that empty HOME gets a keychain of its own: the Claude a test starts stores its key with `security`, and in a
// HOME with no keychain macOS answers with a "Keychain Not Found" window on the person's screen.
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ensureHomeKeychain } from "../apps/daemon/src/home-keychain.ts";

const AGENT_PROGRAMS = ["agy"];

const holdsAgent = (dir: string): boolean =>
  AGENT_PROGRAMS.some((name) => {
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

/** PATH without the directories that hold one of the agent programs. */
export const withoutAgents = (path: string): string =>
  path
    .split(delimiter)
    .filter((dir) => dir !== "" && !holdsAgent(dir))
    .join(delimiter);

if (process.env.CYCLE_TEST_REAL_AGENTS !== "1") {
  const home = mkdtempSync(join(tmpdir(), "cycle-test-home-"));
  process.on("exit", () => rmSync(home, { recursive: true, force: true }));
  process.env.HOME = home;
  ensureHomeKeychain(home);
  process.env.PATH = withoutAgents(process.env.PATH ?? "");
  // Git still needs a name to commit with once the person's ~/.gitconfig is out of sight.
  process.env.GIT_AUTHOR_NAME ??= "test";
  process.env.GIT_AUTHOR_EMAIL ??= "test@example.com";
  process.env.GIT_COMMITTER_NAME ??= "test";
  process.env.GIT_COMMITTER_EMAIL ??= "test@example.com";
}
