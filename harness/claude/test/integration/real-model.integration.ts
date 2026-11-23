// The adapter against a real model. Not part of `bun run test:integration`: it spends a little of an
// account's quota, so it only runs when asked, with the credential given on purpose:
//
//   CYCLE_REAL_MODEL_TOKEN=<oauth token> bun run test:real     (in harness/claude)
//
// The token goes into the Claude process's environment and nowhere else: not the adapter's, not the
// log. The model is small (CYCLE_REAL_MODEL, default "haiku"). The assertions are loose, because a
// real model is not deterministic; what this is for is the printed report of what really happened.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods, type SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { tempConfigDir, withAdapter } from "./adapter-process.ts";

const token = process.env.CYCLE_REAL_MODEL_TOKEN;
const model = process.env.CYCLE_REAL_MODEL ?? "haiku";
const enabled = token !== undefined && token !== "";

let cwd: string;
beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "cycle-v1-real-cwd-"));
  await writeFile(join(cwd, "notes.txt"), "The secret word in this file is MARMALADE.\n");
});
afterAll(() => rm(cwd, { recursive: true, force: true }));

/** The only environment the Claude process gets. */
const claudeEnv = (configDir: string): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: configDir,
  CLAUDE_CONFIG_DIR: configDir,
  CLAUDE_CODE_OAUTH_TOKEN: token as string,
});

const say = (text: string) => [{ type: "text" as const, text }];
const kinds = (updates: SessionUpdate[]) => {
  const count: Record<string, number> = {};
  for (const u of updates) count[u.sessionUpdate] = (count[u.sessionUpdate] ?? 0) + 1;
  return count;
};
const agentText = (updates: SessionUpdate[]) =>
  updates
    .filter((u) => u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "agent_message")
    .map((u) => {
      const c = (u as unknown as { content: { text?: string } | { text?: string }[] }).content;
      return Array.isArray(c) ? c.map((b) => b.text ?? "").join("") : (c.text ?? "");
    })
    .join("");
const last = (updates: SessionUpdate[]) =>
  updates.filter((u) => (u as { stopReason?: string }).stopReason !== undefined).at(-1) as
    | { stopReason: string; error?: unknown }
    | undefined;

/** Ids for the tests below: UUIDs, which is all the SDK takes as a session id. */
const NEWID = (n: number) => `a000000${n}-aaaa-4bbb-8ccc-dddddddddddd`;
const ID = (n: number) => `1000000${n}-aaaa-4bbb-8ccc-dddddddddddd`;

test.skipIf(!enabled)(
  "a real turn: streamed text, how it ends, and every kind of update seen",
  async () => {
    const config = await tempConfigDir();
    try {
      await withAdapter(
        { configDir: config.dir, env: claudeEnv(config.dir) },
        async ({ agent, updates, idle }) => {
          await agent.request(methods.agent.session.new, {
            cwd,
            _meta: { "cycle/sessionId": ID(1) },
          });
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: ID(1),
            configId: "model",
            type: "id",
            value: model,
          } as never);
          const done = idle();
          const started = Date.now();
          await agent.request(methods.agent.session.prompt, {
            sessionId: ID(1),
            prompt: say("Reply with exactly the single word PINEAPPLE and nothing else."),
          });
          await done;
          console.log(`REAL turn: ${Date.now() - started} ms, model ${model}`);
          console.log("REAL update kinds:", JSON.stringify(kinds(updates)));
          console.log("REAL text:", JSON.stringify(agentText(updates)));
          console.log("REAL ended:", JSON.stringify(last(updates)));
          expect(last(updates)?.stopReason).toBe("end_turn");
          expect(agentText(updates).toUpperCase()).toContain("PINEAPPLE");

          // The second turn goes to the same process: it should not pay for a start.
          for (const n of [2, 3]) {
            const again = idle();
            const t = Date.now();
            await agent.request(methods.agent.session.prompt, {
              sessionId: ID(1),
              prompt: say("Reply with exactly the single word PINEAPPLE and nothing else."),
            });
            await again;
            console.log(`REAL turn ${n}: ${Date.now() - t} ms (same process)`);
            expect(last(updates)?.stopReason).toBe("end_turn");
          }
        },
      );
    } finally {
      await config.dispose();
    }
  },
  90_000,
);

