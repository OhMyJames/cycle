import { afterEach, beforeEach, expect, test } from "bun:test";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { PROMPT_LIMITS } from "@cycle/protocol";
import { Daemon, indexPath, sessionsDir } from "../src/index.ts";
import { connectClient, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

let dir: string;
let dispose: () => Promise<void>;
let open: Daemon[] = [];
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(async () => {
  for (const daemon of open) await daemon.close();
  open = [];
  await dispose();
});

const start = async (fake = fakeAgent()) => {
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  open.push(daemon);
  return { daemon, fake };
};

const text = (value: string) => [{ type: "text" as const, text: value }];
const png = Buffer.from("not really a png").toString("base64");
const image = { type: "image" as const, data: png, mimeType: "image/png" };
const both = { image: {}, embeddedContext: {} };

const sessionRow = async (c: Awaited<ReturnType<typeof connectClient>>) =>
  ((await c.agent.request(methods.agent.session.list, {})).sessions[0]?._meta ?? {}) as Record<
    string,
    unknown
  >;

// ---- attachments ----

test("an agent's prompt capabilities are in the agent list", async () => {
  const { daemon } = await start(fakeAgent({}, { promptCapabilities: both }));
  const c = await connectClient(daemon);
  const listed = (await c.agent.request("_cycle/agents/list", {})) as {
    agents: { id: string; promptCapabilities?: unknown }[];
  };
  expect(listed.agents[0]?.promptCapabilities).toEqual(both);
});

test("a big image is kept beside the log, comes back whole for the next client and after a restart, and goes with the session", async () => {
  const big = { ...image, data: Buffer.alloc(300_000, 7).toString("base64") };
  const { daemon, fake } = await start(fakeAgent({}, { promptCapabilities: both }));
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "look" }, big],
  });
  await until(() => c.idle() >= 2, "the turn to end");
  // The agent got the bytes, and so did the client that was watching.
  expect(fake.log.blocks[0]).toEqual([{ type: "text", text: "look" }, big]);
  const live = c.seen.find((s) => s.update.sessionUpdate === "user_message")?.update as unknown as {
    content: unknown[];
  };
  expect(live.content).toEqual([{ type: "text", text: "look" }, big]);
  // On disk: a small log and one blob file.
  const logFile = join(sessionsDir(dir), `${sessionId}.jsonl`);
  expect((await stat(logFile)).size).toBeLessThan(20_000);
  expect(await readdir(join(dir, "blobs", sessionId))).toHaveLength(1);

  await daemon.close();
  open = [];
  const again = await start();
  const later = await connectClient(again.daemon);
  await later.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  });
  await until(() => later.kinds().includes("replay_complete"), "the history");
  const replayed = later.seen.find((s) => s.update.sessionUpdate === "user_message")
    ?.update as unknown as { content: unknown[] };
  expect(replayed.content).toEqual([{ type: "text", text: "look" }, big]);

  await later.agent.request(methods.agent.session.delete, { sessionId });
  await expect(readdir(join(dir, "blobs", sessionId))).rejects.toThrow();
  await expect(stat(logFile)).rejects.toThrow();
});

test("an image reaches an agent that takes images, and is in the history for the next client", async () => {
  const { daemon, fake } = await start(fakeAgent({}, { promptCapabilities: both }));
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "text", text: "look" }, image],
  });
  await until(() => c.idle() >= 2, "the turn to end");
  expect(fake.log.blocks[0]).toEqual([{ type: "text", text: "look" }, image]);

  const later = await connectClient(daemon);
  await later.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  });
  await until(() => later.kinds().includes("user_message"), "the history");
  const user = later.seen.find((s) => s.update.sessionUpdate === "user_message")
    ?.update as unknown as {
    content: unknown[];
  };
  expect(user.content).toEqual([{ type: "text", text: "look" }, image]);
});

