import { expect, test } from "bun:test";
import {
  ACP_ERROR_CODES,
  agentsList,
  CycleErrorCode,
  checkPrompt,
  describePromptProblem,
  META,
  NOTIFICATIONS,
  normalizePrompt,
  PROMPT_LIMITS,
  seqOf,
  ToolResultSchema,
  tsOf,
} from "../src/index.ts";

test("Cycle's error codes do not collide with ACP's or each other", () => {
  const codes = Object.values(CycleErrorCode);
  expect(new Set(codes).size).toBe(codes.length);
  for (const code of codes) expect(ACP_ERROR_CODES).not.toContain(code);
});

test("every Cycle method and notification is under _cycle/", () => {
  expect(agentsList.name.startsWith("_cycle/")).toBe(true);
  for (const name of Object.values(NOTIFICATIONS)) expect(name.startsWith("_cycle/")).toBe(true);
});

test("reads a seq off _meta, and only a positive integer", () => {
  expect(seqOf({ [META.seq]: 12 })).toBe(12);
  expect(seqOf({ [META.seq]: 0 })).toBeUndefined();
  expect(seqOf({ [META.seq]: "12" })).toBeUndefined();
  expect(seqOf(null)).toBeUndefined();
  expect(seqOf({})).toBeUndefined();
});

test("reads a record's time off _meta as milliseconds, and nothing else as one", () => {
  expect(tsOf({ [META.ts]: "2026-11-18T04:00:00.000Z" })).toBe(Date.UTC(2026, 10, 18, 4));
  expect(tsOf({ [META.ts]: 1_763_438_400_000 })).toBeUndefined();
  expect(tsOf({ [META.ts]: "yesterday" })).toBeUndefined();
  expect(tsOf({ [META.ts]: "" })).toBeUndefined();
  expect(tsOf(null)).toBeUndefined();
  expect(tsOf({})).toBeUndefined();
});

const png = (bytes: number) => ({
  type: "image",
  mimeType: "image/png",
  data: Buffer.alloc(bytes).toString("base64"),
});
const both = { image: {}, embeddedContext: {} };

test("a prompt of text and links is always fine; images and resources need the agent's say", () => {
  const text = [
    { type: "text", text: "hi" },
    { type: "resource_link", name: "a", uri: "file:///a" },
  ];
  expect(checkPrompt(text, undefined)).toBeUndefined();
  expect(checkPrompt([png(10)], undefined)).toEqual({ reason: "unsupported_block", index: 0 });
  expect(checkPrompt([png(10)], both)).toBeUndefined();
  const resource = { type: "resource", resource: { uri: "file:///a", text: "x" } };
  expect(checkPrompt([resource], { image: {} })).toEqual({ reason: "unsupported_block", index: 0 });
  expect(checkPrompt([resource], both)).toBeUndefined();
});

test("a prompt is refused whole, with the index of the block that is wrong", () => {
  expect(checkPrompt([], both)).toEqual({ reason: "empty" });
  expect(checkPrompt([{ type: "audio", data: "", mimeType: "audio/wav" }], both)).toEqual({
    reason: "unsupported_block",
    index: 0,
  });
  expect(
    checkPrompt(
      [
        { type: "text", text: "a" },
        { ...png(4), mimeType: "image/bmp" },
      ],
      both,
    ),
  ).toEqual({
    reason: "unsupported_media_type",
    index: 1,
  });
  expect(checkPrompt([{ ...png(4), data: "not base64!" }], both)).toEqual({
    reason: "invalid_base64",
    index: 0,
  });
  const pdf = (mimeType: string) => ({
    type: "resource",
    resource: { uri: "file:///a", mimeType, blob: Buffer.from("x").toString("base64") },
  });
  expect(checkPrompt([pdf("application/pdf")], both)).toBeUndefined();
  expect(checkPrompt([pdf("application/zip")], both)).toEqual({
    reason: "unsupported_media_type",
    index: 0,
  });
});

test("the limits are on decoded bytes: one block, the whole prompt, the block count", () => {
  expect(checkPrompt([png(PROMPT_LIMITS.blockBytes)], both)).toBeUndefined();
  expect(checkPrompt([png(PROMPT_LIMITS.blockBytes + 1)], both)).toEqual({
    reason: "block_too_large",
    index: 0,
  });
  const three = [png(5 * 1024 * 1024), png(5 * 1024 * 1024), png(3 * 1024 * 1024)];
  expect(checkPrompt(three, both)).toEqual({ reason: "prompt_too_large", index: 2 });
  const many = Array.from({ length: PROMPT_LIMITS.blocks + 1 }, () => ({
    type: "text",
    text: "a",
  }));
  expect(checkPrompt(many, both)).toEqual({ reason: "too_many_blocks" });
});

test("text counts against the limits too, in bytes and not in characters", () => {
  const text = (size: number) => ({ type: "text", text: "a".repeat(size) });
  expect(checkPrompt([text(PROMPT_LIMITS.blockBytes)], undefined)).toBeUndefined();
  expect(checkPrompt([text(PROMPT_LIMITS.blockBytes + 1)], undefined)).toEqual({
    reason: "block_too_large",
    index: 0,
  });
  // Three characters, nine bytes.
  expect(
    checkPrompt(
      [{ type: "text", text: "日本語".repeat(PROMPT_LIMITS.blockBytes / 9 + 1) }],
      undefined,
    ),
  ).toEqual({
    reason: "block_too_large",
    index: 0,
  });
  const many = [text(5 * 1024 * 1024), text(5 * 1024 * 1024), text(3 * 1024 * 1024)];
  expect(checkPrompt(many, undefined)).toEqual({ reason: "prompt_too_large", index: 2 });
});