test.skipIf(!enabled)(
  "a real tool call asks, and the answer decides: allow runs it, deny does not",
  async () => {
    for (const answer of ["allow", "deny"] as const) {
      const config = await tempConfigDir();
      const file = `real-model-${answer}.txt`;
      try {
        await withAdapter(
          { configDir: config.dir, env: claudeEnv(config.dir), onPermission: () => answer },
          async ({ agent, updates, permissions, idle }) => {
            const id = ID(answer === "allow" ? 2 : 3);
            await agent.request(methods.agent.session.new, {
              cwd,
              _meta: { "cycle/sessionId": id },
            });
            await agent.request(methods.agent.session.setConfigOption, {
              sessionId: id,
              configId: "model",
              type: "id",
              value: model,
            } as never);
            // The mode that asks first: new sessions start in auto, where this may not be asked about.
            await agent.request(methods.agent.session.setConfigOption, {
              sessionId: id,
              configId: "mode",
              type: "id",
              value: "default",
            } as never);
            const done = idle();
            await agent.request(methods.agent.session.prompt, {
              sessionId: id,
              prompt: say(
                `Use the Bash tool to run exactly: touch ${file}   Then reply with the word finished.`,
              ),
            });
            await done;
            console.log(`REAL ${answer}: kinds`, JSON.stringify(kinds(updates)));
            console.log(
              `REAL ${answer}: permission request`,
              JSON.stringify(permissions[0]).slice(0, 400),
            );
            const tools = updates.filter(
              (u) => u.sessionUpdate === "tool_call_update",
            ) as unknown as { name?: string; kind?: string; status?: string }[];
            console.log(
              `REAL ${answer}: tool updates`,
              JSON.stringify(tools.map((t) => [t.name, t.kind, t.status])),
            );
            console.log(
              `REAL ${answer}: ended`,
              JSON.stringify(last(updates)),
              "text:",
              JSON.stringify(agentText(updates)).slice(0, 200),
            );
            expect(permissions.length).toBeGreaterThan(0);
            expect(existsSync(join(cwd, file))).toBe(answer === "allow");
          },
        );
      } finally {
        await config.dispose();
      }
    }
  },
  120_000,
);

test.skipIf(!enabled)(
  "a real model reads a file, and a new process resumes the session with its context",
  async () => {
    const config = await tempConfigDir();
    const id = ID(4);
    try {
      await withAdapter(
        { configDir: config.dir, env: claudeEnv(config.dir) },
        async ({ agent, updates, idle }) => {
          await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: id,
            configId: "model",
            type: "id",
            value: model,
          } as never);
          const done = idle();
          await agent.request(methods.agent.session.prompt, {
            sessionId: id,
            prompt: say(
              "Read the file notes.txt with the Read tool and tell me the secret word in it.",
            ),
          });
          await done;
          console.log("REAL read: kinds", JSON.stringify(kinds(updates)));
          const tools = updates.filter(
            (u) => u.sessionUpdate === "tool_call_update",
          ) as unknown as { name?: string; kind?: string; status?: string; content?: unknown }[];
          console.log(
            "REAL read: tools",
            JSON.stringify(tools.map((t) => [t.name, t.kind, t.status])),
          );
          console.log(
            "REAL read: tool output shape",
            JSON.stringify(tools.find((t) => t.content)?.content).slice(0, 300),
          );
          console.log(
            "REAL read: ended",
            JSON.stringify(last(updates)),
            JSON.stringify(agentText(updates)).slice(0, 200),
          );
          expect(agentText(updates).toUpperCase()).toContain("MARMALADE");
        },
      );
      // The first process is gone. A second one has the same config directory and resumes the session.
      await withAdapter(
        { configDir: config.dir, env: claudeEnv(config.dir) },
        async ({ agent, updates, idle }) => {
          await agent.request(methods.agent.session.resume, { sessionId: id, cwd });
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: id,
            configId: "model",
            type: "id",
            value: model,
          } as never);
          const done = idle();
          await agent.request(methods.agent.session.prompt, {
            sessionId: id,
            prompt: say("What was the secret word? Answer with the word only."),
          });
          await done;
          console.log(
            "REAL resumed: ended",
            JSON.stringify(last(updates)),
            "text:",
            JSON.stringify(agentText(updates)),
          );
          expect(last(updates)?.stopReason).toBe("end_turn");
          expect(agentText(updates).toUpperCase()).toContain("MARMALADE");
        },
      );
    } finally {
      await config.dispose();
    }
  },
  150_000,
);

