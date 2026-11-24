import { afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Runs git in `dir` as a test sets a repository up: none of the person's own configuration, hooks or identity (HOME is
 * the folder itself, and the system's configuration is not read). Throws when git fails.
 */
export const gitIn = (dir: string, ...args: string[]): string => {
  const result = Bun.spawnSync(
    [
      "git",
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: dir, GIT_CONFIG_NOSYSTEM: "1" },
    },
  );
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
};

/** A fresh directory under the system's temporary one, removed when `dispose` runs. */
export const tempDir = async (): Promise<{ dir: string; dispose: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-v1-test-"));
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
};

/**
 * A fresh directory for each test, `use` given its path before the test runs, and removed after it once `before` is
 * done, whatever `before` throws.
 */
const directoryEach = (use: (dir: string) => void, before?: () => Promise<void>): void => {
  let dispose: (() => Promise<void>) | undefined;
  beforeEach(async () => {
    const made = await tempDir();
    dispose = made.dispose;
    use(made.dir);
  });
  afterEach(async () => {
    const removing = dispose;
    dispose = undefined;
    try {
      await before?.();
    } finally {
      await removing?.();
    }
  });
};

/** A fresh directory for each test of the file, removed after it; `use` is given its path before the test runs. */
export const eachTempDir = (use: (dir: string) => void): void => directoryEach(use);

/**
 * What most daemon tests begin with: a fresh directory for each test (`use` is given its path), and the list a test
 * puts what it opens in. After the test each of those is closed, in the order it was opened, and then the directory
 * is removed: nothing is still writing into it. One that fails to close does not keep the others open; the first
 * failure is the test's.
 */
export const daemonHarness = <T extends { close(): unknown }>(use: (dir: string) => void): T[] => {
  const open: T[] = [];
  directoryEach(use, async () => {
    let failure: unknown;
    for (const item of open.splice(0)) {
      try {
        await item.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  });
  return open;
};
