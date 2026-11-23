import { describe, expect, test } from "bun:test";
import { client, methods, type SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { CycleErrorCode, META } from "@cycle/protocol";
import { createAdapter } from "../src/agent.ts";
import { type AdapterConfig, buildAgyArgs } from "../src/server.ts";
import { AGY_MIN_VERSION, isVersionSupported } from "../src/v1.ts";
import {
  AgyRpcError,
  defaultInitResult,
  defaultSessionResponse,
  type FakeRequestHandler,
  FakeV1Agent,
} from "./fake-v1.ts";

const baseConfig = (
  handler: FakeRequestHandler,
  extra: Partial<AdapterConfig> = {},
): { config: AdapterConfig; getFake: () => FakeV1Agent } => {
  let fake: FakeV1Agent | undefined;
  const config: AdapterConfig = {
    env: { HOME: "/tmp/cycle-agy-test-home", PATH: "/usr/bin:/bin" },
    agyExecutable: "/usr/local/bin/agy",
    connect: (handlers) => {
      fake = new FakeV1Agent(handlers, handler);
      return fake;
    },
    ...extra,
  };
  return {
    config,
    getFake: () => {
      if (!fake) throw new Error("fake v1 agent was never created");
      return fake;
    },
  };
};

const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await Bun.sleep(5);
  }
};

describe("version check and CLI arguments", () => {
  test("isVersionSupported enforces AGY_MIN_VERSION (1.5.10)", () => {
    expect(AGY_MIN_VERSION).toBe("1.5.10");
    expect(isVersionSupported("1.5.10")).toBe(true);
    expect(isVersionSupported("1.5.15")).toBe(true);
    expect(isVersionSupported("1.6.0")).toBe(true);
    expect(isVersionSupported("2.0.0")).toBe(true);
    expect(isVersionSupported("1.5.9")).toBe(false);
    expect(isVersionSupported("1.4.99")).toBe(false);
    expect(isVersionSupported("0.9.9")).toBe(false);
    expect(isVersionSupported("not-a-version")).toBe(false);
  });

  test("buildAgyArgs includes --process-per-session and only disables telemetry when explicitly false", () => {
    const base: AdapterConfig = {
      env: { HOME: "/tmp/h" },
      agyExecutable: "/usr/bin/agy",
    };
    expect(buildAgyArgs(base)).toEqual(["acp", "--process-per-session"]);
    expect(buildAgyArgs({ ...base, telemetry: true })).toEqual(["acp", "--process-per-session"]);
    expect(
      buildAgyArgs({
        ...base,
        telemetry: false,
        sandbox: true,
        agent: "reviewer",
        logFile: "/tmp/agy.log",
      }),
    ).toEqual([
      "acp",
      "--process-per-session",
      "--log-file",
      "/tmp/agy.log",
      "--sandbox",
      "--agent",
      "reviewer",
      "--disable-telemetry",
    ]);
    expect(buildAgyArgs({ ...base, sandbox: true })).not.toContain(
      "--dangerously-skip-permissions",
    );
  });
});

