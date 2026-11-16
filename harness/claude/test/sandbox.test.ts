import { expect, test } from "bun:test";
import {
  ClaudeHarness,
  createArgs,
  execArgs,
  modeOptions,
  projectFolder,
  sandboxEnv,
  sandboxName,
} from "../src/index.ts";
import { fakeSbx } from "./fake-sbx.ts";
import { FakeSdk, settle } from "./fake-sdk.ts";

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

test("the sandbox is made with the folder, and the folder's conversations alone, shared into it", () => {
  expect(projectFolder("/Users/me/my project/a.b_c")).toBe("-Users-me-my-project-a-b-c");
  expect(createArgs("cycle-app-1", "/Users/me/app", "/Users/me/.claude")).toEqual([
    "--no-input",
    "create",
    "--name",
    "cycle-app-1",
    "claude",
    "/Users/me/app",
    "/Users/me/.claude/projects/-Users-me-app:/home/agent/.claude/projects/-Users-me-app",
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
  expect(folders).toEqual(["/home/me/.claude/projects/-Users-me-app"]);
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
  expect(sandboxes.ensure(`/${"x".repeat(250)}`, STANDARD)).rejects.toThrow("too long");
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
  let ids = 0;
  const harness = new ClaudeHarness({
    sdk,
    env: {},
    bin: "/opt/claude",
    sandboxes: sbx.sandboxes,
    tools: { name: "cycle", url: "http://127.0.0.1:1/mcp", key: "the-tools-key" },
    schedule: () => () => {},
    now: () => 1000,
    newId: () => `id${++ids}`,
  });
  return { sdk, harness, ...sbx };
}

const options = { mode: "auto" as const, model: "claude-sonnet-5-5" };

test("a session asked into a sandbox has its agent started there, and nowhere else", async () => {
  const { sdk, harness, asked, started } = setup();
  expect((await harness.listModels()).every((model) => model.sandbox)).toBe(true);
  const session = await harness.createSession({
    cwd: "/Users/me/app",
    sandboxed: "standard",
    ...options,
  });
  const name = sandboxName("/Users/me/app", "standard");
  expect(session.sandbox).toBe(name);
  await harness.send(session.id, { text: "hello", images: [] }, { ...options, sandbox: name });
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
  const request = {
    command: "claude",
    args: ["--verbose"],
    cwd: "/Users/me/app",
    env: {},
    signal,
  };
  expect(query.options.spawnClaudeCodeProcess?.(request)).toBe(started[0]?.process);
  expect(asked.at(-1)).toEqual(["exec", "-i", "-w", "/Users/me/app", name, "claude", "--verbose"]);
  expect((await harness.loadSession(session.id, {})).session.sandbox).toBe(name);
});

test("a daemon that never made the session is told its sandbox, and one on this machine has none", async () => {
  const { sdk, harness, asked } = setup(["kept-sandbox"]);
  sdk.stored = [{ sessionId: "s1", summary: "", lastModified: 5, cwd: "/Users/me/app" }];
  await harness.send("s1", { text: "again", images: [] }, { ...options, sandbox: "kept-sandbox" });
  expect(asked).toEqual([["ls", "-q"]]);
  expect(sdk.last.options.spawnClaudeCodeProcess).toBeDefined();
  expect(sdk.last.options.resume).toBe("s1");

  const local = await harness.createSession({ cwd: "/Users/me/app", ...options });
  expect(local.sandbox).toBeNull();
  await harness.send(local.id, { text: "here", images: [] }, options);
  expect(sdk.last.options).toMatchObject({
    pathToClaudeCodeExecutable: "/opt/claude",
    sandbox: { enabled: true },
  });
  expect(sdk.last.options.spawnClaudeCodeProcess).toBeUndefined();
  expect(sdk.last.servers).not.toBeNull();
});

test("without sbx no model offers a sandbox, and a session asked into one is refused", async () => {
  const { harness, state } = setup();
  state.installed = false;
  expect((await harness.listModels()).some((model) => model.sandbox)).toBe(false);
  expect(harness.createSession({ cwd: "/Users/me/app", sandboxed: "standard" })).rejects.toThrow(
    "Docker Sandboxes is not installed",
  );
  expect(modeOptions("fullAccess", true)).toEqual(modeOptions("fullAccess"));
});
