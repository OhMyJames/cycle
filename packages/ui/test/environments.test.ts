import { expect, test } from "bun:test";
import {
  checkEnvironment,
  ENVIRONMENT_MAX_BYTES as PROTOCOL_MAX_BYTES,
  RESERVED_VARIABLES as PROTOCOL_RESERVED,
  VARIABLE_NAME as PROTOCOL_VARIABLE_NAME,
  isReservedVariable as protocolIsReserved,
} from "@cycle/protocol";
import type { Environment } from "../src/api.ts";
import {
  ACTION_ICONS,
  actionIconOf,
  ENVIRONMENT_MAX_BYTES,
  environmentProblem,
  environmentSnapshot,
  formatVariables,
  isReservedVariable,
  parseVariables,
  RESERVED_VARIABLES,
  VARIABLE_NAME,
  workspaceKey,
} from "../src/environments.ts";
import { AppStore, BLANK_KEY, environmentDefaultOf } from "../src/store/index.ts";
import { fakeBridge } from "./fake-bridge.ts";

// The page may not import `@cycle/protocol`: these say its copy of the daemon's rules is the daemon's.
test("the page's rules for an environment are the daemon's", () => {
  expect([...RESERVED_VARIABLES]).toEqual([...PROTOCOL_RESERVED]);
  expect(VARIABLE_NAME.source).toBe(PROTOCOL_VARIABLE_NAME.source);
  expect(ENVIRONMENT_MAX_BYTES).toBe(PROTOCOL_MAX_BYTES);
  for (const name of ["PATH", "CYCLE_X", "OPENAI_API_KEY", "DATABASE_URL", "cycle_x"])
    expect([name, isReservedVariable(name)]).toEqual([name, protocolIsReserved(name)]);
});

test("an environment the page would keep is one the daemon takes, and the other way round", () => {
  const base: Environment = { id: "e", name: "E", variables: [], secrets: [], actions: [] };
  const cases: Environment[] = [
    base,
    { ...base, variables: [{ name: "A", value: "1" }] },
    { ...base, secrets: [{ name: "TOKEN" }] },
    { ...base, secrets: [{ name: "TOKEN", from: "WORK_GH" }] },
    { ...base, secrets: [{ name: "TOKEN", from: "not-a-key" }] },
    { ...base, secrets: [{ name: "PATH" }] },
    { ...base, secrets: [{ name: "A" }, { name: "A", from: "B" }] },
    { ...base, variables: [{ name: "A", value: "1" }], secrets: [{ name: "A" }] },
    { ...base, secrets: [{ name: "not-a-name" }] },
    { ...base, variables: [{ name: "PATH", value: "/x" }] },
    { ...base, variables: [{ name: "1A", value: "1" }] },
    { ...base, variables: [{ name: "A", value: "a\0b" }] },
    { ...base, variables: [{ name: "BIG", value: "x".repeat(ENVIRONMENT_MAX_BYTES) }] },
    { ...base, name: "" },
    { ...base, actions: [{ id: "", name: "A", command: { default: "true" } }] },
    {
      ...base,
      actions: [
        { id: "a", name: "A", command: { default: "true" } },
        { id: "a", name: "B", command: { default: "true" } },
      ],
    },
    { ...base, actions: [{ id: "a", name: "A", command: { default: "true" } }] },
    { ...base, variables: [{ name: "CLAUDE_ENV_FILE", value: "/tmp/x" }] },
    {
      ...base,
      variables: [
        { name: "A", value: "1" },
        { name: "A", value: "2" },
      ],
    },
  ];
  for (const environment of cases)
    expect([environment, environmentProblem(environment) === undefined]).toEqual([
      environment,
      checkEnvironment(environmentSnapshot(environment)).ok,
    ]);
});

