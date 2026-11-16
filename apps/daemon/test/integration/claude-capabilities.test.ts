/**
 * What a Claude session can do that a codex one cannot, end to end: the real Claude Code, driven by
 * the Claude Agent SDK against a scripted model, beside the real `codex app-server`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeHarness } from "@cycle/harness-claude";
import { CodexHarness } from "@cycle/harness-codex";
import type { Item, SessionEvent } from "@cycle/protocol";
import {
  type Daemon,
  Harnesses,
  type OpenProviders,
  diskFile,
  openProviders,
  startDaemon,
} from "../../src/index.ts";
import { type ClaudeReply, type MockClaude, startMockClaude } from "./mock-claude.ts";
import { type MockModel, startMockModel } from "./mock-model.ts";
import { type WireClient, connect } from "./wire-client.ts";

const SONNET = "claude-sonnet-5-5";
/** The smallest PDF a reader takes: one empty page. */
const PDF = [
  "%PDF-1.4",
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 3 3]>>endobj",
  "trailer<</Root 1 0 R>>",
  "%%EOF",
].join("\n");

let daemon: Daemon;
let codexModel: MockModel;
let claude: MockClaude;
let providers: OpenProviders;
let root: string;
let project: string;
let client: WireClient;
let script: (prompt: string, results: number) => ClaudeReply;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cycle-claude-caps-"));
  project = join(root, "project");
  mkdirSync(join(project, ".claude", "commands"), { recursive: true });
  mkdirSync(join(root, "codex"));
  writeFileSync(join(project, "notes.txt"), "one\n");
  writeFileSync(
    join(project, ".claude", "commands", "greet.md"),
    "---\ndescription: Greets someone\nargument-hint: <name>\n---\nSay hello to $ARGUMENTS.\n",
  );
  script = (prompt) => ({ text: ["You said: ", prompt] });
  codexModel = startMockModel(() => ({ text: ["Hello from codex"] }));
  claude = startMockClaude(root, (prompt, results) => script(prompt, results));
  providers = await openProviders(
    diskFile(join(root, "home", "providers.json")),
    "gateway-token",
    join(root, "home", "provider-models.json"),
  );
  daemon = await startDaemon({
    providers: providers.store,
    harness: new Harnesses(
      new CodexHarness({
        config: codexModel.codexConfig,
        env: { CODEX_HOME: join(root, "codex") },
      }),
      [new ClaudeHarness({ env: claude.env })],
    ),
    home: join(root, "home"),
  });
  client = connect(daemon.url);
  await client.opened;
});

afterAll(async () => {
  client?.close();
  await daemon?.stop();
  providers?.stop();
  codexModel?.stop();
  claude?.stop();
  rmSync(root, { recursive: true, force: true });
});

const of = (sessionId: string) => client.events().filter((event) => event.sessionId === sessionId);
const ended = (sessionId: string) =>
  of(sessionId).filter((event) => event.type === "turn.completed");
const items = (events: SessionEvent[]): Item[] =>
  events.flatMap((event) => (event.type === "item.completed" ? [event.item] : []));

async function start() {
  const session = await client.call("session.create", {
    cwd: project,
    model: SONNET,
    mode: "default",
  });
  await client.call("session.open", { sessionId: session.id });
  return session;
}

/** Sends a prompt, says yes to what it asks, and waits for the turn to end. */
async function turn(
  sessionId: string,
  params: { text: string; documents?: { kind: "pdf"; name: string; data: string }[] },
): Promise<SessionEvent[]> {
  const before = of(sessionId).length;
  const turns = ended(sessionId).length;
  const answered = new Set<string>();
  const asked = () =>
    of(sessionId).find(
      (event) => event.type === "approval.requested" && !answered.has(event.approval.id),
    );
  await client.call("session.send", { sessionId, ...params });
  for (;;) {
    await client.until(() => ended(sessionId).length > turns || asked() !== undefined);
    if (ended(sessionId).length > turns) break;
    const ask = asked();
    if (ask?.type !== "approval.requested") continue;
    answered.add(ask.approval.id);
    await client.call("approval.respond", {
      sessionId,
      approvalId: ask.approval.id,
      response: { decision: "accept" },
    });
  }
  return of(sessionId).slice(before);
}

