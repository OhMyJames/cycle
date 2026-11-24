import { describe, expect, test } from "bun:test";
import { client, methods, type SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { commandPrefixes, createAdapter } from "../src/agent.ts";
import type { AdapterConfig } from "../src/server.ts";
import {
  defaultInitResult,
  defaultSessionResponse,
  type FakeRequestHandler,
  FakeV1Agent,
} from "./fake-v1.ts";

const setup = (extra: Partial<AdapterConfig> = {}, handler?: FakeRequestHandler) => {
  let fake: FakeV1Agent | undefined;
  const config: AdapterConfig = {
    env: { HOME: "/tmp/cycle-agy-test-home", PATH: "/usr/bin:/bin" },
    agyExecutable: "/usr/local/bin/agy",
    connect: (handlers) => {
      fake = new FakeV1Agent(
        handlers,
        handler ??
          ((method) => {
            if (method === "initialize") return defaultInitResult("1.5.16");
            if (method === "session/new") return defaultSessionResponse("agy-r");
            return {};
          }),
      );
      return fake;
    },
    ...extra,
  };
  return { config, fake: () => fake as FakeV1Agent };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(5);
  }
};

const OPTIONS = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

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

describe("always allow in this session (CYC-287)", () => {
  const run = async (
    body: (ctx: {
      ask: (name: string, extra?: Record<string, unknown>) => Promise<unknown>;
      seen: Array<Array<{ optionId: string; kind: string }>>;
    }) => Promise<void>,
    answer: string,
  ) => {
    const { config, fake } = setup();
    const adapter = createAdapter(config);
    const seen: Array<Array<{ optionId: string; kind: string }>> = [];
    const app = client()
      .onNotification(methods.client.session.update, () => {})
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        seen.push(params.options as never);
        return { outcome: { outcome: "selected", optionId: answer } } as never;
      });
    try {
      await app.connectWith(adapter.app, async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        await agent.request(methods.agent.session.new, { cwd: "/tmp/work" } as never);
        let n = 0;
        await body({
          seen,
          ask: (name, extra = {}) => {
            n += 1;
            return fake().askClient("session/request_permission", {
              sessionId: "agy-r",
              toolCall: { toolCallId: `c${n}`, name, status: "pending", ...extra },
              options: OPTIONS,
            });
          },
        });
      });
    } finally {
      adapter.close();
    }
  };

  test("an MCP tool is asked once, another tool still asks", async () => {
    await run(async ({ ask, seen }) => {
      const first = (await ask("mcp_plan_get_project")) as { outcome: { optionId: string } };
      expect(seen[0]?.map((o) => o.kind)).toEqual(["allow_once", "reject_once", "allow_always"]);
      // agy is answered with its own allow option, never the one made here.
      expect(first.outcome.optionId).toBe("allow");
      const second = (await ask("mcp_plan_get_project")) as { outcome: { optionId: string } };
      expect(second.outcome.optionId).toBe("allow");
      expect(seen.length).toBe(1);
      await ask("mcp_plan_update_issue");
      expect(seen.length).toBe(2);
    }, "cycle-allow-session");
  });

  test("a shell command is remembered by prefix, and a chain needs every segment covered", async () => {
    await run(async ({ ask, seen }) => {
      await ask("run_command", { rawInput: { CommandLine: "git status" } });
      await ask("run_command", { rawInput: { CommandLine: "git status" } });
      expect(seen.length).toBe(1);
      await ask("run_command", { rawInput: { CommandLine: "git push" } });
      expect(seen.length).toBe(2);
      await ask("run_command", { rawInput: { CommandLine: "git status && git push" } });
      expect(seen.length).toBe(2); // both prefixes are remembered by now
      await ask("run_command", { rawInput: { CommandLine: "git status && rm -rf x" } });
      expect(seen.length).toBe(3);
    }, "cycle-allow-session");
  });

  test("allowing once remembers nothing; a command that cannot be judged offers no always option", async () => {
    await run(async ({ ask, seen }) => {
      await ask("mcp_plan_get_project");
      await ask("mcp_plan_get_project");
      expect(seen.length).toBe(2);
      await ask("run_command", { rawInput: { CommandLine: "echo $(id)" } });
      expect(seen[2]?.some((o) => o.kind === "allow_always")).toBe(false);
    }, "allow");
  });

  test("what is remembered ends with the session", async () => {
    const { config, fake } = setup();
    const adapter = createAdapter(config);
    let asked = 0;
    const app = client()
      .onNotification(methods.client.session.update, () => {})
      .onRequest(methods.client.session.requestPermission, () => {
        asked += 1;
        return { outcome: { outcome: "selected", optionId: "cycle-allow-session" } } as never;
      });
    try {
      await app.connectWith(adapter.app, async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        const ask = () =>
          fake().askClient("session/request_permission", {
            sessionId: "agy-r",
            toolCall: { toolCallId: "c", name: "mcp_plan_get_project", status: "pending" },
            options: OPTIONS,
          });
        await agent.request(methods.agent.session.new, { cwd: "/tmp/work" } as never);
        await ask();
        await ask();
        expect(asked).toBe(1);
        await agent.request(methods.agent.session.close, { sessionId: "agy-r" } as never);
        await agent.request(methods.agent.session.new, { cwd: "/tmp/work" } as never);
        await ask();
        expect(asked).toBe(2);
      });
    } finally {
      adapter.close();
    }
  });
});