test("a prompt the agent cannot take is refused whole: nothing is started, written or sent", async () => {
  const { daemon, fake } = await start(fakeAgent({}, { promptCapabilities: { image: {} } }));
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  const launches = fake.log.launches;
  const refuse = async (prompt: unknown[], reason: string) =>
    expect(
      c.agent.request(methods.agent.session.prompt, { sessionId, prompt } as never),
    ).rejects.toMatchObject({ code: -32602, data: { reason, sessionId } });

  await refuse(
    [
      { type: "text", text: "a" },
      { type: "audio", data: "AAAA", mimeType: "audio/wav" },
    ],
    "unsupported_block",
  );
  await refuse(
    [{ type: "resource", resource: { uri: "file:///a", text: "x" } }],
    "unsupported_block",
  ); // no embeddedContext
  await refuse([{ ...image, mimeType: "image/bmp" }], "unsupported_media_type");
  await refuse(
    [{ ...image, data: Buffer.alloc(PROMPT_LIMITS.blockBytes + 1).toString("base64") }],
    "block_too_large",
  );
  expect(fake.log.prompts).toEqual([]);
  expect(fake.log.launches).toBe(launches);
  expect(c.kinds()).toEqual([]);
  // The data says which block.
  await expect(
    c.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [...text("a"), { ...image, data: "!!" }],
    } as never),
  ).rejects.toMatchObject({ data: { reason: "invalid_base64", index: 1 } });
});

test("an agent that says nothing about prompt capabilities takes text and links, not images", async () => {
  const { daemon } = await start();
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await expect(
    c.agent.request(methods.agent.session.prompt, { sessionId, prompt: [image] } as never),
  ).rejects.toMatchObject({ code: -32602 });
  await c.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: [{ type: "resource_link", name: "a", uri: "file:///a" }],
  } as never);
});

// ---- what a session is made with ----

const setup = {
  mcpServers: [
    {
      name: "files",
      type: "stdio" as const,
      command: "/usr/bin/files-mcp",
      args: [],
      env: [{ name: "TOKEN", value: "s3cret-token" }],
    },
  ],
  systemPrompt: { mode: "append", content: [{ type: "text" as const, text: "Be brief." }] },
};

test("directories, MCP servers and system prompt are sent to the agent, kept, and sent again when it restarts", async () => {
  const { daemon, fake } = await start();
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, {
    cwd: "/tmp",
    additionalDirectories: [dir],
    ...setup,
  } as never);
  expect(fake.log.news[0]).toMatchObject({ cwd: "/tmp", additionalDirectories: [dir], ...setup });

  // The agent goes away (it was let go, or crashed); the next prompt starts another.
  fake.crash();
  await Bun.sleep(30);
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("again") });
  await until(() => fake.log.resumes.length === 1, "the agent to be resumed");
  expect(fake.log.resumes[0]).toMatchObject({
    sessionId,
    cwd: "/tmp",
    additionalDirectories: [dir],
    ...setup,
  });
});

const modeOption = (value: string) => ({
  configId: "mode",
  name: "Mode",
  type: "select",
  currentValue: value,
  options: [{ value, name: value }],
});

test("session/new answers with the settings after what was asked for is applied", async () => {
  const { daemon } = await start(fakeAgent({}, { configOptions: [modeOption("auto")] }));
  const c = await connectClient(daemon);
  const created = await c.agent.request(methods.agent.session.new, {
    cwd: "/tmp",
    _meta: { "cycle/config": { mode: "plan" } },
  });
  expect(created.configOptions).toMatchObject([{ configId: "mode", currentValue: "plan" }]);
});

test("a setting not on record is recorded as the agent resumed it", async () => {
  // A session made before the daemon recorded what sessions start with: nothing on record.
  const fake = fakeAgent({}, { resumeConfigOptions: [modeOption("default")] });
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  expect((await sessionRow(c))["cycle/config"]).toBeUndefined();
  fake.crash();
  await Bun.sleep(30);
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("again") });
  await until(() => fake.log.resumes.length === 1, "the agent to be resumed");
  // The record is written behind the resume: look a few times, for no more than a second.
  let config: unknown;
  for (let i = 0; i < 50; i++) {
    config = (await sessionRow(c))["cycle/config"];
    if (config !== undefined) break;
    await Bun.sleep(20);
  }
  expect(config).toEqual({ mode: "default" });
});