test("each agent says what it can do, and has its own account, read without a secret", async () => {
  const info = await client.call("daemon.info", {});
  expect(info.harnesses.map((each) => [each.name, each.capabilities.connector])).toEqual([
    ["codex", "edit"],
    ["claude", "read"],
  ]);
  const account = await client.call("account.read", { harness: "claude" });
  expect(account).toMatchObject({ harness: "claude", kind: "apiKey", source: "ANTHROPIC_API_KEY" });
  expect(JSON.stringify(account)).not.toContain("sk-ant-mock");
  expect((await client.call("account.read", {})).harness).toBe("codex");
  await expect(client.call("account.login", { harness: "claude" })).rejects.toThrow(
    "not supported",
  );
  await expect(client.call("mcp.remove", { name: "anything", harness: "claude" })).rejects.toThrow(
    "not supported",
  );
  expect((await client.call("mcp.list", { harness: "claude" })).servers).toEqual([]);
});

test("a Claude session lists its commands, its project's own among them", async () => {
  const session = await start();
  await turn(session.id, { text: "hello" });
  const { commands } = await client.call("commands.list", { sessionId: session.id });
  expect(commands.find((command) => command.name === "greet")).toMatchObject({
    description: expect.stringContaining("Greets someone"),
    argumentHint: "<name>",
    builtin: false,
  });
  expect(commands.some((command) => command.builtin)).toBe(true);
  // A new session in the folder has its project's commands; one elsewhere does not.
  const here = await client.call("commands.list", { harness: "claude", cwd: project });
  expect(here.commands.some((command) => command.name === "greet")).toBe(true);
  const elsewhere = await client.call("commands.list", { harness: "claude", cwd: root });
  expect(elsewhere.commands.length).toBeGreaterThan(0);
  expect(elsewhere.commands.some((command) => command.name === "greet")).toBe(false);
  await expect(client.call("commands.list", { harness: "codex", cwd: project })).rejects.toThrow(
    "not supported",
  );
});

test("a Claude session's context comes in parts", async () => {
  const session = await start();
  await turn(session.id, { text: "fill the context" });
  const { context } = await client.call("session.context", { sessionId: session.id });
  expect(context?.tokens).toBeGreaterThan(0);
  expect(context?.window).toBeGreaterThan(0);
  expect(context?.parts.map((part) => part.id)).toContain("system_prompt");
});

test("a prompt carries a PDF to the model, and the conversation shows it by name", async () => {
  const session = await start();
  const data = `data:application/pdf;base64,${Buffer.from(PDF).toString("base64")}`;
  const events = await turn(session.id, {
    text: "read the attached",
    documents: [{ kind: "pdf", name: "plan.pdf", data }],
  });
  expect(items(events)[0]).toMatchObject({
    kind: "userMessage",
    documents: [{ kind: "pdf", name: "plan.pdf" }],
  });
  const sent = JSON.stringify(claude.requests.at(-1));
  expect(sent).toContain('"type":"document"');
  expect(sent).toContain(Buffer.from(PDF).toString("base64"));
});

test("going back with the files puts back what the agent changed", async () => {
  const session = await start();
  const path = join(project, "notes.txt");
  const edit = { file_path: path, old_string: "one", new_string: "two" };
  script = (_prompt, results) =>
    results ? { text: ["edited"] } : { call: { name: "Edit", input: edit } };
  const events = await turn(session.id, { text: "change the notes" });
  script = (prompt) => ({ text: ["You said: ", prompt] });
  expect(readFileSync(path, "utf8")).toBe("two\n");
  const started = events.find((event) => event.type === "turn.started");
  const turnId = started?.type === "turn.started" ? started.turnId : "";

  const preview = await client.call("session.rewind.preview", { sessionId: session.id, turnId });
  expect(preview).toMatchObject({ possible: true, files: [path] });
  expect(readFileSync(path, "utf8")).toBe("two\n");
  await client.call("session.rewind", { sessionId: session.id, turnId, files: true });
  expect(readFileSync(path, "utf8")).toBe("one\n");
  expect(of(session.id).at(-1)).toMatchObject({ type: "turns.rewound", turnId });
});
