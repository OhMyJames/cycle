import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractDigest } from "../scripts/contract.ts";
import { shellOfBuild } from "../src/main/ui-crypto.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "contract-"));
  await mkdir(join(root, "packages/ui/src"), { recursive: true });
  await mkdir(join(root, "apps/desktop/src/main"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ workspaces: { catalog: { "agentclientprotocol-sdk": "2.7.0" } } }),
  );
  await writeFile(join(root, "packages/ui/src/api.ts"), "export type A = { id: string };\n");
  await writeFile(join(root, "apps/desktop/src/main/main.ts"), "export const x = 1;\n");
});
afterEach(() => rm(root, { recursive: true, force: true }));

test("a change inside the main process does not change the contract; a change to the API's types or the SDK does", async () => {
  const before = contractDigest(root);
  await writeFile(join(root, "apps/desktop/src/main/main.ts"), "export const x = 2;\n");
  expect(contractDigest(root)).toBe(before);

  await writeFile(
    join(root, "packages/ui/src/api.ts"),
    "// said again\nexport type A = {  id: string };\n",
  );
  expect(contractDigest(root)).toBe(before);

  await writeFile(join(root, "packages/ui/src/api.ts"), "export type A = { id: number };\n");
  expect(contractDigest(root)).not.toBe(before);

  await writeFile(join(root, "packages/ui/src/api.ts"), "export type A = { id: string };\n");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ workspaces: { catalog: { "agentclientprotocol-sdk": "2.8.0" } } }),
  );
  expect(contractDigest(root)).not.toBe(before);
});

test("the shell of a build is its preload and its recorded contract, and not the main process", async () => {
  const dist = join(root, "dist");
  await mkdir(dist);
  await writeFile(join(dist, "preload.cjs"), "preload");
  await writeFile(join(dist, "contract.txt"), "abc\n");
  await writeFile(join(dist, "main.mjs"), "one");
  const shell = shellOfBuild(dist);
  expect(shell).toMatch(/^[0-9a-f]{32}$/);
  await writeFile(join(dist, "main.mjs"), "two");
  expect(shellOfBuild(dist)).toBe(shell);
  await writeFile(join(dist, "contract.txt"), "abd\n");
  expect(shellOfBuild(dist)).not.toBe(shell);
  await writeFile(join(dist, "contract.txt"), "abc\n");
  await writeFile(join(dist, "preload.cjs"), "preloae");
  expect(shellOfBuild(dist)).not.toBe(shell);
});

test("the real repository's contract is a hash, and the same twice", () => {
  expect(contractDigest()).toMatch(/^[0-9a-f]{64}$/);
  expect(contractDigest()).toBe(contractDigest());
});