test.skipIf(!enabled)(
  "a real model stopped part way: cancel ends the turn promptly and nothing more arrives",
  async () => {
    const config = await tempConfigDir();
    const id = ID(5);
    try {
      await withAdapter(
        { configDir: config.dir, env: claudeEnv(config.dir) },
        async ({ agent, updates, idle }) => {
          await agent.request(methods.agent.session.new, { cwd, _meta: { "cycle/sessionId": id } });
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: id,
            configId: "model",
            type: "id",
            value: model,
          } as never);
          const done = idle();
          await agent.request(methods.agent.session.prompt, {
            sessionId: id,
            prompt: say("Count from 1 to 300, one number per line, with no other text."),
          });
          const started = Date.now();
          while (
            !updates.some((u) => u.sessionUpdate === "agent_message_chunk") &&
            Date.now() - started < 60_000
          )
            await Bun.sleep(20);
          const cancelledAt = Date.now();
          await agent.notify(methods.agent.session.cancel, { sessionId: id });
          await Promise.race([
            done,
            Bun.sleep(15_000).then(() =>
              Promise.reject(new Error("the turn did not end within 15s of the cancel")),
            ),
          ]);
          const took = Date.now() - cancelledAt;
          const seenAtEnd = updates.length;
          await Bun.sleep(3_000);
          console.log(
            `REAL cancel: ended ${took} ms after the cancel; ${updates.length - seenAtEnd} updates arrived afterwards`,
          );
          console.log("REAL cancel: ended", JSON.stringify(last(updates)));
          expect(last(updates)?.stopReason).toBe("cancelled");
          expect(updates.length).toBe(seenAtEnd);
          // And the session still works.
          const again = idle();
          await agent.request(methods.agent.session.prompt, {
            sessionId: id,
            prompt: say("Reply with the word OK."),
          });
          await again;
          console.log(
            "REAL after cancel: ended",
            JSON.stringify(last(updates)),
            JSON.stringify(agentText(updates)).slice(-60),
          );
          expect(last(updates)?.stopReason).toBe("end_turn");
        },
      );
    } finally {
      await config.dispose();
    }
  },
  150_000,
);

// ---- what was added with attachments, MCP, questions and titles (2026-11-18) ----

/** A solid-colour PNG, built here so there is no file to trust. */
const solidPng = (size: number, [r, g, b]: [number, number, number]): string => {
  const { deflateSync } = require("node:zlib") as typeof import("node:zlib");
  const crc = (buffer: Uint8Array) => {
    let c = ~0;
    for (const byte of buffer) {
      c ^= byte;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(size).fill([r, g, b]).flat())]);
  const raw = Buffer.concat(Array(size).fill(row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
};

const withModel = async <T>(
  extra: Partial<Parameters<typeof withAdapter>[0]>,
  body: Parameters<typeof withAdapter<T>>[1],
) => {
  const config = await tempConfigDir();
  try {
    return await withAdapter({ configDir: config.dir, env: claudeEnv(config.dir), ...extra }, body);
  } finally {
    await config.dispose();
  }
};

const setModel = (agent: { request: (m: never, p: never) => Promise<unknown> }, id: string) =>
  agent.request(
    methods.agent.session.setConfigOption as never,
    {
      sessionId: id,
      configId: "model",
      type: "id",
      value: model,
    } as never,
  );

test.skipIf(!enabled)(
  "a real model sees an image that was attached",
  async () => {
    await withModel({}, async ({ agent, updates, idle }) => {
      await agent.request(methods.agent.session.new, {
        cwd,
        _meta: { "cycle/sessionId": NEWID(0) },
      });
      await setModel(agent, NEWID(0));
      const done = idle();
      await agent.request(methods.agent.session.prompt, {
        sessionId: NEWID(0),
        prompt: [
          { type: "text", text: "What single colour fills this image? Answer with one word." },
          { type: "image", data: solidPng(64, [220, 20, 20]), mimeType: "image/png" },
        ],
      } as never);
      await done;
      console.log(
        "image: stop",
        JSON.stringify(last(updates)),
        "said:",
        agentText(updates).slice(0, 120),
      );
      expect(last(updates)?.stopReason).toBe("end_turn");
      expect(agentText(updates).toLowerCase()).toContain("red");
    });
  },
  120_000,
);

test.skipIf(!enabled)(
  "a real model uses a tool of an MCP server it was given, and the server got its env",
  async () => {
    const server = new URL("./mcp-server.ts", import.meta.url).pathname;
    await withModel(
      { onPermission: () => "allow" },
      async ({ agent, updates, idle, permissions }) => {
        await agent.request(methods.agent.session.new, {
          cwd,
          _meta: { "cycle/sessionId": NEWID(1) },
          mcpServers: [
            {
              name: "files",
              type: "stdio",
              command: process.execPath,
              args: [server],
              env: [{ name: "TOKEN", value: "banana" }],
            },
          ],
        } as never);
        await setModel(agent, NEWID(1));
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId: NEWID(1),
          prompt: say(
            "Call the tool whose name starts with token_ from the files MCP server (it takes no arguments), then tell me exactly the text it returned and the part of the tool name after token_.",
          ),
        });
        await done;
        const said = agentText(updates);
        console.log(
          "mcp: permissions",
          JSON.stringify(permissions.map((p) => (p as { title?: string }).title)),
          "said:",
          said.slice(0, 200),
        );
        expect(said).toContain("7731");
        expect(said.toLowerCase()).toContain("banana");
      },
    );
  },
  120_000,
);