describe("harness/agy core v1-to-v2 bridge", () => {
  test("rejects agy versions below minimum on initialize", async () => {
    const { config } = baseConfig((method) => {
      if (method === "initialize") return defaultInitResult("1.5.9");
      return {};
    });
    const adapter = createAdapter(config);
    const app = client();
    try {
      await app.connectWith(adapter.app, async (agent) => {
        let caught: unknown;
        try {
          await agent.request(methods.agent.initialize, {
            protocolVersion: 2,
            capabilities: {},
            info: { name: "test", version: "1" },
          });
        } catch (error) {
          caught = error;
        }
        expect((caught as { code?: number })?.code).toBe(CycleErrorCode.AgentUnavailable);
      });
    } finally {
      adapter.close();
    }
  });

  test("runs a full turn: immediate messageId, streaming text/thought, tool calls, permission approval, and idle", async () => {
    let resolvePrompt: ((value: unknown) => void) | undefined;
    const { config, getFake } = baseConfig((method, params, fake) => {
      if (method === "initialize") return defaultInitResult("1.5.15");
      if (method === "session/new") return defaultSessionResponse("agy-s1");
      if (method === "session/prompt") {
        const sid = (params as { sessionId: string }).sessionId;
        return new Promise((resolve) => {
          resolvePrompt = resolve;
          queueMicrotask(async () => {
            fake.emitUpdate(sid, {
              sessionUpdate: "available_commands_update",
              availableCommands: [{ name: "compact", description: "Compact" }],
            });
            // Duplicate command list should be deduplicated.
            fake.emitUpdate(sid, {
              sessionUpdate: "available_commands_update",
              availableCommands: [{ name: "compact", description: "Compact" }],
            });
            fake.emitUpdate(sid, {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "Thinking..." },
            });
            fake.emitUpdate(sid, {
              sessionUpdate: "tool_call",
              toolCallId: "call_1",
              name: "run_command",
              kind: "execute",
              title: "echo hi",
              status: "pending",
              rawInput: { CommandLine: "echo hi" },
            });
            const perm = (await fake.askClient("session/request_permission", {
              sessionId: sid,
              toolCall: {
                toolCallId: "call_1",
                name: "run_command",
                kind: "execute",
                title: "echo hi",
                status: "pending",
              },
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "deny", name: "Deny", kind: "reject_once" },
              ],
            })) as { outcome: { outcome: string; optionId?: string } };
            expect(perm.outcome.optionId).toBe("allow");
            fake.emitUpdate(sid, {
              sessionUpdate: "tool_call_update",
              toolCallId: "call_1",
              name: "run_command",
              kind: "execute",
              title: "echo hi",
              status: "completed",
              rawOutput: { output: "hi\n", exit_code: 0 },
              content: [{ type: "content", content: { type: "text", text: "hi\n" } }],
            });
            fake.emitUpdate(sid, {
              sessionUpdate: "unknown_future_update",
              foo: "bar",
            });
            fake.emitUpdate(sid, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Done!" },
            });
            fake.emitUpdate(sid, {
              sessionUpdate: "usage_update",
              used: 1200,
              size: 1048576,
            });
            fake.emitUpdate(sid, {
              sessionUpdate: "session_info_update",
              title: "Echo Hi",
            });
            resolvePrompt?.({ stopReason: "end_turn" });
          });
        });
      }
      if (method === "session/close") return {};
      return {};
    });

    const adapter = createAdapter(config);
    const updates: SessionUpdate[] = [];
    const seenPermOptions: unknown[] = [];
    const app = client()
      .onNotification(methods.client.session.update, ({ params }) => {
        updates.push(params.update);
      })
      .onRequest(methods.client.session.requestPermission, ({ params }) => {
        seenPermOptions.push(params.options);
        return { outcome: { outcome: "selected", optionId: "allow" } } as never;
      });

    try {
      await app.connectWith(adapter.app, async (agent) => {
        const init = await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        expect(init.protocolVersion).toBe(2);
        expect(init.capabilities?.session?.mcp?.http).toBeDefined();

        // Bridge must not declare fs/terminal to agy.
        const initReq = getFake().requests.find((r) => r.method === "initialize")?.params as {
          clientCapabilities?: { fs?: { readTextFile?: boolean }; terminal?: boolean };
        };
        expect(initReq.clientCapabilities?.fs?.readTextFile).toBe(false);
        expect(initReq.clientCapabilities?.terminal).toBe(false);

        const created = await agent.request(methods.agent.session.new, {
          cwd: "/tmp/work",
          systemPrompt: { mode: "append", content: [{ type: "text", text: "Be concise." }] },
        });
        expect(created.sessionId).toBe("agy-s1");
        const newReq = getFake().requests.find((r) => r.method === "session/new")?.params as {
          _meta?: { antigravity?: { systemPrompt?: { append?: string } } };
        };
        expect(newReq._meta?.antigravity?.systemPrompt?.append).toBe("Be concise.");

        // Prompt returns messageId immediately, before v1 prompt resolves.
        const ack = (await agent.request(methods.agent.session.prompt, {
          sessionId: "agy-s1",
          prompt: [{ type: "text", text: "Run echo hi" }],
        } as never)) as { messageId: string };
        expect(typeof ack.messageId).toBe("string");

        await waitFor(() =>
          updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"),
        );

        const kinds = updates.map((u) => u.sessionUpdate);
        expect(kinds[0]).toBe("user_message");
        expect(kinds[1]).toBe("state_update");
        expect(kinds.filter((k) => k === "available_commands_update")).toHaveLength(1);
        expect(kinds).toContain("agent_thought_chunk");
        expect(kinds).toContain("agent_message_chunk");
        expect(kinds).toContain("usage_update");
        expect(kinds).toContain("session_info_update");

        const completedTool = updates.find(
          (u) => u.sessionUpdate === "tool_call_update" && u.status === "completed",
        ) as { _meta?: Record<string, unknown> } | undefined;
        expect(completedTool?._meta?.[META.toolResult]).toEqual({ run: { exitCode: 0 } });

        // Permission options forwarded verbatim (only allow_once and reject_once).
        expect(seenPermOptions).toEqual([
          [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        ]);

        const idleUpdates = updates.filter(
          (u) => u.sessionUpdate === "state_update" && u.state === "idle",
        );
        expect(idleUpdates).toHaveLength(1);
        expect((idleUpdates[0] as { stopReason?: string }).stopReason).toBe("end_turn");

        await agent.request(methods.agent.session.close, { sessionId: "agy-s1" } as never);
        expect(getFake().requests.some((r) => r.method === "session/close")).toBe(true);
      });
    } finally {
      adapter.close();
    }
  });

  test("rejects override systemPrompt with -32602 without calling agy", async () => {
    const { config, getFake } = baseConfig((method) => {
      if (method === "initialize") return defaultInitResult("1.5.15");
      if (method === "session/new") return defaultSessionResponse("agy-s1");
      return {};
    });
    const adapter = createAdapter(config);
    const app = client();
    try {
      await app.connectWith(adapter.app, async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        let caught: unknown;
        try {
          await agent.request(methods.agent.session.new, {
            cwd: "/tmp/work",
            systemPrompt: { mode: "override", content: [{ type: "text", text: "Replace all" }] },
          });
        } catch (error) {
          caught = error;
        }
        expect((caught as { code?: number })?.code).toBe(-32602);
        expect(getFake().requests.some((r) => r.method === "session/new")).toBe(false);
      });
    } finally {
      adapter.close();
    }
  });

  test("session/cancel aborts pending permission, closes open tools, and emits exactly one idle even on race", async () => {
    let permOutcome: unknown;
    let resolvePrompt: ((v: unknown) => void) | undefined;
    const { config, getFake } = baseConfig(
      (method, params, fake) => {
        if (method === "initialize") return defaultInitResult("1.5.15");
        if (method === "session/new") return defaultSessionResponse("agy-s2");
        if (method === "session/prompt") {
          const sid = (params as { sessionId: string }).sessionId;
          return new Promise((resolve) => {
            resolvePrompt = resolve;
            queueMicrotask(async () => {
              fake.emitUpdate(sid, {
                sessionUpdate: "tool_call",
                toolCallId: "call_hang",
                name: "run_command",
                kind: "execute",
                title: "sleep 60",
                status: "pending",
              });
              permOutcome = await fake.askClient("session/request_permission", {
                sessionId: sid,
                toolCall: { toolCallId: "call_hang", name: "run_command", status: "pending" },
                options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
              });
            });
          });
        }
        return {};
      },
      { cancelTimeoutMs: 40 },
    );

    const adapter = createAdapter(config);
    const updates: SessionUpdate[] = [];
    let permissionAsked = false;
    const app = client()
      .onNotification(methods.client.session.update, ({ params }) => {
        updates.push(params.update);
      })
      .onRequest(methods.client.session.requestPermission, () => {
        permissionAsked = true;
        // Never answer: wait for cancel to abort it.
        return new Promise(() => {});
      });

    try {
      await app.connectWith(adapter.app, async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        await agent.request(methods.agent.session.new, { cwd: "/tmp/work" } as never);
        await agent.request(methods.agent.session.prompt, {
          sessionId: "agy-s2",
          prompt: [{ type: "text", text: "Sleep forever" }],
        } as never);
        await waitFor(() => permissionAsked);

        await agent.notify(methods.agent.session.cancel, { sessionId: "agy-s2" } as never);

        await waitFor(() =>
          updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"),
        );

        // Even if agy resolves late after timeout, no duplicate idle is emitted.
        resolvePrompt?.({ stopReason: "cancelled" });
        await Bun.sleep(20);

        expect(getFake().notifications.some((n) => n.method === "session/cancel")).toBe(true);
        expect(permOutcome).toEqual({ outcome: { outcome: "cancelled" } });
        expect(
          updates.some(
            (u) =>
              u.sessionUpdate === "tool_call_update" &&
              u.toolCallId === "call_hang" &&
              u.status === "cancelled",
          ),
        ).toBe(true);
        const idles = updates.filter(
          (u) => u.sessionUpdate === "state_update" && u.state === "idle",
        );
        expect(idles).toHaveLength(1);
        expect((idles[0] as { stopReason?: string }).stopReason).toBe("cancelled");
      });
    } finally {
      adapter.close();
    }
  });

  test("unexpected agy process exit ends active turn with AgentExited error and triggers onServerExit", async () => {
    let exitedCallback = 0;
    const { config, getFake } = baseConfig(
      (method, params, fake) => {
        if (method === "initialize") return defaultInitResult("1.5.15");
        if (method === "session/new") return defaultSessionResponse("agy-s3");
        if (method === "session/prompt") {
          const sid = (params as { sessionId: string }).sessionId;
          fake.emitUpdate(sid, {
            sessionUpdate: "tool_call",
            toolCallId: "call_open",
            name: "read_file",
            kind: "read",
            status: "in_progress",
          });
          return new Promise(() => {});
        }
        return {};
      },
      {
        onServerExit: () => {
          exitedCallback += 1;
        },
      },
    );

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
        await agent.request(methods.agent.session.prompt, {
          sessionId: "agy-s3",
          prompt: [{ type: "text", text: "Crash mid-turn" }],
        } as never);

        await waitFor(() => updates.some((u) => u.sessionUpdate === "tool_call_update"));
        getFake().crash("agy acp exited (SIGKILL)");

        await waitFor(() =>
          updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"),
        );

        const idle = updates.find(
          (u) => u.sessionUpdate === "state_update" && u.state === "idle",
        ) as { stopReason?: string; error?: { code?: number; message?: string } };
        expect(idle.stopReason).toBe("error");
        expect(idle.error?.code).toBe(CycleErrorCode.AgentExited);
        expect(exitedCallback).toBe(1);
        expect(
          updates.some(
            (u) =>
              u.sessionUpdate === "tool_call_update" &&
              u.toolCallId === "call_open" &&
              u.status === "cancelled",
          ),
        ).toBe(true);
      });
    } finally {
      adapter.close();
    }
  });

  test("preserves -32000 authentication required error from agy on session/new", async () => {
    const { config } = baseConfig((method) => {
      if (method === "initialize") return defaultInitResult("1.5.15");
      if (method === "session/new") throw new AgyRpcError(-32000, "Authentication required");
      return {};
    });
    const adapter = createAdapter(config);
    const app = client();
    try {
      await app.connectWith(adapter.app, async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        let caught: unknown;
        try {
          await agent.request(methods.agent.session.new, { cwd: "/tmp/work" } as never);
        } catch (error) {
          caught = error;
        }
        expect((caught as { code?: number })?.code).toBe(-32000);
      });
    } finally {
      adapter.close();
    }
  });
});