describe("idle debounce and sub-agents (CYC-289, CYC-290)", () => {
  const states = (updates: SessionUpdate[]) =>
    updates
      .filter((u) => u.sessionUpdate === "state_update")
      .map((u) => (u as { state: string }).state);

  test("an update inside the debounce keeps the turn running; a quiet one ends it", async () => {
    const { config, fake } = setup({ autonomousIdleMs: 200 });
    const adapter = createAdapter(config);
    const updates: SessionUpdate[] = [];
    const app = client().onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    });
    try {
      await app.connectWith(adapter.app, async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        await agent.request(methods.agent.session.new, { cwd: "/tmp/work" } as never);
        const chunk = () =>
          fake().emitUpdate("agy-r", {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "x" },
          });
        chunk();
        await Bun.sleep(100);
        chunk();
        await Bun.sleep(100);
        chunk();
        await Bun.sleep(100);
        expect(states(updates)).toEqual(["running"]);
        await waitFor(() => states(updates).includes("idle"));
        expect(states(updates)).toEqual(["running", "idle"]);
      });
    } finally {
      adapter.close();
    }
  });

  test("a sub-agent that is working keeps the turn from idling, even after its call completed", async () => {
    const { config, fake } = setup({ autonomousIdleMs: 30 });
    const adapter = createAdapter(config);
    const updates: SessionUpdate[] = [];
    const app = client().onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    });
    try {
      await app.connectWith(adapter.app, async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        await agent.request(methods.agent.session.new, { cwd: "/tmp/work" } as never);
        fake().emitUpdate("agy-r", {
          sessionUpdate: "tool_call",
          toolCallId: "sub1",
          name: "invoke_subagent",
          title: "Sub-agent: Researcher",
          status: "in_progress",
          rawInput: { Role: "Researcher" },
        });
        fake().emitUpdate("agy-r", {
          sessionUpdate: "tool_call_update",
          toolCallId: "sub1",
          status: "completed",
        });
        await Bun.sleep(150);
        expect(states(updates)).toEqual(["running"]);
        // agy checking on its tasks is the sign that it is over.
        fake().emitUpdate("agy-r", {
          sessionUpdate: "tool_call",
          toolCallId: "mt1",
          name: "manage_task",
          rawInput: { Action: "status" },
          status: "completed",
        });
        await waitFor(() => states(updates).includes("idle"));
        const closed = updates.filter(
          (u) =>
            u.sessionUpdate === "tool_call_update" &&
            (u as { toolCallId?: string }).toolCallId === "sub1" &&
            (u as { status?: string }).status === "completed",
        );
        expect(closed.length).toBeGreaterThan(1); // agy's own, then the one that ends the wait
      });
    } finally {
      adapter.close();
    }
  });
});
