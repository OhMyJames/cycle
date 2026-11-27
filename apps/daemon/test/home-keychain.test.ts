import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHomeKeychain } from "../src/home-keychain.ts";

let home: string;
let calls: string[][];
const run = (args: string[], env: Record<string, string>) => {
  expect(env.HOME).toBe(home);
  calls.push(args);
  return 0;
};
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cv1-kc-"));
  calls = [];
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const keychain = () => join(home, "Library", "Keychains", "login.keychain-db");

test("a made-up HOME gets a keychain at the default path, with an empty password and no auto-lock", () => {
  expect(ensureHomeKeychain(home, { platform: "darwin", run, realHome: "/Users/someone" })).toBe(
    "created",
  );
  expect(calls).toEqual([
    ["create-keychain", "-p", "", keychain()],
    ["set-keychain-settings", keychain()],
  ]);
});

test("one that is there is unlocked, not made again", () => {
  mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
  writeFileSync(keychain(), "");
  expect(ensureHomeKeychain(home, { platform: "darwin", run, realHome: "/Users/someone" })).toBe(
    "unlocked",
  );
  expect(calls).toEqual([["unlock-keychain", "-p", "", keychain()]]);
});

test("the account's real home, a relative path and other systems are left alone", () => {
  expect(ensureHomeKeychain(home, { platform: "darwin", run, realHome: home })).toBe("skipped");
  expect(ensureHomeKeychain("rel/home", { platform: "darwin", run })).toBe("skipped");
  expect(ensureHomeKeychain(home, { platform: "linux", run })).toBe("skipped");
  expect(calls).toEqual([]);
});

test("a security command that fails is reported, not thrown", () => {
  expect(
    ensureHomeKeychain(home, { platform: "darwin", run: () => 1, realHome: "/Users/someone" }),
  ).toBe("failed");
});