test("variables are read as a .env file: comments, export, quotes, and what is wrong by line", () => {
  const text = [
    "# a comment",
    "",
    "export TOKEN=abc",
    'QUOTED="two words # not a comment"',
    "SINGLE='as \\n it is'",
    'ESCAPED="line\\nnext \\"q\\""',
    "PLAIN=postgres://u@h/db # a comment",
    "EMPTY=",
    "API_TOKEN",
    "WORK_GH as GH_TOKEN",
    "bad-key as OTHER",
    "no equals here",
    'OPEN="never closed',
    "HOME=/tmp",
    "TOKEN=again",
    "1BAD=x",
  ].join("\n");
  expect(parseVariables(text)).toEqual({
    variables: [
      { name: "TOKEN", value: "abc" },
      { name: "QUOTED", value: "two words # not a comment" },
      { name: "SINGLE", value: "as \\n it is" },
      { name: "ESCAPED", value: 'line\nnext "q"' },
      { name: "PLAIN", value: "postgres://u@h/db" },
      { name: "EMPTY", value: "" },
    ],
    secrets: [{ name: "API_TOKEN" }, { name: "GH_TOKEN", from: "WORK_GH" }],
    problems: [
      { line: 11, problem: "invalid_name", name: "bad-key" },
      { line: 12, problem: "no_equals" },
      { line: 13, problem: "unclosed_quote" },
      { line: 14, problem: "reserved", name: "HOME" },
      { line: 15, problem: "duplicate", name: "TOKEN", first: 3 },
      { line: 16, problem: "invalid_name", name: "1BAD" },
    ],
  });
});

test("variables written out read back as the same", () => {
  const variables = [
    { name: "A", value: "plain" },
    { name: "B", value: "" },
    { name: "C", value: " spaced " },
    { name: "D", value: 'has "quotes" and \\ backslash' },
    { name: "E", value: "multi\nline\ttab" },
    { name: "F", value: "a # b" },
    { name: "G", value: "'leading quote" },
    { name: "H", value: "url#fragment" },
  ];
  const text = formatVariables(variables, [
    { name: "API_TOKEN" },
    { name: "GH_TOKEN", from: "WORK_GH" },
  ]);
  expect(text.split("\n")[0]).toBe("A=plain");
  expect(text.split("\n").slice(-2)).toEqual(["API_TOKEN", "WORK_GH as GH_TOKEN"]);
  expect(parseVariables(text)).toEqual({
    variables,
    secrets: [{ name: "API_TOKEN" }, { name: "GH_TOKEN", from: "WORK_GH" }],
    problems: [],
  });
});

test("environments are read at start; a workspace's default is set at once and kept by main", async () => {
  const script = fakeBridge({
    connected: true,
    environments: {
      environments: [{ id: "env-a", name: "A", variables: [], secrets: [], actions: [] }],
      defaults: { local: { "/gone": "env-removed" } },
    },
  });
  const store = new AppStore(script.bridge);
  await store.start();
  expect(store.getState().environments?.environments.map((e) => e.id)).toEqual(["env-a"]);
  // A default naming an environment that is not there is no default.
  expect(environmentDefaultOf(store.getState(), "local", "/gone")).toBeUndefined();
  const setting = store.setEnvironmentDefault("local", "/work", "env-a");
  expect(environmentDefaultOf(store.getState(), "local", "/work")?.name).toBe("A");
  await setting;
  expect(script.named("setEnvironmentDefault")).toEqual([
    ["setEnvironmentDefault", "local", "/work", "env-a"],
  ]);
  await store.setEnvironmentDefault("local", "/work", null);
  expect(environmentDefaultOf(store.getState(), "local", "/work")).toBeUndefined();
});

test("a refused environment is said in the page's words, naming the variable, and the message goes back to the box", async () => {
  const script = fakeBridge({
    connected: true,
    capabilities: { queue: true, files: true, folders: true, environments: true },
    environments: {
      environments: [{ id: "env-a", name: "A", variables: [], secrets: [], actions: [] }],
      defaults: { local: { "/work": "env-a" } },
    },
  });
  // Main answers a refusal with its reason and the variable's name, never as an error to read words from.
  script.bridge.createSession = async () => ({
    problem: { reason: "reserved_variable", name: "PATH" },
  });

  const store = new AppStore(script.bridge);
  await store.start();
  store.openBlank({ locationId: "local", cwd: "/work" });
  await Bun.sleep(1);
  store.drafts.setText(BLANK_KEY, "hi");
  await store.send();
  expect(store.getState().error).toEqual({
    key: "blank.environment.refused.reserved_variable",
    params: { name: "PATH" },
  });
  expect(store.drafts.get(BLANK_KEY).text).toBe("hi");
});