test("a saved setting the agent refuses on resume is not left on record as in force, and the conversation says so", async () => {
  const fake = fakeAgent(
    {},
    { configOptions: [modeOption("auto")], resumeConfigOptions: [modeOption("auto")] },
  );
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, {
    cwd: "/tmp",
    _meta: { "cycle/config": { mode: "plan" } },
  });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  expect((await sessionRow(c))["cycle/config"]).toEqual({ mode: "plan" });

  // The agent is updated and no longer takes "plan"; it resumes the session in "auto".
  fake.control.rejectConfig.add("mode");
  fake.crash();
  await Bun.sleep(30);
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("again") });
  await until(() => fake.log.resumes.length === 1, "the agent to be resumed");

  await until(
    () =>
      c.seen.some(
        (s) =>
          s.update.sessionUpdate === "notice" &&
          String((s.update as { title?: unknown }).title).includes('"plan"'),
      ),
    "the conversation to say the setting was not restored",
  );
  expect((await sessionRow(c))["cycle/config"]).toEqual({ mode: "auto" });
});

test("a saved setting the agent no longer has is dropped from the record, with a notice that says so", async () => {
  const fake = fakeAgent(
    {},
    {
      configOptions: [modeOption("auto")],
      // After the update the agent has other settings, and not "mode".
      resumeConfigOptions: [{ ...modeOption("opus"), configId: "model" }],
    },
  );
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, {
    cwd: "/tmp",
    _meta: { "cycle/config": { mode: "plan" } },
  });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });

  fake.control.rejectConfig.add("mode");
  fake.crash();
  await Bun.sleep(30);
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("again") });

  await until(
    () =>
      c.seen.some(
        (s) =>
          s.update.sessionUpdate === "notice" &&
          String((s.update as { title?: unknown }).title).includes("no longer has"),
      ),
    "the conversation to say the setting is gone",
  );
  const config = (await sessionRow(c))["cycle/config"] as Record<string, string>;
  expect(config.mode).toBeUndefined();
});

test("the setup survives a new daemon, and a session without one sends none", async () => {
  const first = await start();
  const c = await connectClient(first.daemon);
  const withSetup = await c.agent.request(methods.agent.session.new, {
    cwd: "/tmp",
    ...setup,
  } as never);
  const plain = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await first.daemon.close();
  open = [];

  const second = await start();
  const d = await connectClient(second.daemon);
  await d.agent.request(methods.agent.session.prompt, {
    sessionId: withSetup.sessionId,
    prompt: text("hi"),
  });
  await d.agent.request(methods.agent.session.prompt, {
    sessionId: plain.sessionId,
    prompt: text("hi"),
  });
  await until(() => second.fake.log.resumes.length === 2, "both to be resumed");
  expect(second.fake.log.resumes[0]).toMatchObject(setup);
  expect(second.fake.log.resumes[1]).not.toHaveProperty("mcpServers");
  expect(second.fake.log.resumes[1]).not.toHaveProperty("systemPrompt");
  expect(second.fake.log.resumes[1]).not.toHaveProperty("additionalDirectories");
});

test("a server's secrets are in the index and nowhere else: not in the list, not in the log", async () => {
  const { daemon } = await start();
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, {
    cwd: "/tmp",
    ...setup,
  } as never);
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("hi") });
  await until(() => c.ended() >= 1, "the turn to end");

  const everywhere = JSON.stringify(await c.agent.request(methods.agent.session.list, {}));
  expect(everywhere).not.toContain("s3cret-token");
  for (const file of await readdir(sessionsDir(dir))) {
    expect(await readFile(join(sessionsDir(dir), file), "utf8")).not.toContain("s3cret-token");
  }
  expect(await readFile(indexPath(dir), "utf8")).toContain("s3cret-token");
  expect((await stat(indexPath(dir))).mode & 0o777).toBe(0o600);
});

test("a directory that is not there is refused up front, and nothing is stored", async () => {
  const { daemon, fake } = await start();
  const c = await connectClient(daemon);
  await expect(
    c.agent.request(methods.agent.session.new, {
      cwd: "/tmp",
      additionalDirectories: ["/no/such/directory"],
    } as never),
  ).rejects.toMatchObject({ code: -32602 });
  expect(fake.log.launches).toBe(0);
  expect((await c.agent.request(methods.agent.session.list, {})).sessions).toEqual([]);
});

// ---- what the agent tells about itself ----

