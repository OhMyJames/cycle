import { expect, test } from "bun:test";
import {
  ClaudeHarness,
  createArgs,
  execArgs,
  modeOptions,
  projectFolder,
  sandboxCwd,
  sandboxEnv,
  sandboxName,
} from "../src/index.ts";
import { fakeSbx } from "./fake-sbx.ts";
import { FakeSdk, settle, user } from "./fake-sdk.ts";

const signal = new AbortController().signal;
const STANDARD = { environment: "standard" };

test("a folder's sandbox is named for it, and two folders of one name are told apart", () => {
  const name = sandboxName("/Users/me/Code/My App", "standard");
  expect(name).toMatch(/^cycle-my-app-[0-9a-f]{8}$/);
  expect(sandboxName("/Users/me/Code/My App", "standard")).toBe(name);
  expect(sandboxName("/Users/me/Other/My App", "standard")).not.toBe(name);
  // A folder has a sandbox for each environment it is worked in.
  expect(sandboxName("/Users/me/Code/My App", "node")).not.toBe(name);
  expect(sandboxName("/", "standard")).toMatch(/^cycle-folder-[0-9a-f]{8}$/);
  // `sbx` takes at most 63 characters.
  expect(sandboxName(`/x/${"long-".repeat(30)}`, "standard").length).toBeLessThanOrEqual(63);
});

test("a sandbox sees the folder by its name alone, and keeps its conversations in its own home", () => {
  expect(projectFolder("/Users/me/my project/a.b_c")).toBe("-Users-me-my-project-a-b-c");
  expect(sandboxCwd("/Users/me/My App")).toBe("/home/agent/workspace/My-App");
  expect(sandboxCwd("/")).toBe("/home/agent/workspace/project");
  expect(
    createArgs("cycle-app-1", "/Users/me/app", "/home/me/.cycle/sandboxes/cycle-app-1/claude"),
  ).toEqual([
    "--no-input",
    "create",
    "--name",
    "cycle-app-1",
    "claude",
    // The workspace sbx insists on naming itself, and then the folder under a name of its own.
    expect.stringMatching(/^\/tmp\/cycle-sandbox\/[0-9a-f]{8}$/),
    "/Users/me/app:/home/agent/workspace/app",
    "/home/me/.cycle/sandboxes/cycle-app-1/claude/projects/-home-agent-workspace-app:/home/agent/.claude/projects/-home-agent-workspace-app",
  ]);
});

test("the sandbox's own Claude Code is run with what the SDK asked, and no secret of this machine", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/Users/me",
    ANTHROPIC_API_KEY: "sk-ant-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "secret",
    // The daemon's own, when it was started from a Claude Code: not the sandbox's.
    CLAUDE_CODE_REMOTE_SESSION_ID: "cse_1",
    CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
    CLAUDE_AGENT_SDK_VERSION: "0.3.325",
    CLAUDE_CODE_UNSET: undefined,
  };
  expect(sandboxEnv(env)).toEqual([
    "CLAUDE_AGENT_SDK_VERSION=0.3.325",
    "CLAUDE_CODE_ENTRYPOINT=sdk-ts",
  ]);
  const request = {
    // The SDK names this machine's Claude Code, which is not the sandbox's.
    command: "/Users/me/node_modules/claude",
    args: ["--output-format", "stream-json", "--session-id=s1"],
    cwd: "/Users/me/app",
    env,
    signal,
  };
  expect(execArgs("cycle-app-1", request)).toEqual([
    "exec",
    "-i",
    "-w",
    "/Users/me/app",
    "-e",
    "CLAUDE_AGENT_SDK_VERSION=0.3.325",
    "-e",
    "CLAUDE_CODE_ENTRYPOINT=sdk-ts",
    "cycle-app-1",
    "claude",
    "--output-format",
    "stream-json",
    "--session-id=s1",
  ]);
});

