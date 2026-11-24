import { describe, expect, test } from "bun:test";
import {
  client,
  methods,
  type SessionConfigOption,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import { CycleErrorCode, META, ToolResultSchema } from "@cycle/protocol";
import {
  applyUpdate,
  emptyConversation,
  sessionEdits,
} from "../../../packages/ui/src/model/index.ts";
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
    // Permissions go through agy's settings.json at session start, never through a process-wide flag.
    expect(buildAgyArgs({ ...base, skipPermissions: true })).toEqual([
      "acp",
      "--process-per-session",
    ]);
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
          "session/set_config_option",
        ]);
      });
    } finally {
      adapter.close();
    }
  });

  const modeOf = (options: readonly SessionConfigOption[]) =>
    (
      options.find((o) => (o as { configId?: string }).configId === "mode") as
        | { currentValue?: unknown }
        | undefined
    )?.currentValue;

  test("a new session starts in auto, not agy's own default, so Cycle's shown default is the one agy runs in", async () => {
    const { config, getFake } = baseConfig((method, params) => {
      if (method === "initialize") return defaultInitResult("1.5.15");
      if (method === "session/new") return defaultSessionResponse("agy-auto");
      if (method === "session/set_config_option") {
        const p = params as { configId: string; value: string };
        return {
          configOptions: (defaultSessionResponse("agy-auto").configOptions ?? []).map((o) =>
            o.id === p.configId ? { ...o, currentValue: p.value } : o,
          ),
        };
      }
      return {};
    });
    const adapter = createAdapter(config);
    try {
      await client().connectWith(adapter.app, async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        const created = await agent.request(methods.agent.session.new, {
          cwd: "/tmp/work",
          mcpServers: [],
        } as never);
        expect(modeOf(created.configOptions ?? [])).toBe("auto");
        expect(
          getFake()
            .requests.filter((r) => r.method === "session/set_config_option")
            .map((r) => r.params),
        ).toEqual([{ sessionId: "agy-auto", configId: "mode", value: "auto" }]);
      });
    } finally {
      adapter.close();
    }
  });

  test("a new session keeps agy's mode when agy refuses auto (an account without it)", async () => {
    const { config } = baseConfig((method) => {
      if (method === "initialize") return defaultInitResult("1.5.15");
      if (method === "session/new") return defaultSessionResponse("agy-no-auto");
      if (method === "session/set_config_option") throw new AgyRpcError(-32602, "auto unavailable");
      return {};
    });
    const adapter = createAdapter(config);
    try {
      await client().connectWith(adapter.app, async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        const created = await agent.request(methods.agent.session.new, {
          cwd: "/tmp/work",
          mcpServers: [],
        } as never);
        expect(modeOf(created.configOptions ?? [])).toBe("default");
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

describe("configuration options: mode, model, effort (CYCL-174)", () => {
  test("setConfigOption maps mode/model/effort, handles mode fallback, and resets unsupported effort on model switch", async () => {
    let currentModel = "gemini-4-neon";
    let currentThought = "high";
    let currentMode = "default";

    const buildV1Config = () => {
      const base = defaultSessionResponse("agy-cfg");
      const opts = (base.configOptions ?? [])
        .filter(
          (o) => !(currentModel === "gemini-pro-orchestrator-neon" && o.id === "thought_level"),
        )
        .map((o) => {
          if (o.id === "model") return { ...o, currentValue: currentModel };
          if (o.id === "mode") return { ...o, currentValue: currentMode };
          if (o.id === "thought_level") {
            const options =
              currentModel === "gemini-4-carbon"
                ? (o.options ?? []).filter((c) => c.value !== "xhigh")
                : (o.options ?? []);
            return { ...o, currentValue: currentThought, options };
          }
          return o;
        });
      return opts;
    };

    const { config, getFake } = baseConfig((method, params, fake) => {
      if (method === "initialize") return defaultInitResult("1.5.15");
      if (method === "session/new") return defaultSessionResponse("agy-cfg");
      if (method === "session/set_config_option") {
        const p = params as { sessionId: string; configId: string; value: string };
        if (p.configId === "mode") {
          // Simulate agy falling back `auto` -> `default` when not allowed.
          currentMode = p.value === "auto" ? "default" : p.value;
        } else if (p.configId === "model") {
          currentModel = p.value;
          currentThought = "high";
        } else if (p.configId === "thought_level") {
          if (currentModel === "gemini-4-carbon" && p.value === "xhigh") {
            throw new AgyRpcError(-32602, "Unsupported thought_level xhigh");
          }
          currentThought = p.value;
        }
        return { configOptions: buildV1Config() };
      }
      if (method === "session/prompt") {
        fake.emitUpdate("agy-cfg", { sessionUpdate: "current_mode_update", currentModeId: "plan" });
        return { stopReason: "end_turn" };
      }
      return {};
    });

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
        const created = (await agent.request(methods.agent.session.new, {
          cwd: "/tmp/work",
        } as never)) as {
          sessionId: string;
          configOptions: Array<{
            configId: string;
            currentValue: string;
            options: Array<{ value: string; _meta?: Record<string, unknown> }>;
          }>;
        };

        // Initial model & effort report "default" and expose per-model META.efforts without `max`.
        const modelOpt = created.configOptions.find((o) => o.configId === "model");
        const effortOpt = created.configOptions.find((o) => o.configId === "effort");
        expect(modelOpt?.currentValue).toBe("default");
        expect(effortOpt?.currentValue).toBe("default");
        expect(effortOpt?.options.map((o) => o.value)).toEqual([
          "default",
          "low",
          "medium",
          "high",
          "xhigh",
        ]);
        expect(
          modelOpt?.options.find((o) => o.value === "gemini-4-neon")?._meta?.[META.efforts],
        ).toEqual(["low", "medium", "high", "xhigh"]);
        expect(
          modelOpt?.options.find((o) => o.value === "gemini-4-carbon")?._meta?.[META.efforts],
        ).toEqual(["low", "medium", "high"]);
        expect(
          modelOpt?.options.find((o) => o.value === "gemini-pro-orchestrator-neon")?._meta?.[
            META.efforts
          ],
        ).toEqual([]);

        // Mode fallback: requesting `auto` when agy falls back returns actual `default`.
        const afterAuto = (await agent.request(methods.agent.session.setConfigOption, {
          sessionId: "agy-cfg",
          configId: "mode",
          type: "id",
          value: "auto",
        } as never)) as { configOptions: Array<{ configId: string; currentValue: string }> };
        expect(afterAuto.configOptions.find((o) => o.configId === "mode")?.currentValue).toBe(
          "default",
        );

        // Set plan mode + explicit xhigh effort.
        const afterPlan = (await agent.request(methods.agent.session.setConfigOption, {
          sessionId: "agy-cfg",
          configId: "mode",
          type: "id",
          value: "plan",
        } as never)) as { configOptions: Array<{ configId: string; currentValue: string }> };
        expect(afterPlan.configOptions.find((o) => o.configId === "mode")?.currentValue).toBe(
          "plan",
        );

        const afterXhigh = (await agent.request(methods.agent.session.setConfigOption, {
          sessionId: "agy-cfg",
          configId: "effort",
          type: "id",
          value: "xhigh",
        } as never)) as { configOptions: Array<{ configId: string; currentValue: string }> };
        expect(afterXhigh.configOptions.find((o) => o.configId === "effort")?.currentValue).toBe(
          "xhigh",
        );

        // Switching to gemini-4-carbon (no xhigh) resets effort to default.
        const afterCarbon = (await agent.request(methods.agent.session.setConfigOption, {
          sessionId: "agy-cfg",
          configId: "model",
          type: "id",
          value: "gemini-4-carbon",
        } as never)) as {
          configOptions: Array<{
            configId: string;
            currentValue: string;
            options: Array<{ value: string }>;
          }>;
        };
        expect(afterCarbon.configOptions.find((o) => o.configId === "model")?.currentValue).toBe(
          "gemini-4-carbon",
        );
        expect(afterCarbon.configOptions.find((o) => o.configId === "effort")?.currentValue).toBe(
          "default",
        );
        expect(
          afterCarbon.configOptions
            .find((o) => o.configId === "effort")
            ?.options.map((o) => o.value),
        ).toEqual(["default", "low", "medium", "high"]);

        // Switching to Orchestrator removes effort options and rejects explicit effort with -32602.
        const afterOrch = (await agent.request(methods.agent.session.setConfigOption, {
          sessionId: "agy-cfg",
          configId: "model",
          type: "id",
          value: "gemini-pro-orchestrator-neon",
        } as never)) as {
          configOptions: Array<{
            configId: string;
            currentValue: string;
            options: Array<{ value: string }>;
          }>;
        };
        expect(
          afterOrch.configOptions.find((o) => o.configId === "effort")?.options.map((o) => o.value),
        ).toEqual(["default"]);

        let effortErr: unknown;
        try {
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: "agy-cfg",
            configId: "effort",
            type: "id",
            value: "high",
          } as never);
        } catch (error) {
          effortErr = error;
        }
        expect((effortErr as { code?: number })?.code).toBe(-32602);

        // Setting model back to "default" calls v1 model with initial defaultModel and reports "default".
        const backDefault = (await agent.request(methods.agent.session.setConfigOption, {
          sessionId: "agy-cfg",
          configId: "model",
          type: "id",
          value: "default",
        } as never)) as { configOptions: Array<{ configId: string; currentValue: string }> };
        expect(backDefault.configOptions.find((o) => o.configId === "model")?.currentValue).toBe(
          "default",
        );
        expect(
          getFake()
            .requests.filter((r) => r.method === "session/set_config_option")
            .at(-1)?.params,
        ).toEqual({
          sessionId: "agy-cfg",
          configId: "model",
          value: "gemini-4-neon",
        });

        // Unknown configId rejected with -32602.
        let unknownErr: unknown;
        try {
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: "agy-cfg",
            configId: "nonexistent",
            type: "id",
            value: "foo",
          } as never);
        } catch (error) {
          unknownErr = error;
        }
        expect((unknownErr as { code?: number })?.code).toBe(-32602);

        // Unsolicited current_mode_update from agy translates into v2 config_option_update.
        const beforeCount = updates.length;
        await agent.request(methods.agent.session.prompt, {
          sessionId: "agy-cfg",
          prompt: [{ type: "text", text: "trigger mode update" }],
        } as never);
        await waitFor(() =>
          updates
            .slice(beforeCount)
            .some((u) => u.sessionUpdate === "state_update" && u.state === "idle"),
        );
        const modeNotif = updates
          .slice(beforeCount)
          .find((u) => u.sessionUpdate === "config_option_update") as
          | { configOptions?: Array<{ configId: string; currentValue: string }> }
          | undefined;
        expect(modeNotif?.configOptions?.find((o) => o.configId === "mode")?.currentValue).toBe(
          "plan",
        );
      });
    } finally {
      adapter.close();
    }
  });
});

