import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHarness } from "@cycle/harness-codex";
import { type SessionEvent, type SessionState, reduceSession } from "@cycle/protocol";
import {
  type Daemon,
  diskFile,
  type OpenProviders,
  openProviders,
  startDaemon,
} from "../../src/index.ts";
import { type MockModel, type MockReply, startMockModel } from "./mock-model.ts";
import { connect, type WireClient } from "./wire-client.ts";

// What a conversation can be made to do after the fact: a review of the code, going back to before
// a turn, and coming back after the daemon restarts with what its context holds.

let model: MockModel;
let root: string;
let project: string;
let daemon: Daemon | null = null;
let providers: OpenProviders;
let reply: MockReply = { text: ["Looks fine."] };

const start = () =>
  startDaemon({
    harness: new CodexHarness({
      config: model.codexConfig,
      env: { CODEX_HOME: join(root, "codex") },
    }),
    providers: providers.store,
    home: join(root, "home"),
  });

function git(...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: project,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cycle-history-"));
  project = join(root, "project");
  mkdirSync(join(root, "codex"));
  mkdirSync(project);
  writeFileSync(join(project, "a.txt"), "one\n");
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  model = startMockModel(() => reply);
  providers = await openProviders(
    diskFile(join(root, "home", "providers.json")),
    "gateway-token",
    join(root, "home", "provider-models.json"),
  );
  daemon = await start();
});

afterAll(async () => {
  await daemon?.stop();
  providers?.stop();
  model?.stop();
  rmSync(root, { recursive: true, force: true });
});

const completions = (client: WireClient, sessionId: string): SessionEvent[] =>
  client
    .events()
    .filter((event) => event.type === "turn.completed" && event.sessionId === sessionId);

async function opened(client: WireClient, sessionId: string): Promise<SessionState> {
  const answer = await client.call("session.open", { sessionId });
  if (!("state" in answer)) throw new Error("expected the whole state");
  return answer.state;
}

test("a review, a step back, and the context after a restart", async () => {
  if (!daemon) throw new Error("no daemon");
  let client = connect(daemon.url);
  await client.opened;
  const session = await client.call("session.create", { cwd: project, mode: "readOnly" });
  let state = await opened(client, session.id);

  await client.call("session.send", { sessionId: session.id, text: "hello" });
  await client.until(() => completions(client, session.id).length === 1);

  // A review is a turn the conversation knows by one id, from its start to its end.
  writeFileSync(join(project, "a.txt"), "two\n");
  await client.call("session.review", { sessionId: session.id, target: { kind: "uncommitted" } });
  await client.until(() => completions(client, session.id).length === 2);
  for (const frame of client.frames) {
    for (const event of frame.events) state = reduceSession(state, event);
  }
  expect(state.turns.map((turn) => turn.status)).toEqual(["completed", "completed"]);
  expect(state.turns[1]?.items).toContainEqual(
    expect.objectContaining({ kind: "review", phase: "entered" }),
  );
  expect(state.usage?.contextWindow).toBeGreaterThan(0);
  client.close();

  // A daemon started again knows what the context held before anything new is said.
  await daemon.stop();
  daemon = await start();
  client = connect(daemon.url);
  await client.opened;
  const again = await opened(client, session.id);
  // Codex says it as it resumes the session: before its answer, or just after, as a frame.
  await client.until(
    () =>
      again.usage !== null ||
      client
        .events()
        .some((event) => event.type === "usage.updated" && event.sessionId === session.id),
  );
  const usage = client.events().find((event) => event.type === "usage.updated");
  expect(
    (usage?.type === "usage.updated" ? usage.usage : again.usage)?.contextWindow,
  ).toBeGreaterThan(0);

  // Codex keeps the review as the turn it was asked in and the review itself. Going back to before
  // the review takes both, and leaves the first turn.
  const first = again.turns[0]?.id ?? "";
  const review = again.turns.at(-1)?.id ?? "";
  await client.call("session.rewind", { sessionId: session.id, turnId: review });
  await client.until(() =>
    client
      .events()
      .some((event) => event.type === "turns.rewound" && event.sessionId === session.id),
  );
  let after = again;
  for (const frame of client.frames) {
    for (const event of frame.events) after = reduceSession(after, event);
  }
  expect(after.turns.map((turn) => turn.id)).toEqual([first]);
  await daemon.stop();
  daemon = await start();
  client = connect(daemon.url);
  await client.opened;
  expect((await opened(client, session.id)).turns.map((turn) => turn.id)).toEqual([first]);
  client.close();
}, 90_000);

test("a review can be stopped", async () => {
  if (!daemon) throw new Error("no daemon");
  const client = connect(daemon.url);
  await client.opened;
  const session = await client.call("session.create", { cwd: project, mode: "readOnly" });
  await opened(client, session.id);
  reply = { text: ["one", " two", " three", " four", " five"], delayMs: 400 };
  await client.call("session.review", {
    sessionId: session.id,
    target: { kind: "custom", instructions: "look closely" },
  });
  await client.until(() =>
    client
      .events()
      .some((event) => event.type === "turn.started" && event.sessionId === session.id),
  );
  await client.call("session.interrupt", { sessionId: session.id });
  await client.until(() => completions(client, session.id).length === 1);
  expect(completions(client, session.id)[0]).toMatchObject({ status: "interrupted" });
  reply = { text: ["Looks fine."] };
  client.close();
}, 90_000);
