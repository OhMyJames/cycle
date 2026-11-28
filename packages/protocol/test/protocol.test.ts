import { expect, test } from "bun:test";
import {
  ACP_ERROR_CODES,
  agentsList,
  CapabilitiesSchema,
  CycleErrorCode,
  checkPrompt,
  DaemonUpdateStateSchema,
  describePromptProblem,
  LoopCardSchema,
  LoopGraphActionSchema,
  LoopGraphActParamsSchema,
  LoopGraphActResultSchema,
  LoopRunDetailSchema,
  LoopTicketDetailSchema,
  META,
  NOTIFICATIONS,
  normalizePrompt,
  PROMPT_LIMITS,
  QUEUE_UPDATE,
  QueueUpdateSchema,
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

test("a command's result may carry how long it ran, and old results without it still pass", () => {
  expect(ToolResultSchema.safeParse({ run: { durationMs: 12000 } }).success).toBe(true);
  expect(ToolResultSchema.safeParse({ run: { exitCode: 1, durationMs: 0 } }).success).toBe(true);
  expect(ToolResultSchema.safeParse({ run: { exitCode: 1 } }).success).toBe(true);
  for (const bad of [-1, 1.5, "12"]) {
    expect(ToolResultSchema.safeParse({ run: { durationMs: bad } }).success).toBe(false);
  }
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

test("LoopCardSchema takes a parent object, null, or none", () => {
  const card = {
    key: "CYC-2",
    title: "t",
    type: null,
    priority: null,
    labels: [],
    pendingReason: null,
    phase: null,
  };
  expect(
    LoopCardSchema.safeParse({ ...card, parent: { key: "CYC-1", title: "Epic" } }).success,
  ).toBe(true);
  expect(LoopCardSchema.safeParse({ ...card, parent: null }).success).toBe(true);
  expect(LoopCardSchema.safeParse(card).success).toBe(true);
  expect(LoopCardSchema.safeParse({ ...card, parent: { key: "", title: "x" } }).success).toBe(
    false,
  );
});

const graphNode = {
  id: "n1",
  position: 0,
  origin: "planned",
  title: "Add tables",
  goal: "Create them",
  dependsOn: [],
  filesHint: [],
  verify: ["bun run check"],
  status: "failed",
  sessionId: null,
  commitSha: null,
  rounds: 1,
  lastError: "boom",
  summary: null,
  startedAt: null,
  finishedAt: null,
};
const graph = {
  runKey: "CYC-2",
  source: "auto_plan",
  revision: 1,
  currentNodeId: "n1",
  nodes: [graphNode],
  createdAt: "2026-11-26T08:00:00.000Z",
  updatedAt: "2026-11-26T08:00:00.000Z",
};

test("a card takes an optional graph summary; detail types take a full graph", () => {
  const card = {
    key: "CYC-2",
    title: "t",
    type: null,
    priority: null,
    labels: [],
    pendingReason: null,
    phase: null,
  };
  const summary = {
    source: "auto_plan",
    total: 3,
    passed: 1,
    failed: 1,
    blocked: 0,
    running: 0,
    currentNodeId: "n2",
    currentNodeTitle: "Wire UI",
  };
  expect(LoopCardSchema.safeParse(card).success).toBe(true);
  expect(LoopCardSchema.safeParse({ ...card, graph: summary }).success).toBe(true);
  expect(LoopCardSchema.safeParse({ ...card, graph: { ...summary, total: "3" } }).success).toBe(
    false,
  );
  const ticket = {
    identifier: "CYC-2",
    title: "t",
    priority: null,
    column: "Doing",
    actions: [],
    chat: "none",
    body: "",
    acceptance: [],
    links: [],
  };
  expect(LoopTicketDetailSchema.safeParse(ticket).success).toBe(true);
  expect(LoopTicketDetailSchema.safeParse({ ...ticket, graph }).success).toBe(true);
  const run = {
    key: "CYC-2",
    title: "t",
    kind: "dev",
    phase: "dev",
    state: "active",
    round: 0,
    startedAt: "a",
    updatedAt: "b",
    blockedReason: null,
    sessions: [],
    prUrl: null,
    events: [],
    heartbeat: null,
  };
  expect(LoopRunDetailSchema.safeParse({ ...run, graph }).success).toBe(true);
  expect(LoopRunDetailSchema.safeParse({ ...run, graph: { ...graph, nodes: [] } }).success).toBe(
    false,
  );
});

test("loop/graph/act takes the three actions and refuses an unknown one", () => {
  const base = { project: "CYC", key: "CYC-2", nodeId: "n1", actor: "me", actorKind: "desktop" };
  for (const action of ["retry_node", "skip_node"])
    expect(LoopGraphActParamsSchema.safeParse({ ...base, action }).success).toBe(true);
  expect(
    LoopGraphActParamsSchema.safeParse({ ...base, action: "edit_node", goal: "new" }).success,
  ).toBe(true);
  expect(
    LoopGraphActParamsSchema.safeParse({
      ...base,
      action: "edit_node",
      title: "t",
      goal: "g",
      verify: ["bun run check"],
    }).success,
  ).toBe(true);
  // An edit with nothing to change, and edit fields on another action, are refused.
  expect(LoopGraphActParamsSchema.safeParse({ ...base, action: "edit_node" }).success).toBe(false);
  expect(
    LoopGraphActParamsSchema.safeParse({ ...base, action: "retry_node", title: "t" }).success,
  ).toBe(false);
  expect(LoopGraphActParamsSchema.safeParse({ ...base, action: "delete_node" }).success).toBe(
    false,
  );
  expect(LoopGraphActionSchema.options).toEqual(["retry_node", "skip_node", "edit_node"]);
  expect(
    LoopGraphActResultSchema.safeParse({
      key: "CYC-2",
      nodeId: "n1",
      action: "retry_node",
      phase: "graph_plan",
      graph,
    }).success,
  ).toBe(true);
});

test("the update state reads with and without the drain fields", () => {
  const old = { version: "0.3.1", updates: "on" as const, pending: { version: "0.3.2" } };
  expect(DaemonUpdateStateSchema.parse(old)).toEqual(old);
  const draining = {
    ...old,
    pending: {
      version: "0.3.2",
      state: "draining" as const,
      since: "2026-11-28T01:00:00.000Z",
      forceAt: "2026-11-28T01:15:00.000Z",
    },
  };
  expect(DaemonUpdateStateSchema.parse(draining)).toEqual(draining);
  expect(
    DaemonUpdateStateSchema.safeParse({ ...old, pending: { version: "x", state: "nope" } }).success,
  ).toBe(false);
  expect(NOTIFICATIONS.daemonUpdate).toBe("_cycle/daemon/update");
  expect(META.updateNotify).toBe("cycle/updateNotify");
});

test("a queue snapshot's hold is optional and only 'update'", () => {
  const entries = [{ queueId: "q1", prompt: [] }];
  expect(QueueUpdateSchema.parse({ sessionUpdate: QUEUE_UPDATE, entries }).hold).toBeUndefined();
  expect(
    QueueUpdateSchema.parse({ sessionUpdate: QUEUE_UPDATE, entries, hold: "update" }).hold,
  ).toBe("update");
  expect(
    QueueUpdateSchema.safeParse({ sessionUpdate: QUEUE_UPDATE, entries, hold: "other" }).success,
  ).toBe(false);
});

test("capabilities carry selfUpdateDrain, and an old daemon's omit it", () => {
  const shape = CapabilitiesSchema.shape;
  expect(shape.selfUpdateDrain.parse(true)).toBe(true);
  expect(shape.selfUpdateDrain.parse(undefined)).toBeUndefined();
});