test("a setting the agent changes itself is on record, and applied again when it restarts", async () => {
  const fake = fakeAgent({
    onPrompt: async ({ say }) => {
      await say({
        sessionUpdate: "config_option_update",
        configOptions: [
          {
            configId: "mode",
            name: "Mode",
            type: "select",
            currentValue: "acceptEdits",
            options: [{ value: "acceptEdits", name: "Accept edits" }],
          },
          {
            configId: "model",
            name: "Model",
            type: "select",
            currentValue: "default",
            options: [{ value: "default", name: "Default" }],
          },
        ],
      });
    },
  });
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("go") });
  await until(() => c.ended() >= 1, "the turn to end");
  await Bun.sleep(30);
  expect((await sessionRow(c))["cycle/config"]).toEqual({ mode: "acceptEdits", model: "default" });

  fake.crash();
  await Bun.sleep(30);
  fake.log.configs.length = 0;
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("again") });
  await until(() => fake.log.configs.length === 2, "the settings to be applied");
  expect(fake.log.configs.map((x) => [x.configId, x.value])).toEqual([
    ["mode", "acceptEdits"],
    ["model", "default"],
  ]);
});

test("the agent's title names a session until the user does", async () => {
  const titles = ["Fixing the login bug", "Fixing the login bug, again"];
  const fake = fakeAgent({
    onPrompt: async ({ say }) => {
      await say({ sessionUpdate: "session_info_update", title: titles.shift() });
    },
  });
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  const turn = async (what: string) => {
    const before = c.ended();
    await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text(what) });
    await until(() => c.ended() > before, "the turn to end");
    await Bun.sleep(30);
  };
  await turn("one");
  expect((await sessionRow(c)).title).toBe("Fixing the login bug");

  await c.agent.request("_cycle/session/set_title", { sessionId, title: "My name for it" });
  await turn("two");
  expect((await sessionRow(c)).title).toBe("My name for it");
  // Clients are not shown the agent's second title either, here or when they come back for the history.
  const told = (client: typeof c) =>
    client.seen
      .filter((s) => s.update.sessionUpdate === "session_info_update")
      .map((s) => (s.update as unknown as { title: string }).title);
  expect(told(c)).toEqual(["Fixing the login bug"]);
  const later = await connectClient(daemon);
  await later.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  });
  await until(() => later.kinds().includes("replay_complete"), "the history");
  expect(told(later)).toEqual(["Fixing the login bug"]);
});

test("the first message names a session at once, until the agent names it", async () => {
  let finish = () => {};
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fake = fakeAgent({
    onPrompt: async ({ say }) => {
      await held;
      await say({ sessionUpdate: "session_info_update", title: "Fixing the login bug" });
    },
  });
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  void c.agent.request(methods.agent.session.prompt, {
    sessionId,
    prompt: text("  the login   button does nothing\nsteps: open, click"),
  });
  // Before the turn ends: the agent has the message and has said nothing yet.
  await until(() => fake.log.prompts.length === 1, "the agent to get the message");
  expect((await sessionRow(c)).title).toBe("the login button does nothing");
  finish();
  await until(() => c.ended() >= 1, "the turn to end");
  await Bun.sleep(30);
  expect((await sessionRow(c)).title).toBe("Fixing the login bug");
  // The name for the meantime is not in the history: only what the agent said is.
  expect(
    c.seen
      .filter((s) => s.update.sessionUpdate === "session_info_update")
      .map((s) => (s.update as unknown as { title: string }).title),
  ).toEqual(["Fixing the login bug"]);

  // A later message does not name it again.
  const before = c.ended();
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("another") });
  await until(() => c.ended() > before, "the second turn to end");
  expect((await sessionRow(c)).title).toBe("Fixing the login bug");
});