test.skipIf(!enabled)(
  "a real model asks a question as a form, and uses the answer",
  async () => {
    await withModel(
      {
        onElicitation: () => ({ action: "accept", content: { q0: "blue" } }),
        onPermission: () => "allow",
      },
      async ({ agent, updates, idle, elicitations, permissions }) => {
        await agent.request(methods.agent.session.new, {
          cwd,
          _meta: { "cycle/sessionId": NEWID(2) },
        });
        await setModel(agent, NEWID(2));
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId: NEWID(2),
          prompt: say(
            "Use the AskUserQuestion tool to ask me which colour I prefer, with exactly two options: red and blue. Then tell me which colour I chose, in one sentence.",
          ),
        });
        await done;
        console.log(
          "ask: forms",
          elicitations.length,
          "permissions",
          permissions.length,
          "said:",
          agentText(updates).slice(0, 200),
        );
        console.log("ask: form was", JSON.stringify(elicitations[0]).slice(0, 400));
        expect(elicitations.length).toBeGreaterThan(0);
        expect(agentText(updates).toLowerCase()).toContain("blue");
      },
    );
  },
  120_000,
);

test.skipIf(!enabled)(
  "does a real session get a title from Claude? (a report: the answer is what we wanted to know)",
  async () => {
    await withModel({}, async ({ agent, updates, idle }) => {
      await agent.request(methods.agent.session.new, {
        cwd,
        _meta: { "cycle/sessionId": NEWID(3) },
      });
      await setModel(agent, NEWID(3));
      for (const text of [
        "I want to refactor the login form in our React app so it validates the email address before submitting. Where should I start?",
        "Thanks. And how should I test that?",
      ]) {
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId: NEWID(3),
          prompt: say(text),
        });
        await done;
        for (let waited = 0; waited < 20_000; waited += 500) {
          if (updates.some((u) => u.sessionUpdate === "session_info_update")) break;
          await Bun.sleep(500);
        }
      }
      const titles = updates.filter((u) => u.sessionUpdate === "session_info_update");
      console.log("title: updates", JSON.stringify(titles));
      console.log("update kinds", JSON.stringify(kinds(updates)));
    });
  },
  180_000,
);

test.skipIf(!enabled)(
  "a plan that is approved changes the mode, and the client is told (a report)",
  async () => {
    await withModel(
      { onPermission: () => "allow" },
      async ({ agent, updates, idle, permissions }) => {
        await agent.request(methods.agent.session.new, {
          cwd,
          _meta: { "cycle/sessionId": NEWID(4) },
        });
        await setModel(agent, NEWID(4));
        await agent.request(methods.agent.session.setConfigOption, {
          sessionId: NEWID(4),
          configId: "mode",
          type: "id",
          value: "plan",
        } as never);
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId: NEWID(4),
          prompt: say(
            "Make a two-step plan for adding a README.md to this folder, then present it for approval with the plan tool.",
          ),
        });
        await done;
        console.log(
          "plan: permissions",
          JSON.stringify(permissions.map((p) => (p as { title?: string }).title)),
        );
        console.log(
          "plan: config updates",
          JSON.stringify(
            updates
              .filter((u) => u.sessionUpdate === "config_option_update")
              .map((u) =>
                (
                  u as unknown as { configOptions: { configId: string; currentValue: string }[] }
                ).configOptions.map((o) => `${o.configId}=${o.currentValue}`),
              ),
          ),
        );
        console.log("plan: ended", JSON.stringify(last(updates)));
      },
    );
  },
  180_000,
);

test.skipIf(!enabled)(
  "a compaction is announced (a report)",
  async () => {
    await withModel({}, async ({ agent, updates, idle }) => {
      await agent.request(methods.agent.session.new, {
        cwd,
        _meta: { "cycle/sessionId": NEWID(5) },
      });
      await setModel(agent, NEWID(5));
      for (const text of ["Say OK.", "/compact"]) {
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId: NEWID(5),
          prompt: say(text),
        });
        await done;
      }
      await Bun.sleep(500);
      console.log(
        "compact: updates",
        JSON.stringify(updates.filter((u) => u.sessionUpdate === "compaction_update")),
      );
      console.log("compact: kinds", JSON.stringify(kinds(updates)));
      console.log("compact: ended", JSON.stringify(last(updates)), agentText(updates).slice(-160));
    });
  },
  180_000,
);

// ---- sub-agents, a warm start, what a person wrote, cost across processes (2026-11-18, second batch) ----

