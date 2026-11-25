import { describe, expect, test } from "bun:test";
import type { AgentContext } from "@agentclientprotocol/sdk/experimental/v2";
import { approval } from "../src/approval.ts";
import { commandPrefixes } from "../src/prefixes.ts";

type Option = { optionId: string; kind: string };

/** A client that answers every permission request with `answer` and records the options it was shown. */
const clientOf = (answer: string) => {
  const seen: Option[][] = [];
  const ctx = {
    request: async (_m: unknown, params: { options: Option[] }) => {
      seen.push(params.options);
      return { outcome: { outcome: "selected", optionId: answer } };
    },
  } as unknown as AgentContext;
  return { ctx, seen };
};

const CMD = "item/commandExecution/requestApproval";
const ask = (
  ctx: AgentContext,
  command: string,
  remembered: Set<string>,
  threadId = "t1",
  isChild: (id: string) => boolean = () => false,
) =>
  approval(
    CMD,
    { threadId, turnId: "u1", itemId: "i", command, reason: null },
    ctx,
    "t1",
    "u1",
    new AbortController().signal,
    isChild,
    remembered,
  );

describe("commandPrefixes", () => {
  test("one prefix per segment of a chain", () => {
    expect(commandPrefixes("git status")).toEqual(["git status"]);
    expect(commandPrefixes("ls -la")).toEqual(["ls -la"]);
    expect(commandPrefixes("git -C repo status")).toEqual(["git -C repo"]);
    expect(commandPrefixes("cd src && git diff | grep foo")).toEqual([
      "cd src",
      "git diff",
      "grep foo",
    ]);
  });
  test("what cannot be judged by segments is not remembered", () => {
    for (const c of [
      "echo $(rm -rf x)",
      "echo `id`",
      "echo hi > out.txt",
      "sudo ls",
      "bash -c 'ls'",
      "FOO=1 ls",
      "ls\nrm x",
      "ls & rm -rf ~",
      "(ls)",
      "! ls",
      "python -c 'x'",
      "find . -exec rm {} +",
    ]) {
      expect(commandPrefixes(c)).toBeUndefined();
    }
  });
});

describe("command approval options", () => {
  test("a judgeable command offers allow_always", async () => {
    const { ctx, seen } = clientOf("allow");
    await ask(ctx, "git status", new Set());
    expect(seen[0]?.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
  });
  test("dangerous commands do not", async () => {
    for (const c of ["rm -rf x", "sudo ls", "echo $(id)", "echo hi > out.txt"]) {
      const { ctx, seen } = clientOf("allow");
      await ask(ctx, c, new Set());
      expect(seen[0]?.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
    }
  });
  test("file changes and permissions keep two options and decline", async () => {
    for (const method of ["item/fileChange/requestApproval", "item/permissions/requestApproval"]) {
      const { ctx, seen } = clientOf("deny");
      const out = await approval(
        method,
        { threadId: "t1", turnId: "u1", itemId: "i", permissions: {}, reason: null },
        ctx,
        "t1",
        "u1",
        new AbortController().signal,
      );
      expect(seen[0]?.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
      if (method.includes("fileChange")) expect(out).toEqual({ decision: "decline" });
      else expect(out).toEqual({ permissions: {}, scope: "turn" });
    }
  });
});

describe("always allow in this session", () => {
  test("remembered prefix is answered without asking", async () => {
    const remembered = new Set<string>();
    const first = clientOf("allow_always");
    expect(await ask(first.ctx, "git status", remembered)).toEqual({ decision: "accept" });
    const next = clientOf("deny");
    expect(await ask(next.ctx, "git status", remembered)).toEqual({ decision: "accept" });
    expect(next.seen).toHaveLength(0);
  });
  test("a chain with an unremembered segment still asks; allow once remembers nothing", async () => {
    const remembered = new Set<string>();
    await ask(clientOf("allow_always").ctx, "git status", remembered);
    const c = clientOf("allow");
    expect(await ask(c.ctx, "git status && git push", remembered)).toEqual({ decision: "accept" });
    expect(c.seen).toHaveLength(1);
    expect([...remembered]).toEqual(["git status"]);
    const d = clientOf("deny");
    expect(await ask(d.ctx, "git push", remembered)).toEqual({ decision: "decline" });
    expect(d.seen).toHaveLength(1);
  });
  test("another session does not share it; a sub-agent thread uses its parent's", async () => {
    const parent = new Set<string>();
    await ask(clientOf("allow_always").ctx, "git status", parent);
    const other = clientOf("deny");
    expect(await ask(other.ctx, "git status", new Set())).toEqual({ decision: "decline" });
    expect(other.seen).toHaveLength(1);
    const kid = clientOf("deny");
    expect(await ask(kid.ctx, "git status", parent, "kid", (id) => id === "kid")).toEqual({
      decision: "accept",
    });
    expect(kid.seen).toHaveLength(0);
  });
});