test("the first message does not rename a session the person named, nor name one with no words", async () => {
  const fake = fakeAgent({}, { promptCapabilities: both });
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  const turn = async (sessionId: string, prompt: unknown[]) => {
    const before = c.ended();
    await c.agent.request(methods.agent.session.prompt, { sessionId, prompt } as never);
    await until(() => c.ended() > before, "the turn to end");
    await Bun.sleep(30);
  };
  const titleOf = async (sessionId: string) =>
    (await c.agent.request(methods.agent.session.list, {})).sessions.find(
      (s) => s.sessionId === sessionId,
    )?._meta?.title;

  const named = (await c.agent.request(methods.agent.session.new, { cwd: "/tmp" })).sessionId;
  await c.agent.request(methods.agent.session.resume, { sessionId: named, cwd: "/tmp" });
  await c.agent.request("_cycle/session/set_title", { sessionId: named, title: "My name for it" });
  await turn(named, text("fix the bug"));
  expect(await titleOf(named)).toBe("My name for it");

  const pictured = (await c.agent.request(methods.agent.session.new, { cwd: "/tmp" })).sessionId;
  await c.agent.request(methods.agent.session.resume, { sessionId: pictured, cwd: "/tmp" });
  await turn(pictured, [image]);
  expect(await titleOf(pictured)).toBeUndefined();
  // Nor does the next message, with words: only the first names a session.
  await turn(pictured, text("what is this?"));
  expect(await titleOf(pictured)).toBeUndefined();
});

// ---- found in review ----

test("a client that says it can answer forms, and cannot, does not hold the turn", async () => {
  const answers: unknown[] = [];
  const fake = fakeAgent({
    onPrompt: async ({ elicit }) => {
      answers.push(await elicit());
    },
  });
  const { daemon } = await start(fake);
  const broken = await connectClient(daemon, {
    onElicitation: () => {
      throw new Error("the screen for this is not there");
    },
  });
  const { sessionId } = await broken.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await broken.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await broken.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => answers.length === 1, "the agent to be answered");
  expect(answers[0]).toEqual({ action: "cancel", _meta: { "cycle/noClient": true } });
});

test("a directory that is not an absolute path is refused by the daemon, naming it", async () => {
  const { daemon } = await start();
  const c = await connectClient(daemon);
  await expect(
    c.agent.request(methods.agent.session.new, {
      cwd: "/tmp",
      additionalDirectories: ["src"],
    } as never),
  ).rejects.toMatchObject({ message: expect.stringContaining("src") });
});

test("the same title said again by an agent that started again is in the log once", async () => {
  const fake = fakeAgent({
    onPrompt: async ({ say }) => {
      await say({ sessionUpdate: "session_info_update", title: "Fixing the login bug" });
    },
  });
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  for (const n of [1, 2]) {
    await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text(`go ${n}`) });
    await until(() => c.ended() >= n, "the turn to end");
  }
  const later = await connectClient(daemon);
  await later.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  });
  await until(() => later.kinds().includes("replay_complete"), "the history");
  expect(later.kinds().filter((k) => k === "session_info_update")).toHaveLength(1);
});

test("the index's directory is private, as the file is", async () => {
  const nested = join(dir, "fresh", "data");
  const daemon = await Daemon.start({ dataDir: nested, agents: [fakeAgent().definition] });
  open.push(daemon);
  const c = await connectClient(daemon);
  await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  expect((await stat(join(nested, "index.json"))).mode & 0o777).toBe(0o600);
});

test("a usage update whose cost is null still gives the list its context", async () => {
  const fake = fakeAgent({
    onPrompt: async ({ say }) => {
      await say({ sessionUpdate: "usage_update", used: 10, size: 1000, cost: null });
    },
  });
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("go") });
  await until(() => c.ended() >= 1, "the turn to end");
  await Bun.sleep(30);
  expect((await sessionRow(c))["cycle/usage"]).toEqual({ used: 10, size: 1000 });
});

test("the title said again with something else in the same update is not dropped", async () => {
  const fake = fakeAgent({
    onPrompt: async ({ say }) => {
      await say({ sessionUpdate: "session_info_update", title: "Same title" });
      await say({ sessionUpdate: "session_info_update", title: "Same title", _meta: { more: 1 } });
    },
  });
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("go") });
  await until(() => c.ended() >= 1, "the turn to end");
  expect(c.kinds().filter((k) => k === "session_info_update")).toHaveLength(2);
});

// ---- usage ----