test.skipIf(!enabled)(
  "a real sub-agent is announced, makes progress, and ends",
  async () => {
    await withModel({}, async ({ agent, updates, idle }) => {
      await agent.request(methods.agent.session.new, {
        cwd,
        _meta: { "cycle/sessionId": NEWID(6) },
      });
      await setModel(agent, NEWID(6));
      const done = idle();
      await agent.request(methods.agent.session.prompt, {
        sessionId: NEWID(6),
        prompt: say(
          "Use the Agent tool (subagent_type Explore, in the foreground, not in the background) to read notes.txt in the current directory and report the secret word. Then tell me the word.",
        ),
      });
      await done;
      // A sub-agent can outlive the turn (it may run in the background): wait for its end.
      const ended = () =>
        updates.some(
          (u) =>
            u.sessionUpdate === "subagent_update" &&
            (u as unknown as { state?: { state: string } }).state?.state === "idle",
        );
      for (let waited = 0; waited < 60_000 && !ended(); waited += 500) await Bun.sleep(500);
      const subs = updates.filter((u) => u.sessionUpdate === "subagent_update");
      console.log("subagent: updates", JSON.stringify(subs).slice(0, 1500));
      console.log("subagent: said", agentText(updates).slice(0, 160));
      expect(subs.length).toBeGreaterThanOrEqual(2);
      const states = subs.map((u) => (u as unknown as { state?: { state: string } }).state?.state);
      expect(states[0]).toBe("running");
      expect(states.at(-1)).toBe("idle");
      const meta = (subs[0] as unknown as { _meta: Record<string, { toolCallId?: string }> })._meta;
      expect(meta["cycle/subagent"]?.toolCallId).toBeDefined();
      expect(agentText(updates).toUpperCase()).toContain("MARMALADE");
    });
  },
  240_000,
);

test.skipIf(!enabled)(
  "with warmStart a real new session has its commands before the first prompt",
  async () => {
    await withModel({ adapter: { warmStart: true } }, async ({ agent, updates, idle }) => {
      await agent.request(methods.agent.session.new, {
        cwd,
        _meta: { "cycle/sessionId": NEWID(7) },
      });
      const started = Date.now();
      while (
        !updates.some((u) => u.sessionUpdate === "available_commands_update") &&
        Date.now() - started < 30_000
      ) {
        await Bun.sleep(100);
      }
      console.log("warm: commands after", Date.now() - started, "ms, no prompt sent");
      expect(updates.some((u) => u.sessionUpdate === "available_commands_update")).toBe(true);
      await setModel(agent, NEWID(7));
      const done = idle();
      const t = Date.now();
      await agent.request(methods.agent.session.prompt, {
        sessionId: NEWID(7),
        prompt: say("Reply with exactly the single word PINEAPPLE and nothing else."),
      });
      await done;
      console.log("warm: first prompt took", Date.now() - t, "ms");
      expect(last(updates)?.stopReason).toBe("end_turn");
      expect(agentText(updates).toUpperCase()).toContain("PINEAPPLE");
    });
  },
  120_000,
);

test.skipIf(!enabled)(
  "a real model is given what a person wrote in the form as the answer",
  async () => {
    await withModel(
      {
        onElicitation: () => ({ action: "accept", content: { q0_other: "green" } }),
      },
      async ({ agent, updates, idle, elicitations }) => {
        await agent.request(methods.agent.session.new, {
          cwd,
          _meta: { "cycle/sessionId": NEWID(8) },
        });
        await setModel(agent, NEWID(8));
        const done = idle();
        await agent.request(methods.agent.session.prompt, {
          sessionId: NEWID(8),
          prompt: say(
            "Use the AskUserQuestion tool to ask me which colour I prefer, with exactly two options: red and blue. Then tell me which colour I chose, in one sentence.",
          ),
        });
        await done;
        console.log("other: forms", elicitations.length, "said:", agentText(updates).slice(0, 200));
        expect(elicitations.length).toBeGreaterThan(0);
        expect(agentText(updates).toLowerCase()).toContain("green");
      },
    );
  },
  120_000,
);

test.skipIf(!enabled)(
  "the session's cost keeps adding up across a process that was let go and a new one",
  async () => {
    const config = await tempConfigDir();
    const costs: number[] = [];
    const costOf = (updates: SessionUpdate[]) =>
      (
        updates.filter((u) => u.sessionUpdate === "usage_update").at(-1) as
          | { cost?: { amount: number } }
          | undefined
      )?.cost?.amount;
    try {
      for (const resume of [false, true]) {
        await withAdapter(
          { configDir: config.dir, env: claudeEnv(config.dir) },
          async ({ agent, updates, idle }) => {
            if (resume) {
              await agent.request(methods.agent.session.resume, { sessionId: NEWID(9), cwd });
            } else {
              await agent.request(methods.agent.session.new, {
                cwd,
                _meta: { "cycle/sessionId": NEWID(9) },
              });
            }
            await setModel(agent, NEWID(9));
            const done = idle();
            await agent.request(methods.agent.session.prompt, {
              sessionId: NEWID(9),
              prompt: say("Reply with exactly the single word PINEAPPLE and nothing else."),
            });
            await done;
            const usage = updates.filter((u) => u.sessionUpdate === "usage_update");
            console.log(resume ? "cost: resumed" : "cost: first", JSON.stringify(usage.at(-1)));
            costs.push(costOf(updates) ?? Number.NaN);
          },
        );
      }
    } finally {
      await config.dispose();
    }
    console.log("cost: per process", JSON.stringify(costs));
    expect(costs[0]).toBeGreaterThan(0);
    // A new process continues from what the session cost before, as the SDK says it does.
    expect(costs[1]).toBeGreaterThan(costs[0] as number);
  },
  180_000,
);

