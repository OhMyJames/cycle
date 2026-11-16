import { expect, test } from "bun:test";
import type { HarnessEvent } from "@cycle/protocol";
import {
  ClaudeHarness,
  toAccount,
  toContext,
  toLimit,
  toMcpServers,
  toTurns,
  toUserMessage,
} from "../src/index.ts";
import { FakeSdk, settle } from "./fake-sdk.ts";

function setup() {
  const sdk = new FakeSdk();
  let ids = 0;
  const harness = new ClaudeHarness({
    sdk,
    env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" },
    schedule: () => () => {},
    now: () => 1000,
    newId: () => `id${++ids}`,
    tools: { name: "cycle", url: "http://127.0.0.1:1/mcp", key: "tools-secret" },
  });
  const events: HarnessEvent[] = [];
  harness.onEvent((event) => events.push(event));
  return { sdk, harness, events };
}

const options = { mode: "readOnly" as const, model: "claude-sonnet-5-5" };

async function running(directories?: string[]) {
  const all = setup();
  const session = await all.harness.createSession({
    cwd: "/project",
    model: options.model,
    ...(directories ? { directories } : {}),
  });
  await all.harness.send(session.id, { text: "hello", images: [] }, options);
  await settle();
  return { ...all, session, query: all.sdk.last };
}

test("a process keeps copies of the files it changes, and reaches the session's other folders", async () => {
  const { query } = await running(["/shared"]);
  expect(query.options).toMatchObject({
    enableFileCheckpointing: true,
    additionalDirectories: ["/shared"],
  });
});

test("the files go back through the session's process, as they were when the turn's prompt was sent", async () => {
  const { sdk, harness, session, query } = await running();
  query.say({ type: "result", subtype: "success", is_error: false, duration_ms: 1 });
  await settle();
  sdk.rewound = { canRewind: true, filesChanged: ["/project/a.ts"], insertions: 3, deletions: 1 };
  expect(await harness.rewindFiles(session.id, "id2", true)).toEqual({
    possible: true,
    error: null,
    files: ["/project/a.ts"],
    insertions: 3,
    deletions: 1,
  });
  expect(query.rewinds).toEqual([{ id: "id2", dryRun: true }]);
});

test("commands are the process's own, and its news of them is passed on", async () => {
  const { harness, session, query, events } = await running();
  expect((await harness.listCommands(session.id)).map((command) => command.name)).toEqual([
    "compact",
    "deploy",
  ]);
  expect((await harness.listCommands(null))[1]).toEqual({
    name: "deploy",
    description: "Ship it",
    argumentHint: "<env>",
    aliases: [],
    builtin: false,
  });
  expect((await harness.listSkills()).map((skill) => skill.name)).toEqual(["deploy"]);
  query.say({
    type: "system",
    subtype: "commands_changed",
    commands: [{ name: "found", description: "", argumentHint: "" }],
  });
  await settle();
  expect(events.at(-1)).toMatchObject({ type: "commands.changed", sessionId: session.id });
  expect((await harness.listCommands(session.id)).map((command) => command.name)).toEqual([
    "found",
  ]);
});

test("the account is read from a running process, with the limits its turns told of", async () => {
  const { sdk, harness, query, events } = await running();
  sdk.account = { email: "me@example.test", subscriptionType: "max", tokenSource: "claude.ai" };
  query.say({
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed_warning",
      rateLimitType: "five_hour",
      utilization: 0.81,
      resetsAt: 50,
    },
  });
  await settle();
  expect(events.at(-1)).toEqual({ type: "limits.changed", harness: "claude" });
  expect(await harness.readAccount()).toEqual({
    harness: "claude",
    kind: "subscription",
    email: "me@example.test",
    plan: "max",
    organization: null,
    provider: null,
    source: "claude.ai",
    limits: [
      {
        id: "five_hour",
        name: "5-hour limit",
        usedPercent: 81,
        windowMinutes: 300,
        resetsAt: 50_000,
        status: "warning",
        overage: false,
      },
    ],
  });
});

test("the context is the running process's, and a session with none has no answer", async () => {
  const { sdk, harness, session } = await running();
  sdk.context = {
    categories: [{ id: "messages", name: "Messages", tokens: 1200, kind: "used" }],
    totalTokens: 1200,
    maxTokens: 200_000,
  };
  expect(await harness.readContext(session.id)).toEqual(toContext(sdk.context));
  expect(await harness.readContext("nobody")).toBeNull();
});

test("MCP servers are read without their secrets, and Cycle's own is left out", async () => {
  const servers = toMcpServers(
    [
      { name: "cycle", status: "connected", config: { type: "http", url: "http://127.0.0.1:1" } },
      {
        name: "local",
        status: "connected",
        config: { command: "srv", args: ["-v"], env: { API_TOKEN: "s3cret" } },
        tools: [{ name: "look", description: "Looks" }],
      },
      { name: "remote", status: "needs-auth", config: { type: "http", url: "https://x.test" } },
    ],
    "cycle",
  );
  expect(servers.map((server) => [server.name, server.status, server.auth])).toEqual([
    ["local", "connected", "none"],
    ["remote", "needsAuth", "signedOut"],
  ]);
  expect(servers[0]?.transport).toEqual({
    kind: "stdio",
    command: "srv",
    args: ["-v"],
    env: ["API_TOKEN"],
  });
  expect(JSON.stringify(servers)).not.toContain("s3cret");
});

test("an account says how it is signed in, by name alone", () => {
  expect(toAccount(null, []).kind).toBeNull();
  expect(toAccount({ apiKeySource: "ANTHROPIC_API_KEY" }, [])).toMatchObject({
    kind: "apiKey",
    source: "ANTHROPIC_API_KEY",
  });
  expect(toAccount({ apiProvider: "bedrock" }, [])).toMatchObject({
    kind: "cloud",
    provider: "bedrock",
  });
  expect(
    toLimit({ status: "rejected", rateLimitType: "seven_day", isUsingOverage: true }),
  ).toMatchObject({
    name: "Weekly limit",
    usedPercent: null,
    status: "exceeded",
    overage: true,
  });
});

test("documents go with a prompt, and come back by name from the history", () => {
  const sent = toUserMessage(
    {
      text: "read these",
      images: [],
      documents: [
        { kind: "pdf", name: "a.pdf", data: "data:application/pdf;base64,JVBERg==" },
        { kind: "text", name: "b.txt", data: "data:text/plain;base64,aGVsbG8=" },
      ],
    },
    "u1",
    "s1",
  );
  expect(sent.message.content).toEqual([
    {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBERg==" },
      title: "a.pdf",
    },
    {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: "hello" },
      title: "b.txt",
    },
    { type: "text", text: "read these" },
  ]);
  const [turn] = toTurns([{ type: "user", uuid: "u1", message: sent.message }], "/p");
  expect(turn?.items[0]).toMatchObject({
    kind: "userMessage",
    documents: [
      { kind: "pdf", name: "a.pdf" },
      { kind: "text", name: "b.txt" },
    ],
  });
});