describe("session resume and id association (CYCL-173)", () => {
  test("session/resume emits state_update: idle before returning, passes systemPrompt.append, and never replays", async () => {
    const timeline: string[] = [];
    const { config, getFake } = baseConfig((method, params) => {
      if (method === "initialize") return defaultInitResult("1.5.15");
      if (method === "session/resume") {
        const res = defaultSessionResponse("agy-resumed");
        const { sessionId: _omit, ...withoutId } = res;
        // agy's v1 session/resume omits sessionId in the result.
        return withoutId;
      }
      if (method === "session/prompt") {
        expect((params as { sessionId: string }).sessionId).toBe("agy-resumed");
        return { stopReason: "end_turn" };
      }
      return {};
    });

    const adapter = createAdapter(config);
    const updates: SessionUpdate[] = [];
    const app = client().onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update);
      if (params.update.sessionUpdate === "state_update") {
        timeline.push(`state:${params.update.state}`);
      }
    });

    try {
      await app.connectWith(adapter.app, async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        const resumed = (await agent.request(methods.agent.session.resume, {
          sessionId: "agy-resumed",
          cwd: "/tmp/work",
          additionalDirectories: ["/tmp/extra"],
          systemPrompt: { mode: "append", content: [{ type: "text", text: "Keep context" }] },
        } as never)) as { configOptions?: unknown[]; _meta?: Record<string, unknown> };
        timeline.push("resume:returned");

        expect(timeline[0]).toBe("state:idle");
        expect(timeline[1]).toBe("resume:returned");
        expect(resumed._meta).toBeUndefined();
        expect(Array.isArray(resumed.configOptions)).toBe(true);
        expect(getFake().requests.some((r) => r.method === "session/load")).toBe(false);

        const resumeReq = getFake().requests.find((r) => r.method === "session/resume")?.params as {
          sessionId: string;
          cwd: string;
          additionalDirectories?: string[];
          _meta?: { antigravity?: { systemPrompt?: { append?: string } } };
        };
        expect(resumeReq.sessionId).toBe("agy-resumed");
        expect(resumeReq.additionalDirectories).toEqual(["/tmp/extra"]);
        expect(resumeReq._meta?.antigravity?.systemPrompt?.append).toBe("Keep context");

        await agent.request(methods.agent.session.prompt, {
          sessionId: "agy-resumed",
          prompt: [{ type: "text", text: "Follow up" }],
        } as never);
        await waitFor(
          () =>
            updates.filter((u) => u.sessionUpdate === "state_update" && u.state === "idle")
              .length >= 2,
        );
      });
    } finally {
      adapter.close();
    }
  });

  test("session/resume falls back to session/new when missing and hadTurn is false, returning cycle/agentSessionId", async () => {
    const { config, getFake } = baseConfig((method) => {
      if (method === "initialize") return defaultInitResult("1.5.15");
      if (method === "session/resume") {
        throw new AgyRpcError(-32603, "Failed to read session agy-old-empty: no such file");
      }
      if (method === "session/new") return defaultSessionResponse("agy-fresh-id");
      if (method === "session/prompt") return { stopReason: "end_turn" };
      return {};
    });

    const adapter = createAdapter(config);
    const updates: Array<{ sessionId: string; update: SessionUpdate }> = [];
    const app = client().onNotification(methods.client.session.update, ({ params }) => {
      updates.push({ sessionId: params.sessionId, update: params.update });
    });

    try {
      await app.connectWith(adapter.app, async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        const resumed = (await agent.request(methods.agent.session.resume, {
          sessionId: "agy-old-empty",
          cwd: "/tmp/work",
        } as never)) as { _meta?: Record<string, unknown> };

        expect(resumed._meta?.[META.agentSessionId]).toBe("agy-fresh-id");
        expect(updates[0]).toEqual({
          sessionId: "agy-fresh-id",
          update: { sessionUpdate: "state_update", state: "idle" },
        });
        expect(getFake().requests.map((r) => r.method)).toEqual([
          "initialize",
          "session/resume",
          "session/new",
        ]);
      });
    } finally {
      adapter.close();
    }
  });

  test("session/resume refuses fallback when cycle/hadTurn is true and propagates error", async () => {
    const { config, getFake } = baseConfig((method) => {
      if (method === "initialize") return defaultInitResult("1.5.15");
      if (method === "session/resume") {
        throw new AgyRpcError(-32603, "Failed to read session agy-gone: no such file");
      }
      if (method === "session/new") return defaultSessionResponse("should-not-happen");
      return {};
    });

    const adapter = createAdapter(config);
    const app = client();
    try {
      await app.connectWith(adapter.app, async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        let caught: unknown;
        try {
          await agent.request(methods.agent.session.resume, {
            sessionId: "agy-gone",
            cwd: "/tmp/work",
            _meta: { [META.hadTurn]: true },
          } as never);
        } catch (error) {
          caught = error;
        }
        expect((caught as { code?: number })?.code).toBe(-32603);
        expect(getFake().requests.some((r) => r.method === "session/new")).toBe(false);
      });
    } finally {
      adapter.close();
    }
  });
});