test.skipIf(!enabled)(
  "real file tools and a failing command say what they did: a diff, counts, output and errors apart (CYCL-14, a report)",
  async () => {
    const config = await tempConfigDir();
    await writeFile(join(cwd, "fruit.txt"), "apple\nbanana\ncherry\n");
    try {
      await withAdapter(
        { configDir: config.dir, env: claudeEnv(config.dir), onPermission: () => "allow" },
        async ({ agent, updates, idle }) => {
          const id = ID(6);
          await agent.request(methods.agent.session.new, {
            cwd,
            _meta: { "cycle/sessionId": id },
          });
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: id,
            configId: "model",
            type: "id",
            value: model,
          } as never);
          const done = idle();
          await agent.request(methods.agent.session.prompt, {
            sessionId: id,
            prompt: say(
              [
                "Do these four steps in order, each with the tool named, and nothing else:",
                "1. Read the file fruit.txt.",
                "2. Edit fruit.txt: replace the line banana with the two lines blueberry and blackberry.",
                "3. Bash: run exactly  ls no-such-file-here  (it will fail; that is expected).",
                "4. Grep for the pattern 'berry' in fruit.txt, counting matches (output_mode count).",
                "Then reply with the word finished.",
              ].join("\n"),
            ),
          });
          await done;
          const results = updates.filter(
            (u) =>
              u.sessionUpdate === "tool_call_update" &&
              ((u as { status?: string }).status === "completed" ||
                (u as { status?: string }).status === "failed"),
          ) as unknown as Record<string, unknown>[];
          const names = new Map<string, string>();
          for (const u of updates as unknown as Record<string, unknown>[]) {
            if (typeof u.name === "string") names.set(String(u.toolCallId), u.name);
          }
          for (const r of results) {
            console.log(
              "REAL tools:",
              names.get(String(r.toolCallId)),
              r.status,
              JSON.stringify({
                content: r.content,
                meta: r._meta,
                locations: r.locations,
                rawOutput: r.rawOutput,
              }).slice(0, 900),
            );
          }
          const metaOf = (name: string, status = "completed") =>
            results
              .filter((r) => names.get(String(r.toolCallId)) === name && r.status === status)
              .map((r) => (r._meta as Record<string, unknown> | undefined)?.["cycle/toolResult"]);
          expect(metaOf("Edit")[0]).toMatchObject({ edit: { additions: 2, deletions: 1 } });
          // The SDK counts the empty line after the last newline: three lines read as four.
          expect(metaOf("Read")[0]).toMatchObject({ read: { startLine: 1 } });
          // A real model does not always do every step: what it did is checked, what it skipped is said.
          const failed = metaOf("Bash", "failed")[0];
          // `ls` of a missing file: 2 on GNU, 1 on macOS. What matters is that the code came through.
          if (failed === undefined) console.log("REAL tools: the model ran no failing command");
          else expect((failed as { run: { exitCode: number } }).run.exitCode).toBeGreaterThan(0);
        },
      );
    } finally {
      await config.dispose();
    }
  },
  180_000,
);

