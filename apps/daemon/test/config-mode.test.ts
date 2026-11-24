import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { secureConfigFile } from "../src/config.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cycle-config-mode-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

test("a config.json other users can read is tightened to 0600 and the old mode is returned", async () => {
  const path = join(dir, "config.json");
  await writeFile(path, "{}");
  await chmod(path, 0o644);
  expect(await secureConfigFile(path)).toBe(0o644);
  expect(await modeOf(path)).toBe(0o600);
});

test("a group-writable config.json is tightened too", async () => {
  const path = join(dir, "config.json");
  await writeFile(path, "{}");
  await chmod(path, 0o660);
  expect(await secureConfigFile(path)).toBe(0o660);
  expect(await modeOf(path)).toBe(0o600);
});

test("a config.json that is already owner-only is left alone", async () => {
  const path = join(dir, "config.json");
  await writeFile(path, "{}");
  await chmod(path, 0o400);
  expect(await secureConfigFile(path)).toBeUndefined();
  expect(await modeOf(path)).toBe(0o400);
});

test("a missing config.json is not an error and is not created", async () => {
  const path = join(dir, "config.json");
  expect(await secureConfigFile(path)).toBeUndefined();
  expect(await Bun.file(path).exists()).toBe(false);
});
