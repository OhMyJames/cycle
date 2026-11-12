import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHarness } from "@cycle/harness-codex";
import type { ServerMessage, SessionEvent, SessionInfo, SessionState } from "@cycle/protocol";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import { type MockModel, startMockModel } from "./mock-responses.ts";

let model: MockModel;
let daemon: Daemon;
let codexHome: string;

beforeAll(async () => {
  codexHome = mkdtempSync(join(tmpdir(), "cycle-codex-home-"));
  model = startMockModel(() => ["Hello", " from", " cycle"]);
  daemon = await startDaemon({
    harness: new CodexHarness({
      config: model.codexConfig,
      env: { CODEX_HOME: codexHome },
      onLog: process.env.CYCLE_DEBUG ? (line) => console.error(`[codex] ${line}`) : undefined,
    }),
  });
});

afterAll(async () => {
  await daemon?.stop();
  model?.stop();
  rmSync(codexHome, { recursive: true, force: true });
});

/** Bare-bones wire client, independent of packages/ui, to pin the protocol. */
function connect(url: string) {
  const ws = new WebSocket(url);
  const events: SessionEvent[] = [];
  const pending = new Map<number, (message: ServerMessage) => void>();
  const waiters = new Set<() => void>();
  let nextId = 1;
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(String(data)) as ServerMessage;
    if ("event" in message) {
      events.push(message.event);
      for (const wake of waiters) wake();
    } else {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  };
  return {
    events,
    opened: new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("websocket failed"));
    }),
    call<T>(method: string, params: object = {}): Promise<T> {
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, (message) =>
          "error" in message ? reject(new Error(message.error.message)) : resolve((message as { result: T }).result),
        );
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    async waitFor<E extends SessionEvent>(predicate: (event: SessionEvent) => event is E): Promise<E> {
      for (;;) {
        const found = events.find(predicate);
        if (found) return found;
        await new Promise<void>((resolve) => {
          const wake = () => (waiters.delete(wake), resolve());
          waiters.add(wake);
        });
      }
    },
    close: () => ws.close(),
  };
}

test("a turn streams from codex through the daemon to a client", async () => {
  const client = connect(daemon.url);
  await client.opened;

  expect(await client.call("daemon.info")).toEqual({ version: "0.0.0", harness: "codex" });

  const session = await client.call<SessionInfo>("session.create", { cwd: codexHome });
  expect(session.harness).toBe("codex");
  expect(session.model).toBe("mock-model");

  const { turnId } = await client.call<{ turnId: string }>("session.send", {
    sessionId: session.id,
    text: "say hello",
  });

  const done = await client.waitFor(
    (e): e is Extract<SessionEvent, { type: "turn.completed" }> => e.type === "turn.completed",
  );
  expect(done).toMatchObject({ sessionId: session.id, turnId, status: "completed" });

  // The model's chunks arrived as incremental deltas...
  const deltas = client.events.filter((e) => e.type === "item.delta").map((e) => e.delta);
  expect(deltas.join("")).toBe("Hello from cycle");

  // ...and the daemon's snapshot agrees with what was streamed.
  const state = await client.call<SessionState>("session.get", { sessionId: session.id });
  expect(state.activeTurnId).toBeNull();
  expect(state.items.map((i) => [i.kind, "text" in i ? i.text : null])).toEqual([
    ["userMessage", "say hello"],
    ["agentMessage", "Hello from cycle"],
  ]);

  // Codex really called the model with the user's prompt.
  expect(JSON.stringify(model.requests[0])).toContain("say hello");

  client.close();
}, 60_000);

test("unknown sessions are rejected", async () => {
  const client = connect(daemon.url);
  await client.opened;
  expect(client.call("session.send", { sessionId: "nope", text: "hi" })).rejects.toThrow("unknown session");
  client.close();
});