test("a sandbox is made once, and found after that", async () => {
  const { sandboxes, asked, folders } = fakeSbx(["someone-elses"]);
  const name = sandboxName("/Users/me/app", "standard");
  // Two sessions starting at once in one folder make one sandbox.
  expect(
    await Promise.all([
      sandboxes.ensure("/Users/me/app", STANDARD),
      sandboxes.ensure("/Users/me/app", STANDARD),
    ]),
  ).toEqual([name, name]);
  expect(asked.map((args) => (args[0] === "ls" ? "ls" : args[1]))).toEqual(["ls", "create"]);
  expect(folders).toEqual([
    expect.stringMatching(/^\/tmp\/cycle-sandbox\/[0-9a-f]{8}$/),
    `/home/me/.cycle/sandboxes/${name}/claude/projects/-home-agent-workspace-app`,
  ]);
  await sandboxes.ensure("/Users/me/app", STANDARD);
  expect(asked.at(-1)).toEqual(["ls", "-q"]);
  // One made before under another name is the one to find.
  expect(await sandboxes.ensure("/Users/me/app", { name: "someone-elses" })).toBe("someone-elses");
  expect(asked.filter((args) => args[1] === "create")).toHaveLength(1);
});

test("what sbx says when it cannot is said on, and without sbx there are no sandboxes", async () => {
  const { sandboxes, state } = fakeSbx();
  state.fail = "Error: sign in with `sbx login`";
  expect(sandboxes.ensure("/Users/me/app", STANDARD)).rejects.toThrow(
    "sbx could not list its sandboxes: Error: sign in with `sbx login`",
  );
  state.fail = "";
  state.installed = false;
  expect(sandboxes.available()).toBe(false);
  expect(sandboxes.ensure("/Users/me/app", { environment: "gone" })).rejects.toThrow(
    "That sandbox environment is gone.",
  );
  expect(sandboxes.ensure("/Users/me/app", STANDARD)).rejects.toThrow("`sbx` is not on the PATH");
});

function setup(names: string[] = []) {
  const sdk = new FakeSdk();
  const sbx = fakeSbx(names);
  const moved: [string, string][] = [];
  let ids = 0;
  const harness = new ClaudeHarness({
    sdk,
    env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" },
    bin: "/opt/claude",
    sandboxes: sbx.sandboxes,
    files: {
      async move(from, to) {
        moved.push([from, to]);
        return true;
      },
    },
    tools: { name: "cycle", url: "http://127.0.0.1:1/mcp", key: "the-tools-key" },
    schedule: () => () => {},
    now: () => 1000,
    newId: () => `id${++ids}`,
  });
  return { sdk, harness, moved, ...sbx };
}

const options = { mode: "acceptEdits", model: "claude-sonnet-5-5" };

test("a session asked into a sandbox has its agent started there, and nowhere else", async () => {
  const { sdk, harness, asked, started } = setup();
  expect((await harness.listModels()).every((model) => model.sandbox)).toBe(true);
  const session = await harness.createSession({
    cwd: "/Users/me/app",
    environment: "standard",
    ...options,
  });
  const name = sandboxName("/Users/me/app", "standard");
  // The container's name is the harness's: the session says only where the agent sees the folder.
  expect(session.sandboxCwd).toBe("/home/agent/workspace/app");
  await harness.send(
    session.id,
    { text: "hello", images: [] },
    { ...options, environment: "standard" },
  );
  await settle();
  const query = sdk.last;
  // The sandbox's own Claude Code, not this machine's: `sbx exec` starts it by name, and the SDK
  // is given that name so it does not look for the native binary it was packaged without.
  expect(query.options.pathToClaudeCodeExecutable).toBe("claude");
  // Its walls are the sandbox's: Claude Code's own are left off inside.
  expect(query.options).toMatchObject({ permissionMode: "acceptEdits" });
  expect(query.options.sandbox).toBeUndefined();
  // Cycle's tools answer on this machine's loopback, which the sandbox is not on.
  expect(query.servers).toBeNull();
  // The agent works at the sandbox's own path for the folder, not this machine's.
  expect(query.options.cwd).toBe("/home/agent/workspace/app");
  const request = {
    command: "claude",
    args: ["--verbose"],
    cwd: "/home/agent/workspace/app",
    env: {},
    signal,
  };
  expect(query.options.spawnClaudeCodeProcess?.(request)).toBe(started[0]?.process);
  expect(asked.at(-1)).toEqual([
    "exec",
    "-i",
    "-w",
    "/home/agent/workspace/app",
    name,
    "claude",
    "--verbose",
  ]);
  expect((await harness.loadSession(session.id, {})).session.sandboxCwd).toBe(
    "/home/agent/workspace/app",
  );
});