test("a block missing what it must have is malformed, not a block of no bytes", () => {
  expect(checkPrompt([{ type: "text" }], undefined)).toEqual({
    reason: "malformed_block",
    index: 0,
  });
  expect(checkPrompt([{ type: "resource_link", name: "a" }], undefined)).toEqual({
    reason: "malformed_block",
    index: 0,
  });
  expect(checkPrompt([{ type: "resource", resource: { text: "x" } }], both)).toEqual({
    reason: "malformed_block",
    index: 0,
  });
  expect(checkPrompt([{ type: "image", mimeType: "image/png", data: "" }], both)).toEqual({
    reason: "invalid_base64",
    index: 0,
  });
});

test("a link counts by the size of its name and uri, so it cannot carry what the limit is for", () => {
  const big = "x".repeat(PROMPT_LIMITS.blockBytes + 1);
  expect(checkPrompt([{ type: "resource_link", name: "a", uri: big }], undefined)).toEqual({
    reason: "block_too_large",
    index: 0,
  });
});

test("a tool call's result is counts and flags only", () => {
  for (const ok of [
    { edit: { additions: 2, deletions: 1 } },
    { edit: { additions: 0, deletions: 0, created: true, staged: true } },
    { read: { startLine: 20, numLines: 40, totalLines: 212 } },
    { search: { files: 3, matches: 5, more: true } },
  ]) {
    expect(ToolResultSchema.safeParse(ok).success).toBe(true);
  }
  for (const bad of [{ edit: { additions: -1, deletions: 0 } }, { search: { files: "3" } }, {}]) {
    expect(ToolResultSchema.safeParse(bad).success).toBe(false);
  }
});

test("a command's result says only how it ended", () => {
  expect(ToolResultSchema.safeParse({ run: {} }).success).toBe(true);
  expect(
    ToolResultSchema.safeParse({ run: { timedOutMs: 120000, background: true } }).success,
  ).toBe(true);
  expect(ToolResultSchema.safeParse({ run: { interrupted: false } }).success).toBe(false);
});

test("a page fetched says only its status and size", () => {
  expect(ToolResultSchema.safeParse({ fetch: { status: 200, bytes: 10 } }).success).toBe(true);
  expect(ToolResultSchema.safeParse({ fetch: { status: 99 } }).success).toBe(false);
});

test("a prompt is read into one typed block for each thing it carries, and refused as checkPrompt refuses it", () => {
  const capable = { image: {}, embeddedContext: {} };
  const prompt = [
    { type: "text", text: "look" },
    { type: "resource_link", name: "a.ts", uri: "file:///w/a.ts" },
    { type: "image", mimeType: "image/png", data: "AAAA" },
    { type: "resource", resource: { uri: "file:///w/b.md", text: "# b" } },
    {
      type: "resource",
      resource: { uri: "file:///w/c.pdf", mimeType: "application/pdf", blob: "AAAA" },
    },
  ];
  expect(normalizePrompt(prompt, capable)).toEqual({
    ok: true,
    blocks: [
      { type: "text", text: "look" },
      { type: "link", name: "a.ts", uri: "file:///w/a.ts" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "file", uri: "file:///w/b.md", text: "# b" },
      { type: "pdf", uri: "file:///w/c.pdf", data: "AAAA" },
    ],
  });
  for (const [blocks, capabilities] of [
    [[], capable],
    [[{ type: "image", mimeType: "image/png", data: "AAAA" }], {}],
    [[{ type: "audio", data: "AAAA", mimeType: "audio/wav" }], capable],
    [[{ type: "text" }], capable],
  ] as const) {
    const normalized = normalizePrompt(blocks, capabilities);
    expect(normalized.ok).toBe(false);
    if (!normalized.ok) {
      expect(checkPrompt(blocks, capabilities)).toEqual(normalized.problem);
      expect(describePromptProblem(normalized.problem).length).toBeGreaterThan(0);
    }
  }
});

test("an adapter reads a prompt without the sizes the daemon holds it to, and an agent may take no PDF", () => {
  const capable = { image: {}, embeddedContext: {} };
  const large = [{ type: "text", text: "x".repeat(PROMPT_LIMITS.promptBytes + 1) }];
  expect(normalizePrompt(large, capable).ok).toBe(false);
  expect(normalizePrompt(large, capable, { limits: false }).ok).toBe(true);
  const pdf = [
    { type: "text", text: "x".repeat(PROMPT_LIMITS.blockBytes + 1) },
    {
      type: "resource",
      resource: { uri: "file:///c.pdf", mimeType: "application/pdf", blob: "AAAA" },
    },
  ];
  // In the order of the blocks, and only the PDF once sizes are not this one's to hold.
  expect(normalizePrompt(pdf, capable, { pdf: false })).toEqual({
    ok: false,
    problem: { reason: "block_too_large", index: 0 },
  });
  expect(normalizePrompt(pdf, capable, { limits: false, pdf: false })).toEqual({
    ok: false,
    problem: { reason: "unsupported_media_type", index: 1 },
  });
});