describe("steer, elicitation, and autonomous turn fallback (CYCL-175)", () => {
  test("steer keeps single turn open across two v1 prompts, rotates assistant messageId, and rejects steer-when-idle and non-steer-when-busy", async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    const { config, getFake } = baseConfig((method, params, fake) => {
      if (method === "initialize") return defaultInitResult("1.5.15");
      if (method === "session/new") return defaultSessionResponse("agy-steer");
      if (method === "session/prompt") {
        const sid = (params as { sessionId: string }).sessionId;
        return new Promise((resolve) => {
          resolvers.push(resolve);
          if (resolvers.length === 1) {
            queueMicrotask(() => {
              fake.emitUpdate(sid, {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "first part" },
              });
            });
          } else if (resolvers.length === 2) {
            // Mirror real agy 1.5.15 steer behavior: first prompt resolves immediately, second carries the steered answer.
            queueMicrotask(() => {
              resolvers[0]?.({ stopReason: "end_turn" });
              fake.emitUpdate(sid, {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "steered reply" },
              });
              resolvers[1]?.({ stopReason: "end_turn" });
            });
          }
        });
      }
      return {};
    });

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

        // Steer when idle must reject with -32600.
        let idleSteerErr: unknown;
        try {
          await agent.request(methods.agent.session.prompt, {
            sessionId: "agy-steer",
            prompt: [{ type: "text", text: "too early" }],
            _meta: { [META.steer]: true },
          } as never);
        } catch (error) {
          idleSteerErr = error;
        }
        expect((idleSteerErr as { code?: number })?.code).toBe(-32600);

        // Start turn 1.
        await agent.request(methods.agent.session.prompt, {
          sessionId: "agy-steer",
          prompt: [{ type: "text", text: "start" }],
        } as never);
        await waitFor(() => updates.some((u) => u.sessionUpdate === "agent_message_chunk"));

        // Non-steer prompt while busy must reject with -32600.
        let busyErr: unknown;
        try {
          await agent.request(methods.agent.session.prompt, {
            sessionId: "agy-steer",
            prompt: [{ type: "text", text: "not a steer" }],
          } as never);
        } catch (error) {
          busyErr = error;
        }
        expect((busyErr as { code?: number })?.code).toBe(-32600);

        // Send steer prompt mid-turn.
        await agent.request(methods.agent.session.prompt, {
          sessionId: "agy-steer",
          prompt: [{ type: "text", text: "change direction" }],
          _meta: { [META.steer]: true },
        } as never);

        await waitFor(() =>
          updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"),
        );

        const chunks = updates.filter((u) => u.sessionUpdate === "agent_message_chunk") as Array<{
          messageId: string;
          content: { text?: string };
        }>;
        expect(chunks).toHaveLength(2);
        expect(chunks[0]?.messageId).not.toBe(chunks[1]?.messageId);
        expect(chunks[1]?.content.text).toBe("steered reply");

        const runningStates = updates.filter(
          (u) => u.sessionUpdate === "state_update" && u.state === "running",
        );
        const idleStates = updates.filter(
          (u) => u.sessionUpdate === "state_update" && u.state === "idle",
        );
        expect(runningStates).toHaveLength(1);
        expect(idleStates).toHaveLength(1);
        expect(getFake().requests.filter((r) => r.method === "session/prompt")).toHaveLength(2);
      });
    } finally {
      adapter.close();
    }
  });

  test("elicitation/create forwards forms, strips cycle/noClient to clean cancel, and aborts on session/cancel", async () => {
    const answers: unknown[] = [];
    let elicitationCount = 0;
    const { config, getFake } = baseConfig(
      (method, params, fake) => {
        if (method === "initialize") return defaultInitResult("1.5.15");
        if (method === "session/new") return defaultSessionResponse("agy-elicit");
        if (method === "session/prompt") {
          const sid = (params as { sessionId: string }).sessionId;
          const text = (params as { prompt: Array<{ text?: string }> }).prompt[0]?.text ?? "";
          if (text === "ask-two") {
            return (async () => {
              const first = await fake.askClient("elicitation/create", {
                sessionId: sid,
                toolCallId: "ask_1",
                mode: "form",
                message: "Pick a color",
                requestedSchema: { type: "object", properties: { q1: { type: "string" } } },
              });
              answers.push(first);
              const second = await fake.askClient("elicitation/create", {
                sessionId: sid,
                toolCallId: "ask_2",
                mode: "form",
                message: "No client attached",
                requestedSchema: { type: "object", properties: { q1: { type: "string" } } },
              });
              answers.push(second);
              return { stopReason: "end_turn" };
            })();
          }
          return new Promise(() => {
            queueMicrotask(async () => {
              fake.emitUpdate(sid, {
                sessionUpdate: "tool_call",
                toolCallId: "ask_hang",
                name: "ask_question",
                status: "pending",
              });
              const cancelled = await fake.askClient("elicitation/create", {
                sessionId: sid,
                toolCallId: "ask_hang",
                mode: "form",
                message: "Will cancel",
                requestedSchema: { type: "object", properties: {} },
              });
              answers.push(cancelled);
            });
          });
        }
        return {};
      },
      { cancelTimeoutMs: 40 },
    );

    const adapter = createAdapter(config);
    const updates: SessionUpdate[] = [];
    let thirdAsked = false;
    const app = client()
      .onNotification(methods.client.session.update, ({ params }) => {
        updates.push(params.update);
      })
      .onRequest(methods.client.elicitation.create, () => {
        elicitationCount += 1;
        if (elicitationCount === 1) {
          return { action: "accept", content: { q1: "blue" } } as never;
        }
        if (elicitationCount === 2) {
          return { action: "cancel", _meta: { [META.noClient]: true } } as never;
        }
        thirdAsked = true;
        return new Promise(() => {});
      });

    try {
      await app.connectWith(adapter.app, async (agent) => {
        await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: { elicitation: { form: {} } },
          info: { name: "test", version: "1" },
        } as never);
        const initReq = getFake().requests.find((r) => r.method === "initialize")?.params as {
          clientCapabilities?: { elicitation?: { form?: Record<string, unknown> } };
        };
        expect(initReq.clientCapabilities?.elicitation?.form).toEqual({});

        await agent.request(methods.agent.session.new, { cwd: "/tmp/work" } as never);
        await agent.request(methods.agent.session.prompt, {
          sessionId: "agy-elicit",
          prompt: [{ type: "text", text: "ask-two" }],
        } as never);
        await waitFor(() =>
          updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"),
        );

        expect(answers[0]).toEqual({ action: "accept", content: { q1: "blue" } });
        // Internal _meta["cycle/noClient"] must be stripped before reaching agy.
        expect(answers[1]).toEqual({ action: "cancel" });

        // Cancel mid-elicitation aborts request and closes dangling ask_question tool.
        const before = updates.length;
        await agent.request(methods.agent.session.prompt, {
          sessionId: "agy-elicit",
          prompt: [{ type: "text", text: "ask-cancel" }],
        } as never);
        await waitFor(() => thirdAsked);
        await agent.notify(methods.agent.session.cancel, { sessionId: "agy-elicit" } as never);
        await waitFor(() =>
          updates
            .slice(before)
            .some((u) => u.sessionUpdate === "state_update" && u.state === "idle"),
        );
        expect(answers[2]).toEqual({ action: "cancel" });
        expect(
          updates
            .slice(before)
            .some(
              (u) =>
                u.sessionUpdate === "tool_call_update" &&
                u.toolCallId === "ask_hang" &&
                u.status === "cancelled",
            ),
        ).toBe(true);
      });
    } finally {
      adapter.close();
    }
  });

  test("autonomous updates arriving while idle synthesize running -> idle without triggering on housekeeping updates", async () => {
    const { config, getFake } = baseConfig(
      (method) => {
        if (method === "initialize") return defaultInitResult("1.5.15");
        if (method === "session/new") return defaultSessionResponse("agy-auto");
        return {};
      },
      { autonomousIdleMs: 40 },
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

        // Housekeeping updates while idle must NOT start an autonomous turn.
        getFake().emitUpdate("agy-auto", { sessionUpdate: "usage_update", used: 100, size: 1000 });
        getFake().emitUpdate("agy-auto", {
          sessionUpdate: "session_info_update",
          title: "Background",
        });
        await Bun.sleep(60);
        expect(updates.some((u) => u.sessionUpdate === "state_update")).toBe(false);

        // Meaningful autonomous update starts a running turn, waits for open tool to complete, then idles.
        getFake().emitUpdate("agy-auto", {
          sessionUpdate: "tool_call",
          toolCallId: "bg_1",
          name: "run_command",
          status: "in_progress",
        });
        await waitFor(() =>
          updates.some((u) => u.sessionUpdate === "state_update" && u.state === "running"),
        );
        // Must stay running past autonomousIdleMs while bg_1 is still open.
        await Bun.sleep(70);
        expect(updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle")).toBe(
          false,
        );

        getFake().emitUpdate("agy-auto", {
          sessionUpdate: "tool_call_update",
          toolCallId: "bg_1",
          name: "run_command",
          status: "completed",
        });
        getFake().emitUpdate("agy-auto", {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Wakeup finished!" },
        });
        await waitFor(() =>
          updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"),
        );

        const states = updates
          .filter((u) => u.sessionUpdate === "state_update")
          .map((u) => (u as { state: string }).state);
        expect(states).toEqual(["running", "idle"]);
      });
    } finally {
      adapter.close();
    }
  });
});