test("a daemon that never made the session is told its environment, and one on this machine has none", async () => {
  const { sdk, harness, asked } = setup([sandboxName("/Users/me/app", "standard")]);
  sdk.stored = [{ sessionId: "s1", summary: "", lastModified: 5, cwd: "/Users/me/app" }];
  await harness.send("s1", { text: "again", images: [] }, { ...options, environment: "standard" });
  expect(asked).toEqual([["ls", "-q"]]);
  expect(sdk.last.options.spawnClaudeCodeProcess).toBeDefined();
  expect(sdk.last.options.resume).toBe("s1");

  const local = await harness.createSession({ cwd: "/Users/me/app", ...options });
  expect(local.sandboxCwd).toBeNull();
  await harness.send(local.id, { text: "here", images: [] }, options);
  expect(sdk.last.options).toMatchObject({
    pathToClaudeCodeExecutable: "/opt/claude",
    sandbox: { enabled: true },
  });
  expect(sdk.last.options.spawnClaudeCodeProcess).toBeUndefined();
  expect(sdk.last.servers).not.toBeNull();
});

test("a sandbox's conversation is read from its own home, as this machine's folder", async () => {
  const { sdk, harness, made } = setup(["kept-sandbox"]);
  const name = "kept-sandbox";
  const home = `/home/me/.cycle/sandboxes/${name}/claude`;
  made[name] = { environment: "standard", version: "v", hosts: [], cwd: "/Users/me/app" };
  sdk.homes[home] = {
    stored: [{ sessionId: "s1", summary: "", lastModified: 5, cwd: "/home/agent/workspace/app" }],
    messages: { s1: [user("u1", "hello")] },
  };
  const listed = (await harness.listSessions({ archived: false })).find((each) => each.id === "s1");
  expect(listed).toMatchObject({
    cwd: "/Users/me/app",
    sandboxCwd: "/home/agent/workspace/app",
  });
  // Found in the sandbox's own home, which is the truth of where it runs.
  const loaded = await harness.loadSession("s1", {});
  expect(loaded.session).toMatchObject({
    cwd: "/Users/me/app",
    sandboxCwd: "/home/agent/workspace/app",
  });
  expect(loaded.turns).toHaveLength(1);
  expect(sdk.read).toContain(home);
});

test("a conversation this machine kept is moved into its sandbox's home once", async () => {
  const name = sandboxName("/Users/me/app", "standard");
  const { sdk, harness, made, moved } = setup([name]);
  const home = `/home/me/.cycle/sandboxes/${name}/claude`;
  // Made before a sandbox kept the folder it works in.
  made[name] = { environment: "standard", version: "v", hosts: [] };
  sdk.stored = [{ sessionId: "s1", summary: "", lastModified: 5, cwd: "/Users/me/app" }];
  sdk.messages = { s1: [user("u1", "before")] };
  await harness.loadSession("s1", { environment: "standard" });
  expect(moved).toEqual([
    [
      "/home/me/.claude/projects/-Users-me-app/s1.jsonl",
      `${home}/projects/-home-agent-workspace-app/s1.jsonl`,
    ],
    ["/home/me/.claude/projects/-Users-me-app/s1", `${home}/projects/-home-agent-workspace-app/s1`],
  ]);
  // Its conversations are under the sandbox now, so the folder is kept for finding them again.
  expect(made[name]?.cwd).toBe("/Users/me/app");
});

test("without sbx no model offers a sandbox, and a session asked into one is refused", async () => {
  const { harness, state } = setup();
  state.installed = false;
  expect((await harness.listModels()).some((model) => model.sandbox)).toBe(false);
  expect(harness.createSession({ cwd: "/Users/me/app", environment: "standard" })).rejects.toThrow(
    "Docker Sandboxes is not installed",
  );
  expect(modeOptions("bypassPermissions", true)).toEqual(modeOptions("bypassPermissions"));
});
