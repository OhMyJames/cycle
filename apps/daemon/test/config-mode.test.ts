import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, secureConfigFile } from "../src/config.ts";

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

test("a read-only config.json keeps being read-only: only group and other are taken away", async () => {
  const path = join(dir, "config.json");
  await writeFile(path, "{}");
  await chmod(path, 0o440);
  expect(await secureConfigFile(path)).toBe(0o440);
  expect(await modeOf(path)).toBe(0o400);
});

test("a symlinked config.json is left alone, and so is its target", async () => {
  const target = join(dir, "shared.json");
  const path = join(dir, "config.json");
  await writeFile(target, "{}");
  await chmod(target, 0o644);
  await symlink(target, path);
  expect(await secureConfigFile(path)).toBeUndefined();
  expect(await modeOf(target)).toBe(0o644);
});

test("an error other than a missing file is thrown, not taken for fine", async () => {
  const file = join(dir, "config.json");
  await writeFile(file, "{}");
  await expect(secureConfigFile(join(file, "nested"))).rejects.toThrow();
});

test("update.drainAfterMinutes and forceAfterMinutes default to 15, take a value, and name the field when wrong", async () => {
  const path = join(dir, "config.json");
  expect((await loadConfig(path)).update).toEqual({ drainAfterMinutes: 15, forceAfterMinutes: 15 });
  await writeFile(path, JSON.stringify({ update: { drainAfterMinutes: 0, forceAfterMinutes: 5 } }));
  expect((await loadConfig(path)).update).toEqual({ drainAfterMinutes: 0, forceAfterMinutes: 5 });
  await writeFile(path, JSON.stringify({ update: { drainAfterMinutes: -1 } }));
  await expect(loadConfig(path)).rejects.toThrow(/drainAfterMinutes/);
  await writeFile(path, JSON.stringify({ update: { forceAfterMinutes: "soon" } }));
  await expect(loadConfig(path)).rejects.toThrow(/forceAfterMinutes/);
});