describe("MCP server translation (CYCL-176)", () => {
  test("forwards http and stdio MCP servers on session/new and session/resume, and rejects sse with -32602", async () => {
    const { config, getFake } = baseConfig((method) => {
      if (method === "initialize") return defaultInitResult("1.5.15");
      if (method === "session/new") return defaultSessionResponse("agy-mcp");
      if (method === "session/resume") {
        const { sessionId: _omit, ...rest } = defaultSessionResponse("agy-mcp");
        return rest;
      }
      return {};
    });

    const adapter = createAdapter(config);
    const app = client();
    try {
      await app.connectWith(adapter.app, async (agent) => {
        const init = await agent.request(methods.agent.initialize, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: "test", version: "1" },
        });
        expect(init.capabilities?.session?.mcp?.http).toEqual({});
        expect(init.capabilities?.session?.mcp?.stdio).toEqual({});

        // SSE must be rejected with -32602 without silently dropping or calling agy.
        let sseErr: unknown;
        try {
          await agent.request(methods.agent.session.new, {
            cwd: "/tmp/work",
            mcpServers: [{ type: "sse", name: "legacy", url: "http://127.0.0.1:9999/sse" }],
          } as never);
        } catch (error) {
          sseErr = error;
        }
        expect((sseErr as { code?: number })?.code).toBe(-32602);
        expect(getFake().requests.some((r) => r.method === "session/new")).toBe(false);

        const servers = [
          {
            type: "http",
            name: "gateway-tool",
            url: "http://127.0.0.1:4321/mcp/c1",
            headers: [{ name: "Authorization", value: "Bearer gw-session-key" }],
          },
          {
            type: "stdio",
            name: "local-stdio",
            command: "/usr/bin/env",
            args: ["node", "server.js"],
            env: [{ name: "FOO", value: "bar" }],
          },
        ];

        await agent.request(methods.agent.session.new, {
          cwd: "/tmp/work",
          mcpServers: servers,
        } as never);
        const newReq = getFake().requests.find((r) => r.method === "session/new")?.params as {
          mcpServers: unknown[];
        };
        expect(newReq.mcpServers).toEqual([
          {
            type: "http",
            name: "gateway-tool",
            url: "http://127.0.0.1:4321/mcp/c1",
            headers: [{ name: "Authorization", value: "Bearer gw-session-key" }],
          },
          {
            name: "local-stdio",
            command: "/usr/bin/env",
            args: ["node", "server.js"],
            env: [{ name: "FOO", value: "bar" }],
          },
        ]);

        await agent.request(methods.agent.session.resume, {
          sessionId: "agy-mcp",
          cwd: "/tmp/work",
          mcpServers: servers,
        } as never);
        const resumeReq = getFake().requests.find((r) => r.method === "session/resume")?.params as {
          mcpServers: unknown[];
        };
        expect(resumeReq.mcpServers).toEqual(newReq.mcpServers);
      });
    } finally {
      adapter.close();
    }
  });
});