test("the latest usage is in the session list, and survives a restart", async () => {
  const fake = fakeAgent({
    onPrompt: async ({ say }) => {
      await say({
        sessionUpdate: "usage_update",
        used: 1200,
        size: 200000,
        cost: { amount: 0.03, currency: "USD" },
      });
      await say({
        sessionUpdate: "usage_update",
        used: 5000,
        size: 200000,
        cost: { amount: 0.08, currency: "USD" },
      });
    },
  });
  const { daemon } = await start(fake);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  expect((await sessionRow(c))["cycle/usage"]).toBeUndefined();
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("go") });
  await until(() => c.ended() >= 1, "the turn to end");
  await Bun.sleep(30);
  const expected = { used: 5000, size: 200000, cost: { amount: 0.08, currency: "USD" } };
  expect((await sessionRow(c))["cycle/usage"]).toEqual(expected);
  await daemon.close();
  open = [];
  const again = await start();
  const d = await connectClient(again.daemon);
  expect((await sessionRow(d))["cycle/usage"]).toEqual(expected);
});

// ---- elicitation ----

const form = (fake: ReturnType<typeof fakeAgent>) => fake;

test("a form goes to a client that can answer it, and its answer goes back to the agent", async () => {
  const answers: unknown[] = [];
  const fake = fakeAgent({
    onPrompt: async ({ elicit }) => {
      answers.push(await elicit());
    },
  });
  const { daemon } = await start(form(fake));
  const capable = await connectClient(daemon, {
    onElicitation: () => ({ action: "accept", content: { pick: "b" } }),
  });
  const bystander = await connectClient(daemon, { onPermission: () => "never" });
  const { sessionId } = await capable.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await capable.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await bystander.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await capable.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => answers.length === 1, "the agent to be answered");
  expect(answers[0]).toEqual({ action: "accept", content: { pick: "b" } });
  expect(capable.elicitations).toHaveLength(1);
  expect(capable.elicitations[0]).toMatchObject({ sessionId, mode: "form", message: "Which one?" });
  // The request carries the daemon's id for it, like a permission request.
  expect(
    (capable.elicitations[0] as { _meta: Record<string, unknown> })._meta["cycle/requestId"],
  ).toBeString();
  // A client that cannot answer a form is not asked one.
  expect(bystander.elicitations).toHaveLength(0);
});

test("the first of two capable clients to answer settles it; the other is told", async () => {
  const answers: unknown[] = [];
  const { daemon } = await start(
    fakeAgent({
      onPrompt: async ({ elicit }) => {
        answers.push(await elicit());
      },
    }),
  );
  const a = await connectClient(daemon, {
    onElicitation: () => ({ action: "accept", content: { pick: "a" } }),
  });
  const b = await connectClient(daemon, { onElicitation: () => "never" });
  const { sessionId } = await a.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await a.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await b.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await a.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => answers.length === 1, "the agent to be answered");
  expect(answers[0]).toMatchObject({ action: "accept", content: { pick: "a" } });
  await until(() => b.resolved.length === 1, "request_resolved");
  expect(b.resolved[0]).toMatchObject({ sessionId, outcome: { action: "accept" } });
});

test("what is typed into a form goes to the agent and not into the log or to the other clients", async () => {
  const answers: unknown[] = [];
  const { daemon } = await start(
    fakeAgent({
      onPrompt: async ({ elicit }) => {
        answers.push(await elicit());
      },
    }),
  );
  const a = await connectClient(daemon, {
    onElicitation: () => ({ action: "accept", content: { password: "hunter2-secret" } }),
  });
  const b = await connectClient(daemon, { onElicitation: () => "never" });
  const { sessionId } = await a.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await a.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await b.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await a.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => answers.length === 1, "the agent to be answered");
  expect(answers[0]).toEqual({ action: "accept", content: { password: "hunter2-secret" } });
  await until(() => b.resolved.length === 1, "request_resolved");
  expect(JSON.stringify(b.resolved[0])).not.toContain("hunter2-secret");
  expect(await readFile(join(sessionsDir(dir), `${sessionId}.jsonl`), "utf8")).not.toContain(
    "hunter2-secret",
  );
});

test("a client's answer is only an action and its content: no `_meta`, and nonsense is a cancel", async () => {
  const answers: unknown[] = [];
  const replies = [
    { action: "accept", content: { pick: "a" }, _meta: { "cycle/noClient": true } },
    "garbage",
    { action: "yes please" },
  ];
  const { daemon } = await start(
    fakeAgent({
      onPrompt: async ({ elicit }) => {
        answers.push(await elicit());
      },
    }),
  );
  const c = await connectClient(daemon, { onElicitation: () => replies.shift() as never });
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  for (const n of [1, 2, 3]) {
    await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text(`ask ${n}`) });
    await until(() => answers.length === n, "the agent to be answered");
  }
  expect(answers).toEqual([
    { action: "accept", content: { pick: "a" } },
    // An answer the protocol layer rejects is a client that cannot answer: nobody to ask.
    { action: "cancel", _meta: { "cycle/noClient": true } },
    // An action nobody defined is a cancel.
    { action: "cancel" },
  ]);
});