test("an environment main finds does not pass the daemon's rules is said as one to fix in Settings, by its name", async () => {
  const script = fakeBridge({
    connected: true,
    capabilities: { queue: true, files: true, folders: true, environments: true },
    environments: {
      environments: [{ id: "env-a", name: "A", variables: [], secrets: [], actions: [] }],
      defaults: { local: { "/work": "env-a" } },
    },
  });
  // What the page had passed, and the file main read has changed since.
  script.bridge.createSession = async () => ({ problem: { reason: "needs_fix", name: "A" } });
  const store = new AppStore(script.bridge);
  await store.start();
  store.openBlank({ locationId: "local", cwd: "/work" });
  await Bun.sleep(1);
  store.drafts.setText(BLANK_KEY, "hi");
  await store.send();
  expect(store.getState().error).toEqual({
    key: "blank.environment.needsFix",
    params: { name: "A" },
  });
  expect(store.drafts.get(BLANK_KEY).text).toBe("hi");
});

test("an action's icon is one of a fixed set by id; any other is drawn as the terminal", () => {
  expect([...ACTION_ICONS]).toEqual([
    "terminal",
    "play",
    "test",
    "build",
    "database",
    "server",
    "refresh",
    "clean",
  ]);
  expect(actionIconOf("database")).toBe("database");
  expect(actionIconOf(undefined)).toBe("terminal");
  expect(actionIconOf("rocket")).toBe("terminal");
});

test("a workspace's default is one for its folder with or without a slash at its end", async () => {
  const script = fakeBridge({
    connected: true,
    environments: {
      environments: [{ id: "env-a", name: "A", variables: [], secrets: [], actions: [] }],
      defaults: { local: { "/repo": "env-a" } },
    },
  });
  const store = new AppStore(script.bridge);
  await store.start();
  expect(environmentDefaultOf(store.getState(), "local", "/repo/")?.id).toBe("env-a");
  expect(workspaceKey("/repo//")).toBe("/repo");
  expect(workspaceKey("/")).toBe("/");
  expect(workspaceKey("//")).toBe("/");
  // A folder's name may end in a space: it is another folder, and kept as it is.
  expect(workspaceKey("/repo /")).toBe("/repo ");
  expect(workspaceKey(" /repo")).toBe(" /repo");
  await store.setEnvironmentDefault("local", "/other/", "env-a");
  expect(store.getState().environments?.defaults.local).toEqual({
    "/repo": "env-a",
    "/other": "env-a",
  });
});

test("an environment that does not pass the daemon's rules is not sent: the person is told to fix it", async () => {
  const script = fakeBridge({
    connected: true,
    capabilities: { queue: true, files: true, folders: true, environments: true },
    environments: {
      environments: [
        {
          id: "env-a",
          name: "A",
          variables: [],
          secrets: [],
          actions: [
            { id: "x", name: "One", command: { default: "true" } },
            { id: "x", name: "Two", command: { default: "true" } },
          ],
        },
      ],
      defaults: { local: { "/work": "env-a" } },
    },
  });
  const store = new AppStore(script.bridge);
  await store.start();
  store.openBlank({ locationId: "local", cwd: "/work" });
  await Bun.sleep(1);
  store.drafts.setText(BLANK_KEY, "hi");
  await store.send();
  expect(script.named("createSession")).toEqual([]);
  expect(store.getState().error).toEqual({
    key: "blank.environment.needsFix",
    params: { name: "A" },
  });
  expect(store.drafts.get(BLANK_KEY).text).toBe("hi");
});
