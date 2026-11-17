/**
 * What Claude Code says of its requests, end to end: the real Claude Code against a scripted model
 * that fails once, with a limit it stops at, and with the guess of what is sent next.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClaudeConfig, ClaudeHarness, emptyConfig } from "@cycle/harness-claude";
import { CodexHarness } from "@cycle/harness-codex";
import type { HarnessEvent, SessionEvent } from "@cycle/protocol";
import {
  type Daemon,
  Harnesses,
  JsonStore,
  type OpenProviders,
  claudeConfigBook,
  diskFile,
  openProviders,
  startDaemon,
} from "../../src/index.ts";
import { type ClaudeReply, type MockClaude, startMockClaude } from "./mock-claude.ts";
import { type MockModel, startMockModel } from "./mock-model.ts";
import { type WireClient, connect } from "./wire-client.ts";

const SONNET = "claude-sonnet-5-5";
const CLAUDE = { harness: "claude" };

let daemon: Daemon;
let codexModel: MockModel;
let claude: MockClaude;
let providers: OpenProviders;
let root: string;
let project: string;
let client: WireClient;
let script: (prompt: string, results: number) => ClaudeReply;
const guesses: (string | null)[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cycle-claude-requests-"));
  project = join(root, "project");
  mkdirSync(project);
  mkdirSync(join(root, "codex"));
  script = () => ({ text: ["ok"] });
  codexModel = startMockModel(() => ({ text: ["Hello from codex"] }));
  claude = startMockClaude(root, (prompt, results) => script(prompt, results));
  providers = await openProviders(
    diskFile(join(root, "home", "providers.json")),
    "gateway-token",
    join(root, "home", "provider-models.json"),
  );
  const store = await JsonStore.open<ClaudeConfig>(
    diskFile(join(root, "home", "claude.json")),
    emptyConfig(),
  );
  const claudeHarness = new ClaudeHarness({
    env: claude.env,
    config: { book: claudeConfigBook(store), dir: join(root, "home", "claude") },
    ...(process.env["CYCLE_DEBUG"]
      ? { onLog: (line: string) => console.error(`[claude] ${line}`) }
      : {}),
  });
  claudeHarness.onEvent((event: HarnessEvent) => {
    if (event.type === "suggestion.changed") guesses.push(event.suggestion);
  });
  daemon = await startDaemon({
    providers: providers.store,
    harness: new Harnesses(
      new CodexHarness({
        config: codexModel.codexConfig,
        env: { CODEX_HOME: join(root, "codex") },
      }),
      [claudeHarness],
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

const of = (sessionId: string): SessionEvent[] =>
  client.events().filter((event) => event.sessionId === sessionId);
const ended = (sessionId: string) =>
  of(sessionId).filter((event) => event.type === "turn.completed");

async function say(sessionId: string, text: string) {
  const turns = ended(sessionId).length;
  await client.call("session.send", { sessionId, text });
  await client.until(() => ended(sessionId).length > turns);
  return ended(sessionId).at(-1);
}

async function start() {
  const session = await client.call("session.create", { cwd: project, model: SONNET });
  await client.call("session.open", { sessionId: session.id });
  return session;
}

async function run(change: object) {
  const settings = await client.call("hooks.read", CLAUDE);
  await client.call("hooks.set", {
    ...CLAUDE,
    settings: { ...settings, run: { ...settings.run, ...change } },
  });
}

test("a request the API turned away is tried again, and the owner is told once", async () => {
  const session = await start();
  let failed = 0;
  script = (prompt) =>
    prompt.includes("overloaded") && failed++ < 2 ? { status: 529 } : { text: ["Made it."] };
  const done = await say(session.id, "say something while overloaded");
  expect(done).toMatchObject({ status: "completed" });
  const told = of(session.id).filter(
    (event) => event.type === "notice" && event.message.includes("trying again"),
  );
  expect(told).toHaveLength(1);
}, 60_000);

test("a turn that reached the most requests fails and names that, and the next turn is told by Claude Code", async () => {
  await run({ maxTurns: 1 });
  const session = await start();
  script = (_prompt, results) =>
    results === 0
      ? { call: { name: "Bash", input: { command: "true", description: "Do" } } }
      : { text: ["done"] };
  const done = await say(session.id, "use a tool and then answer");
  expect(done).toMatchObject({ status: "failed" });
  expect(done && "error" in done ? done.error : "").toContain("maximum number of turns");
  // Claude Code counts from the process's start, so the next turn, a plain answer, is told too.
  const next = await say(session.id, "answer plainly now");
  expect(next).toMatchObject({ status: "failed" });
  await run({ maxTurns: null });
}, 60_000);

test("with suggestions on, a guess of what to send next comes after a turn and goes with the next", async () => {
  await run({ promptSuggestions: true });
  const session = await start();
  // Claude Code asks the model for the guess with a prompt of its own, which a plausible message answers.
  script = (prompt) => ({
    text: [prompt.startsWith("[SUGGESTION MODE") ? "run the tests again" : "Done."],
  });
  await say(session.id, "first");
  await say(session.id, "second");
  await client.until(() => guesses.some((guess) => typeof guess === "string"));
  await say(session.id, "third");
  expect(guesses.at(-1)).toBeNull();
  await run({ promptSuggestions: false });
}, 60_000);