describe("attachments, tool results, and UI model replay (CYCL-177)", () => {
  test("rejects binary resource (PDF blob) and audio with -32602, and forwards image, text resource, and resource_link", async () => {
    const { config, getFake } = baseConfig((method) => {
      if (method === "initialize") return defaultInitResult("1.5.15");
      if (method === "session/new") return defaultSessionResponse("agy-att");
      if (method === "session/prompt") return { stopReason: "end_turn" };
      return {};
    });

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

        // Binary PDF resource (`blob`) must be rejected with -32602 before calling agy.
        let pdfErr: unknown;
        try {
          await agent.request(methods.agent.session.prompt, {
            sessionId: "agy-att",
            prompt: [
              { type: "text", text: "Read this PDF" },
              {
                type: "resource",
                resource: {
                  uri: "attachment:///spec.pdf",
                  mimeType: "application/pdf",
                  blob: "JVBERi0xLjQ=",
                },
              },
            ],
          } as never);
        } catch (error) {
          pdfErr = error;
        }
        expect((pdfErr as { code?: number })?.code).toBe(-32602);
        expect(getFake().requests.some((r) => r.method === "session/prompt")).toBe(false);

        // Audio block must be rejected with -32602.
        let audioErr: unknown;
        try {
          await agent.request(methods.agent.session.prompt, {
            sessionId: "agy-att",
            prompt: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }],
          } as never);
        } catch (error) {
          audioErr = error;
        }
        expect((audioErr as { code?: number })?.code).toBe(-32602);
        expect(getFake().requests.some((r) => r.method === "session/prompt")).toBe(false);

        // Valid image + text resource + resource_link pass through untouched.
        const validBlocks = [
          { type: "text", text: "Inspect these" },
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          {
            type: "resource",
            resource: {
              uri: "attachment:///notes.txt",
              mimeType: "text/plain",
              text: "hello from attachment",
            },
          },
          { type: "resource_link", uri: "file:///tmp/work/a.ts", name: "a.ts" },
        ];
        await agent.request(methods.agent.session.prompt, {
          sessionId: "agy-att",
          prompt: validBlocks,
        } as never);
        await waitFor(() =>
          updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"),
        );

        const promptReq = getFake().requests.find((r) => r.method === "session/prompt")?.params as {
          prompt: unknown[];
        };
        expect(promptReq.prompt).toEqual(validBlocks);
      });
    } finally {
      adapter.close();
    }
  });

  test("translates real agy turn (diffs, exit_code, usage, title, commands) so UI conversation model has ignored === 0", async () => {
    const { config } = baseConfig((method, params, fake) => {
      if (method === "initialize") return defaultInitResult("1.5.15");
      if (method === "session/new") return defaultSessionResponse("agy-ui");
      if (method === "session/prompt") {
        const sid = (params as { sessionId: string }).sessionId;
        return new Promise((resolve) => {
          queueMicrotask(() => {
            fake.emitUpdate(sid, {
              sessionUpdate: "available_commands_update",
              availableCommands: [
                { name: "compact", description: "Compact conversation" },
                { name: "review", description: "Review code" },
              ],
            });
            fake.emitUpdate(sid, {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "Checking file before editing." },
            });
            fake.emitUpdate(sid, {
              sessionUpdate: "tool_call",
              toolCallId: "read_1",
              name: "read_file",
              kind: "read",
              title: "Read /tmp/work/hello.txt",
              status: "completed",
              locations: [{ path: "/tmp/work/hello.txt" }],
            });
            fake.emitUpdate(sid, {
              sessionUpdate: "tool_call",
              toolCallId: "write_1",
              name: "write_file",
              kind: "edit",
              title: "Write /tmp/work/new.txt",
              status: "completed",
              locations: [{ path: "/tmp/work/new.txt" }],
              content: [
                {
                  type: "diff",
                  path: "/tmp/work/new.txt",
                  oldText: null,
                  newText: "alpha\nbeta\n",
                },
              ],
            });
            fake.emitUpdate(sid, {
              sessionUpdate: "tool_call",
              toolCallId: "edit_1",
              name: "edit_file",
              kind: "edit",
              title: "Edit /tmp/work/hello.txt",
              status: "completed",
              locations: [{ path: "/tmp/work/hello.txt" }],
              content: [
                {
                  type: "diff",
                  path: "/tmp/work/hello.txt",
                  oldText: "line1\nold\nline3\n",
                  newText: "line1\nnewA\nnewB\nline3\n",
                },
              ],
            });
            fake.emitUpdate(sid, {
              sessionUpdate: "tool_call",
              toolCallId: "run_1",
              name: "run_command",
              kind: "execute",
              title: "cat /tmp/work/hello.txt",
              status: "completed",
              rawInput: { CommandLine: "cat /tmp/work/hello.txt" },
              rawOutput: { output: "line1\r\nnewA\r\nnewB\r\nline3\r\n", exit_code: 0 },
              content: [
                {
                  type: "content",
                  content: { type: "text", text: "line1\r\nnewA\r\nnewB\r\nline3\r\n" },
                },
              ],
            });
            fake.emitUpdate(sid, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Updated hello.txt and created new.txt." },
            });
            fake.emitUpdate(sid, {
              sessionUpdate: "usage_update",
              used: 4200,
              size: 1048576,
            });
            fake.emitUpdate(sid, {
              sessionUpdate: "session_info_update",
              title: "Edit Hello And New",
            });
            resolve({ stopReason: "end_turn" });
          });
        });
      }
      return {};
    });

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
          sessionId: "agy-ui",
          prompt: [{ type: "text", text: "Edit hello.txt and write new.txt" }],
        } as never);
        await waitFor(() =>
          updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"),
        );
      });
    } finally {
      adapter.close();
    }

    // Validate every `_meta["cycle/toolResult"]` against Cycle's strict ToolResultSchema.
    for (const u of updates) {
      const meta = (u as { _meta?: Record<string, unknown> })._meta;
      if (meta && META.toolResult in meta) {
        expect(() => ToolResultSchema.parse(meta[META.toolResult])).not.toThrow();
      }
    }

    // Feed all translated updates into Cycle's UI conversation model.
    let conv = emptyConversation();
    for (const update of updates) {
      conv = applyUpdate(conv, update);
    }

    expect(conv.ignored).toBe(0);
    expect(updates).toContainEqual({
      sessionUpdate: "session_info_update",
      title: "Edit Hello And New",
    });
    expect(conv.usage).toEqual({ used: 4200, size: 1048576 });
    expect(conv.commands.map((c) => c.name)).toEqual(["compact", "review"]);

    const edits = sessionEdits(conv);
    expect(edits).toHaveLength(1);
    const files = edits[0]?.edits ?? [];
    expect(
      files.map((f) => ({
        path: f.path,
        additions: f.additions,
        deletions: f.deletions,
        created: f.created,
      })),
    ).toEqual([
      { path: "/tmp/work/new.txt", additions: 2, deletions: 0, created: true },
      { path: "/tmp/work/hello.txt", additions: 2, deletions: 1, created: false },
    ]);
    expect(files[0]?.lines?.length).toBeGreaterThan(0);
    expect(files[1]?.lines?.length).toBeGreaterThan(0);
  });
});