test("with no client that can answer a form attached, the agent is told so at once and the turn goes on", async () => {
  const answers: unknown[] = [];
  const { daemon } = await start(
    fakeAgent({
      onPrompt: async ({ elicit }) => {
        answers.push(await elicit());
      },
    }),
  );
  // This client has no elicitation capability, as the desktop client does not today.
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => c.ended() >= 1, "the turn to end");
  expect(answers).toEqual([{ action: "cancel", _meta: { "cycle/noClient": true } }]);
  expect(c.elicitations).toHaveLength(0);
  // It never made the session wait for anyone.
  expect(c.kinds()).not.toContain("requires_action");
  expect((await sessionRow(c))["cycle/state"]).toBe("idle");
});

test("a cancel ends a form that is waiting, and the agent hears it was cancelled", async () => {
  const answers: unknown[] = [];
  const { daemon } = await start(
    fakeAgent({
      onPrompt: async ({ elicit }) => {
        answers.push(await elicit());
      },
    }),
  );
  const c = await connectClient(daemon, { onElicitation: () => "never" });
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => c.elicitations.length === 1, "the form to arrive");
  expect((await sessionRow(c))["cycle/state"]).toBe("requires_action");
  await c.agent.notify(methods.agent.session.cancel, { sessionId } as never);
  await until(() => answers.length === 1, "the agent to be answered");
  expect(answers[0]).toEqual({ action: "cancel" });
});

test("a form that waits when the agent exits is ended, not left behind", async () => {
  const fake = fakeAgent({ onPrompt: ({ elicit }) => elicit().then(() => undefined) });
  const { daemon } = await start(fake);
  const c = await connectClient(daemon, { onElicitation: () => "never" });
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await c.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => c.elicitations.length === 1, "the form to arrive");
  fake.crash();
  await until(() => c.resolved.length === 1, "request_resolved");
  expect(c.resolved[0]).toMatchObject({ outcome: { action: "cancel" } });
  expect((await sessionRow(c))["cycle/state"]).toBe("stopped");
});

test("when the last client that can answer a form goes, the agent is told, not kept waiting", async () => {
  const answers: unknown[] = [];
  const { daemon } = await start(
    fakeAgent({
      onPrompt: async ({ elicit }) => {
        answers.push(await elicit());
      },
    }),
  );
  const first = await connectClient(daemon, { onElicitation: () => "never" });
  const other = await connectClient(daemon); // cannot answer forms, and stays
  const { sessionId } = await first.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await first.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await other.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await first.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("ask") });
  await until(() => first.elicitations.length === 1, "the form to arrive");
  first.close();
  await until(() => answers.length === 1, "the agent to be answered");
  expect(answers[0]).toEqual({ action: "cancel", _meta: { "cycle/noClient": true } });
  await until(() => other.ended() >= 1, "the turn to end");
});

test("a name the user gave before agents named sessions is not replaced by the agent's", async () => {
  const first = await start();
  const c = await connectClient(first.daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await first.daemon.close();
  open = [];
  // The index as an older daemon wrote it: a title, and nothing that says where it came from.
  const index = JSON.parse(await readFile(indexPath(dir), "utf8"));
  index.sessions[sessionId].title = "Old name";
  await writeFile(indexPath(dir), JSON.stringify(index));

  const fake = fakeAgent({
    onPrompt: async ({ say }) => {
      await say({ sessionUpdate: "session_info_update", title: "The agent's idea" });
    },
  });
  const second = await start(fake);
  const d = await connectClient(second.daemon);
  await d.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  await d.agent.request(methods.agent.session.prompt, { sessionId, prompt: text("go") });
  await until(() => d.ended() >= 1, "the turn to end");
  await Bun.sleep(30);
  expect((await sessionRow(d)).title).toBe("Old name");
});
