import { expect, test } from "bun:test";
import { withRepoLock } from "../src/git-lock.ts";

const job =
  (log: string[], name: string, ms = 15) =>
  async () => {
    log.push(`${name}:start`);
    await Bun.sleep(ms);
    log.push(`${name}:end`);
    return name;
  };

test("the same repoRoot runs one call at a time, in order", async () => {
  const log: string[] = [];
  const out = await Promise.all([
    withRepoLock("/r", job(log, "a")),
    withRepoLock("/r", job(log, "b")),
  ]);
  expect(out).toEqual(["a", "b"]);
  expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
});

test("different repoRoots overlap", async () => {
  const log: string[] = [];
  await Promise.all([withRepoLock("/x", job(log, "a")), withRepoLock("/y", job(log, "b"))]);
  expect(log.slice(0, 2)).toEqual(["a:start", "b:start"]);
});

test("a throwing call releases the lock", async () => {
  const log: string[] = [];
  const first = withRepoLock("/z", async () => {
    await Bun.sleep(5);
    throw new Error("boom");
  });
  const second = withRepoLock("/z", job(log, "b"));
  await expect(first).rejects.toThrow("boom");
  expect(await second).toBe("b");
});