describe("sub-agent and background activity display (CYCL-178)", () => {
  test("displays invoke_subagent and schedule as plain tool calls in UI model with ignored === 0 and no fabricated subagent updates", async () => {
    const { config } = baseConfig((method, params, fake) => {
      if (method === "initialize") return defaultInitResult("1.5.15");
      if (method === "session/new") return defaultSessionResponse("agy-sub");
      if (method === "session/prompt") {
        const sid = (params as { sessionId: string }).sessionId;
        return new Promise((resolve) => {
          queueMicrotask(() => {
            fake.emitUpdate(sid, {
              sessionUpdate: "tool_call",
              toolCallId: "sub_1",
              name: "invoke_subagent",
              kind: "other",
              title: "invoke_subagent",
              status: "in_progress",
              rawInput: { TypeName: "research", Role: "Codebase Researcher", Prompt: "Find docs" },
            });
            fake.emitUpdate(sid, {
              sessionUpdate: "tool_call_update",
              toolCallId: "sub_1",
              name: "invoke_subagent",
              kind: "other",
              title: "invoke_subagent",
              status: "completed",
              rawInput: { TypeName: "research", Role: "Codebase Researcher", Prompt: "Find docs" },
            });
            fake.emitUpdate(sid, {
              sessionUpdate: "tool_call",
              toolCallId: "sched_1",
              name: "schedule",
              kind: "other",
              title: "Schedule 2s wakeup",
              status: "in_progress",
            });
            fake.emitUpdate(sid, {
              sessionUpdate: "tool_call_update",
              toolCallId: "sched_1",
              name: "schedule",
              kind: "other",
              title: "Schedule 2s wakeup",
              status: "completed",
            });
            fake.emitUpdate(sid, {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Sub-agent and timer both finished." },
            });
            resolve({ stopReason: "end_turn" });
          });
        });
      }
      return {};
    });

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
          sessionId: "agy-sub",
          prompt: [{ type: "text", text: "Run a sub-agent and a timer" }],
        } as never);
        await waitFor(() =>
          updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"),
        );
      });
    } finally {
      adapter.close();
    }

    // Must not fabricate subagent_update or child updates that agy ACP v1 never provides.
    expect(updates.some((u) => u.sessionUpdate === "subagent_update")).toBe(false);

    let conv = emptyConversation();
    for (const update of updates) {
      conv = applyUpdate(conv, update);
    }
    expect(conv.ignored).toBe(0);
    const tools = conv.items.filter((item) => item.kind === "tool");
    expect(tools.map((t) => ({ id: t.id, title: t.title, status: t.status }))).toEqual([
      { id: "sub_1", title: "Sub-agent: Codebase Researcher", status: "completed" },
      { id: "sched_1", title: "Schedule 2s wakeup", status: "completed" },
    ]);
  });
});