test.skipIf(!enabled)(
  "real web tools say what they found: a search's hits as links, a fetch's status (CYCL-14, a report)",
  async () => {
    const config = await tempConfigDir();
    try {
      await withAdapter(
        { configDir: config.dir, env: claudeEnv(config.dir), onPermission: () => "allow" },
        async ({ agent, updates, idle }) => {
          const id = ID(7);
          await agent.request(methods.agent.session.new, {
            cwd,
            _meta: { "cycle/sessionId": id },
          });
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: id,
            configId: "model",
            type: "id",
            value: model,
          } as never);
          const done = idle();
          await agent.request(methods.agent.session.prompt, {
            sessionId: id,
            prompt: say(
              [
                "Do these two steps, each with the tool named, and nothing else:",
                "1. WebSearch for: bun test runner documentation",
                "2. WebFetch the URL https://example.com with the prompt: What is the page's heading?",
                "Then reply with the word finished.",
              ].join("\n"),
            ),
          });
          await done;
          const names = new Map<string, string>();
          for (const u of updates as unknown as Record<string, unknown>[]) {
            if (typeof u.name === "string") names.set(String(u.toolCallId), u.name);
          }
          const ended = (updates as unknown as Record<string, unknown>[]).filter(
            (u) =>
              u.sessionUpdate === "tool_call_update" &&
              (u.status === "completed" || u.status === "failed"),
          );
          for (const r of ended) {
            console.log(
              "REAL web:",
              names.get(String(r.toolCallId)),
              r.status,
              JSON.stringify({ kind: r.kind, content: r.content, meta: r._meta }).slice(0, 900),
            );
          }
          const of = (name: string) =>
            ended.filter((r) => names.get(String(r.toolCallId)) === name);
          // A real model does not always do every step: what it did is checked, what it skipped is said.
          const [search] = of("WebSearch");
          if (search === undefined) console.log("REAL web: the model made no web search");
          else if (search.status === "completed") {
            const links = (search.content as { content?: { type?: string } }[]).filter(
              (c) => c.content?.type === "resource_link",
            );
            console.log("REAL web: search links", links.length);
            expect(links.length).toBeGreaterThan(0);
          }
          const [fetched] = of("WebFetch");
          if (fetched === undefined) console.log("REAL web: the model fetched nothing");
          else
            expect(fetched._meta).toMatchObject({
              "cycle/toolResult": { fetch: { status: expect.any(Number) } },
            });
        },
      );
    } finally {
      await config.dispose();
    }
  },
  180_000,
);

test.skipIf(!enabled)(
  "real background tasks: a command and a Monitor are told from start to end, and the process waits for them (CYCL-120)",
  async () => {
    const config = await tempConfigDir();
    try {
      await withAdapter(
        {
          configDir: config.dir,
          env: claudeEnv(config.dir),
          onPermission: () => "allow",
          // Short, so that a process let go while its tasks run would show as their being stopped.
          adapter: { idleMs: 1_000 },
        },
        async ({ agent, updates, idle }) => {
          const id = ID(8);
          await agent.request(methods.agent.session.new, {
            cwd,
            _meta: { "cycle/sessionId": id },
          });
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: id,
            configId: "model",
            type: "id",
            value: model,
          } as never);
          const done = idle();
          await agent.request(methods.agent.session.prompt, {
            sessionId: id,
            prompt: say(
              [
                "Do exactly these two things, then end your turn without waiting for either:",
                "1. Use the Bash tool with run_in_background set to true to run: for i in 1 2 3; do echo tick $i; sleep 3; done",
                "2. Use the Monitor tool to watch the command: for i in 1 2; do echo beat $i; sleep 4; done",
              ].join("\n"),
            ),
          });
          await done;
          const tasks = () =>
            (updates as unknown as Record<string, unknown>[]).filter(
              (u) => u.sessionUpdate === "_cycle/task_update",
            );
          const ends = ["completed", "failed", "stopped", "unknown"];
          const settled = () => {
            const ids = new Set(tasks().map((u) => String(u.taskId)));
            return (
              ids.size > 0 &&
              [...ids].every((t) =>
                tasks().some((u) => u.taskId === t && ends.includes(String(u.state))),
              )
            );
          };
          const start = Date.now();
          while (!settled() && Date.now() - start < 60_000) await Bun.sleep(250);
          for (const u of tasks()) console.log("REAL task:", JSON.stringify(u));
          // Which task is which is told by the call that started it, not by the kind under test.
          const monitorCall = (updates as unknown as Record<string, unknown>[]).find(
            (u) => u.sessionUpdate === "tool_call_update" && u.name === "Monitor",
          )?.toolCallId;
          const byTask = new Map<string, Record<string, unknown>>();
          for (const u of tasks()) {
            const id = String(u.taskId);
            byTask.set(id, { ...byTask.get(id), ...u });
          }
          const final = [...byTask.values()];
          console.log("REAL tasks, merged as a client would:", JSON.stringify(final));
          // A real model does not always do every step: what it did is checked, what it skipped is said.
          const shell = final.find(
            (t) => t.toolCallId !== undefined && t.toolCallId !== monitorCall,
          );
          const monitor = final.find(
            (t) => monitorCall !== undefined && t.toolCallId === monitorCall,
          );
          if (shell === undefined) console.log("REAL task: the model ran no background command");
          else expect(shell).toMatchObject({ kind: "shell", state: "completed" });
          if (monitorCall === undefined) console.log("REAL task: the model started no Monitor");
          else expect(monitor).toMatchObject({ kind: "monitor", state: "completed" });
          expect(final.length).toBeGreaterThan(0);
        },
      );
    } finally {
      await config.dispose();
    }
  },
  120_000,
);

