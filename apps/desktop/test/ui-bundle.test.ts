import { expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { sha256Hex, shellHash, verifySignature } from "../src/main/ui-crypto.ts";
import { contractText, parseManifest } from "../src/shared/ui-bundle.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const H = "a".repeat(64);
const good = {
  v: 1,
  shell: "0".repeat(32),
  uiVersion: 12,
  keyId: "k1",
  file: "ui-x-12.zip",
  size: 100,
  sha256: H,
  files: { "index.html": H, "chunks/a.js": H },
};
const parse = (patch: Record<string, unknown>) =>
  parseManifest(JSON.stringify({ ...good, ...patch }));

test("the shell's hash is 32 hex digits, stable, and changes with the preload, the contract or the revision", () => {
  const h = shellHash(bytes("preload"), "contract", 1);
  expect(h).toMatch(/^[0-9a-f]{32}$/);
  expect(shellHash(bytes("preload"), "contract", 1)).toBe(h);
  expect(shellHash(bytes("preloae"), "contract", 1)).not.toBe(h);
  expect(shellHash(bytes("preload"), "contracu", 1)).not.toBe(h);
  expect(shellHash(bytes("preload"), "contract", 2)).not.toBe(h);
});

test("moving the boundary between the parts changes the hash", () => {
  expect(shellHash(bytes("ab"), "c", 1)).not.toBe(shellHash(bytes("a"), "bc", 1));
  expect(shellHash(bytes("a"), "b1", 1)).not.toBe(shellHash(bytes("a"), "b", 11));
});

test("the contract does not change with comments or layout, and does with a type, a method or the SDK", () => {
  const api = `export type A = { id: string }; // the id\nexport type M = "a" | "b";\n`;
  const t = contractText(api, "2.7.0");
  expect(contractText(`/* header */\n${api.replace("; //", ";\n\n  //")}`, "2.7.0")).toBe(t);
  expect(contractText(api.replace("id: string", "id: number"), "2.7.0")).not.toBe(t);
  expect(contractText(api.replace('"b"', '"b" | "c"'), "2.7.0")).not.toBe(t);
  expect(contractText(api, "2.8.0")).not.toBe(t);
  // What is inside a string is part of the contract, comment marks or not.
  expect(contractText('const u = "http://x"; // c', "1")).toContain('"http://x"');
});

test("a good manifest is taken as it is", () => {
  expect(parse({})).toEqual(good as never);
});

test("a manifest that is not exactly what the app makes is refused", () => {
  const bad: Record<string, unknown>[] = [
    { v: 2 },
    { shell: "xyz" },
    { shell: "0".repeat(31) },
    { uiVersion: -1 },
    { uiVersion: 1.5 },
    { keyId: "" },
    { keyId: "a b" },
    { file: "../x.zip" },
    { file: "a/b.zip" },
    { file: "a\\b.zip" },
    { file: "" },
    { size: 0 },
    { size: 1e12 },
    { sha256: "ABC" },
    { files: {} },
    { files: [] },
    { files: { "chunks/a.js": H } },
    { files: { "index.html": H, "../x": H } },
    { files: { "index.html": H, "/etc/passwd": H } },
    { files: { "index.html": H, "a//b": H } },
    { files: { "index.html": H, "a/./b": H } },
    { files: { "index.html": H, "a\\b": H } },
    { files: { "index.html": "nothex" } },
  ];
  for (const patch of bad) expect(parse(patch)).toBeUndefined();
  for (const field of Object.keys(good)) {
    const { [field as keyof typeof good]: _, ...rest } = good;
    expect(parseManifest(JSON.stringify(rest))).toBeUndefined();
  }
  expect(parseManifest("not json")).toBeUndefined();
  expect(parseManifest("[]")).toBeUndefined();
  expect(parseManifest("null")).toBeUndefined();
});

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    spki: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    sign: (data: Uint8Array) => sign(null, data, privateKey).toString("base64"),
  };
};

test("a signature holds for the key it names and for the same bytes only", () => {
  const k = pair();
  const data = bytes(JSON.stringify(good));
  const sig = k.sign(data);
  expect(verifySignature(data, sig, "k1", { k1: k.spki })).toBe(true);
  expect(verifySignature(data, `${sig}\n`, "k1", { k1: k.spki })).toBe(true);
  const changed = bytes(JSON.stringify({ ...good, uiVersion: 13 }));
  expect(verifySignature(changed, sig, "k1", { k1: k.spki })).toBe(false);
});

test("a signature by another key, an unknown key id, no keys, or garbage does not hold", () => {
  const k = pair();
  const other = pair();
  const data = bytes("x");
  const sig = k.sign(data);
  expect(verifySignature(data, sig, "k1", { k1: other.spki })).toBe(false);
  expect(verifySignature(data, sig, "k2", { k1: k.spki })).toBe(false);
  expect(verifySignature(data, sig, "k1", {})).toBe(false);
  expect(verifySignature(data, "", "k1", { k1: k.spki })).toBe(false);
  expect(verifySignature(data, "AAAA", "k1", { k1: k.spki })).toBe(false);
  expect(verifySignature(data, sig, "k1", { k1: "not a key" })).toBe(false);
  expect(verifySignature(data, sig, "__proto__", { k1: k.spki })).toBe(false);
});

test("sha256Hex is the usual hash", () => {
  expect(sha256Hex(bytes("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