test.skipIf(!enabled)(
  "real ScheduleWakeup: a process that would be let go is kept for the wakeup, which fires (CYCL-145)",
  async () => {
    const config = await tempConfigDir();
    try {
      await withAdapter(
        {
          configDir: config.dir,
          env: claudeEnv(config.dir),
          onPermission: () => "allow",
          // Far shorter than the wakeup: without the cron keeping it, the process goes first and the wakeup with it.
          adapter: { idleMs: 1_000 },
        },
        async ({ agent, updates, idle }) => {
          const id = "c1450000-aaaa-4bbb-8ccc-dddddddddddd";
          await agent.request(methods.agent.session.new, {
            cwd,
            _meta: { "cycle/sessionId": id },
          });
          await setModel(agent as never, id);
          const done = idle();
          await agent.request(methods.agent.session.prompt, {
            sessionId: id,
            prompt: say(
              [
                "Do exactly this, then end your turn: load the ScheduleWakeup tool with ToolSearch, then call it with",
                'delaySeconds 60, reason "test", prompt "Reply with the single word WOKE", noop false.',
                "When you are woken, reply with only the word WOKE.",
              ].join(" "),
            ),
          });
          await done;
          const asked = (updates as unknown as Record<string, unknown>[]).some(
            (u) => u.sessionUpdate === "tool_call_update" && u.name === "ScheduleWakeup",
          );
          // Without a wakeup there is nothing to keep the process for: this would pass and test nothing.
          expect(asked).toBe(true);
          const before = agentText(updates).length;
          const start = Date.now();
          // The wakeup fires on the minute after its delay: up to two minutes away, and its turn takes a while.
          while (!agentText(updates).slice(before).toUpperCase().includes("WOKE")) {
            if (Date.now() - start > 200_000) break;
            await Bun.sleep(500);
          }
          const woke = agentText(updates).slice(before).toUpperCase().includes("WOKE");
          const waited = Math.round((Date.now() - start) / 1000);
          console.log(
            woke ? `REAL wakeup: woke after ${waited} s` : `REAL wakeup: not woken in ${waited} s`,
          );
          expect(woke).toBe(true);
        },
      );
    } finally {
      await config.dispose();
    }
  },
  300_000,
);

test.skipIf(!enabled)(
  "real /goal: not delivered to a local process today; checked whole the day it is (CYCL-120, CYCL-121)",
  async () => {
    const config = await tempConfigDir();
    try {
      await withAdapter(
        { configDir: config.dir, env: claudeEnv(config.dir), onPermission: () => "allow" },
        async ({ agent, updates, idle }) => {
          const id = ID(9);
          // Its own directory: the file it counts in is the signal, and must not be left by another test.
          const goalCwd = await mkdtemp(join(tmpdir(), "cycle-v1-real-goal-"));
          await agent.request(methods.agent.session.new, {
            cwd: goalCwd,
            _meta: { "cycle/sessionId": id },
          });
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: id,
            configId: "model",
            type: "id",
            value: model,
          } as never);
          const done = idle();
          await agent.request(methods.agent.session.prompt, {
            sessionId: id,
            prompt: say(
              "/goal The file goal-count.txt in the current directory contains the number 2. Rule: each turn you may only add 1 to the number in it (start from 1 if missing), then end your turn.",
            ),
          });
          await done;
          // The goal's own turns follow the first: done when the count is 2 and the session is idle again.
          const count = join(goalCwd, "goal-count.txt");
          const lastState = () =>
            (updates as unknown as Record<string, unknown>[])
              .filter((u) => u.sessionUpdate === "state_update")
              .at(-1)?.state;
          const finished = async () =>
            existsSync(count) &&
            (await Bun.file(count).text()).trim() === "2" &&
            lastState() === "idle";
          const start = Date.now();
          while (!(await finished()) && Date.now() - start < 90_000) await Bun.sleep(250);
          await rm(goalCwd, { recursive: true, force: true });
          const goals = (updates as unknown as Record<string, unknown>[]).filter(
            (u) => u.sessionUpdate === "_cycle/goal_update",
          );
          for (const g of goals) console.log("REAL goal:", JSON.stringify(g));
          // SDK 0.3.327 sends active_goal only to a process with CLAUDE_CODE_REMOTE set, which the adapter does not
          // set (.agents/notes/2026-11-22-claude-goal-not-supported.md). When this starts printing updates, CYCL-121.
          if (goals.length === 0) {
            console.log("REAL goal: not delivered to a local process (CYCL-121)");
            return;
          }
          const set = goals.find((g) => g.goal !== null) as
            | { goal: Record<string, unknown> }
            | undefined;
          expect(set).toBeDefined();
          expect(set?.goal).toMatchObject({ condition: expect.any(String), iterations: 0 });
          expect(goals.at(-1)?.goal).toBeNull();
        },
      );
    } finally {
      await config.dispose();
    }
  },
  150_000,
);
