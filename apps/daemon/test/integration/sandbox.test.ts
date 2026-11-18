/**
 * A session whose agent runs in a sandbox, end to end, with a stand-in for Docker's `sbx`
 * (`fake-sbx.sh`): the real Claude Code is started through `sbx exec`, with a home of its own, and
 * what is said there is read back from this side.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeHarness, projectFolder, sandboxCwd, sandboxName } from "@cycle/harness-claude";
import { CodexHarness } from "@cycle/harness-codex";
import type { Item, SessionEvent } from "@cycle/protocol";
import {
  type Daemon,
  Harnesses,
  type OpenProviders,
  type ToolsServer,
  diskFile,
  openProviders,
  startDaemon,
  startTools,
} from "../../src/index.ts";
import { installFakeSbx, openSandboxes } from "./fake-sbx.ts";
import { type ClaudeReply, type MockClaude, startMockClaude } from "./mock-claude.ts";
import { type MockModel, startMockModel } from "./mock-model.ts";
import { type WireClient, connect } from "./wire-client.ts";

const SONNET = "claude-sonnet-5-5";

let daemon: Daemon;
let codexModel: MockModel;
let claude: MockClaude;
let tools: ToolsServer;
let providers: OpenProviders;
let root: string;
let project: string;
let state: string;
let client: WireClient;
let sandboxes: Awaited<ReturnType<typeof openSandboxes>>;
let script: (prompt: string, results: number) => ClaudeReply;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cycle-sbx-"));
  project = join(root, "project");
  mkdirSync(project);
  mkdirSync(join(root, "codex"));
  const sbx = installFakeSbx(root);
  state = sbx.state;

  script = (prompt) => ({ text: ["You said: ", prompt] });
  codexModel = startMockModel(() => ({ text: ["Hello", " from codex"] }));
  claude = startMockClaude(root, (prompt, results) => script(prompt, results));
  tools = startTools("sandbox-test-tools-key");
  providers = await openProviders(
    diskFile(join(root, "home", "providers.json")),
    "gateway-token",
    join(root, "home", "provider-models.json"),
  );
  sandboxes = await openSandboxes(root, { ...process.env, ...claude.env, ...sbx.env });
  daemon = await startDaemon({
    tools,
    providers: providers.store,
    sandboxes,
    harness: new Harnesses(
      new CodexHarness({
        config: codexModel.codexConfig,
        env: { CODEX_HOME: join(root, "codex") },
      }),
      [
        new ClaudeHarness({
          env: claude.env,
          sandboxes: sandboxes.admin,
          tools: { name: "cycle", url: tools.url, key: tools.key },
        }),
      ],
    ),
    home: join(root, "home"),
  });
  client = connect(daemon.url);
  await client.opened;
});

afterAll(async () => {
  client?.close();
  await daemon?.stop();
  tools?.stop();
  providers?.stop();
  codexModel?.stop();
  claude?.stop();
  rmSync(root, { recursive: true, force: true });
});

const of = (sessionId: string) => client.events().filter((event) => event.sessionId === sessionId);
const ended = (sessionId: string) =>
  of(sessionId).filter((event) => event.type === "turn.completed");
const items = (events: SessionEvent[]): Item[] =>
  events.flatMap((event) => (event.type === "item.completed" ? [event.item] : []));

/** Sends a prompt and waits for the turn it starts to end, saying yes to what it asks meanwhile. */
async function turn(sessionId: string, text: string): Promise<SessionEvent[]> {
  const before = of(sessionId).length;
  const turns = ended(sessionId).length;
  const answered = new Set<string>();
  const asked = () =>
    of(sessionId).find(
      (event) => event.type === "approval.requested" && !answered.has(event.approval.id),
    );
  await client.call("session.send", { sessionId, text });
  for (;;) {
    await client.until(() => ended(sessionId).length > turns || asked() !== undefined);
    if (ended(sessionId).length > turns) break;
    const ask = asked();
    if (ask?.type !== "approval.requested") continue;
    answered.add(ask.approval.id);
    await client.call("approval.respond", {
      sessionId,
      approvalId: ask.approval.id,
      response: { decision: "accept" },
    });
  }
  return of(sessionId).slice(before);
}

test("a session's agent runs in the folder's sandbox, and its conversation is kept on this side", async () => {
  const { models } = await client.call("models.list", {});
  expect(models.filter((model) => model.sandbox).map((model) => model.harness)).toContain("claude");
  expect(models.some((model) => model.harness === "codex" && model.sandbox)).toBe(false);

  const name = sandboxName(project, "standard");
  const session = await client.call("session.create", {
    cwd: project,
    model: SONNET,
    mode: "acceptEdits",
    sandbox: "standard",
  });
  expect(session).toMatchObject({ harness: "claude", environment: "standard", sandbox: name });
  expect(readFileSync(join(state, "names"), "utf8")).toBe(`${name}\n`);
  await client.call("session.open", { sessionId: session.id });

  const events = await turn(session.id, "hello from outside");
  expect(events.at(-1)).toMatchObject({ type: "turn.completed", status: "completed" });
  expect(items(events).at(-1)).toMatchObject({ text: "You said: hello from outside" });
  // It was the sandbox's own Claude Code that ran, at the sandbox's path for the folder.
  expect(readFileSync(join(state, "execs"), "utf8")).toBe(
    `${name} ${sandboxCwd(project)} claude\n`,
  );

  // A command of the agent's runs inside: its home is the sandbox's, and it holds no key of ours.
  const look = { name: "Bash", input: { command: "echo home=$HOME; env" } };
  script = (_prompt, results) => (results ? { text: ["looked"] } : { call: look });
  const looked = items(await turn(session.id, "look around")).find(
    (item) => item.kind === "command",
  );
  const output = looked?.kind === "command" ? looked.output : "";
  expect(output).toContain(`home=${join(state, name, "home")}`);
  expect(output).not.toContain("sandbox-test-tools-key");
  expect(output).not.toContain("CODEX_HOME");

  // The conversation is in the sandbox's own home, under the folder's name there; none of the
  // owner's Claude Code home went into the sandbox.
  const home = join(root, "home", "sandboxes", name, "claude");
  const folder = projectFolder(sandboxCwd(project));
  expect(readdirSync(join(home, "projects", folder))).toContain(`${session.id}.jsonl`);
  expect(readdirSync(join(state, name, "home", ".claude", "projects"))).toContain(folder);
  expect(existsSync(join(root, "claude", "projects", projectFolder(project)))).toBe(false);
  const reader = new ClaudeHarness({ env: claude.env, sandboxes: sandboxes.admin });
  const stored = await reader.loadSession(session.id, { sandbox: name });
  await reader.dispose();
  expect(stored.turns.map((each) => each.items.map((item) => item.kind))).toEqual([
    ["userMessage", "agentMessage"],
    ["userMessage", "command", "agentMessage"],
  ]);
  const { sessions } = await client.call("session.list", { archived: false });
  expect(sessions.find((info) => info.id === session.id)).toMatchObject({
    environment: "standard",
    sandbox: name,
  });
});

test("a second session in the folder shares its sandbox, and one outside a sandbox runs here", async () => {
  script = (prompt) => ({ text: ["You said: ", prompt] });
  const second = await client.call("session.create", {
    cwd: project,
    model: SONNET,
    sandbox: "standard",
  });
  await client.call("session.open", { sessionId: second.id });
  await turn(second.id, "another");
  expect(readFileSync(join(state, "names"), "utf8").trim().split("\n")).toHaveLength(1);

  const execs = readFileSync(join(state, "execs"), "utf8");
  const local = await client.call("session.create", { cwd: project, model: SONNET });
  expect(local.sandbox).toBeNull();
  await client.call("session.open", { sessionId: local.id });
  await turn(local.id, "on this machine");
  expect(readFileSync(join(state, "execs"), "utf8")).toBe(execs);

  // Codex has no sandbox to run in yet, and a worktree's history would be left outside one.
  expect(client.call("session.create", { cwd: project, sandbox: "standard" })).rejects.toThrow(
    "Codex sessions do not run in a sandbox yet.",
  );
  expect(existsSync(join(state, "names"))).toBe(true);
});

test("a sandbox is made with what its environment says, and the next folder's starts from the saved one", async () => {
  const saved = await client.call("sandboxes.save", {
    name: "Node projects",
    cpus: 2,
    memoryGb: 4,
    hosts: ["registry.example.com"],
    variables: { BUILD_FLAVOR: "blue-green" },
    setup: 'echo "$BUILD_FLAVOR" > "$HOME/tools-installed"',
  });
  expect(saved).toMatchObject({ id: "node-projects", variables: ["BUILD_FLAVOR"] });
  const listed = await client.call("sandboxes.list", {});
  expect(listed.available).toBe(true);
  expect(listed.environments.map((one) => one.id)).toEqual(["standard", "node-projects"]);
  // A variable's value stays in the daemon.
  expect(JSON.stringify(listed)).not.toContain("blue-green");

  const session = await client.call("session.create", {
    cwd: project,
    model: SONNET,
    mode: "acceptEdits",
    sandbox: saved.id,
  });
  const name = sandboxName(project, saved.id);
  expect(session.sandbox).toBe(name);
  expect(
    readFileSync(join(state, name, "made"), "utf8")
      .trim()
      .split("\n"),
  ).toEqual(["--cpus 2", "--memory 4g", "env BUILD_FLAVOR=blue-green"]);
  expect(readFileSync(join(state, name, "network"), "utf8")).toBe("allow registry.example.com\n");
  // The setup script ran inside, with the environment's variable, and the sandbox was saved.
  expect(readFileSync(join(state, name, "home", "tools-installed"), "utf8")).toBe("blue-green\n");
  expect(readdirSync(join(state, "templates"))).toHaveLength(1);
  // No value was in an argument of `sbx`.
  expect(readFileSync(join(state, "asked"), "utf8")).not.toContain("blue-green");

  // The agent's commands have the variable too.
  await client.call("session.open", { sessionId: session.id });
  const look = { name: "Bash", input: { command: "echo flavor=$BUILD_FLAVOR" } };
  script = (_prompt, results) => (results ? { text: ["looked"] } : { call: look });
  const looked = items(await turn(session.id, "look")).find((item) => item.kind === "command");
  expect(looked?.kind === "command" ? looked.output : "").toContain("flavor=blue-green");

  // Another folder's sandbox starts from the saved one: what the script left is there, unrun.
  const other = join(root, "other");
  mkdirSync(other);
  const execs = readFileSync(join(state, "execs"), "utf8");
  const next = await client.call("session.create", {
    cwd: other,
    model: SONNET,
    sandbox: saved.id,
  });
  expect(next.sandbox).toBe(sandboxName(other, saved.id));
  expect(existsSync(join(state, next.sandbox ?? "", "home", "tools-installed"))).toBe(true);
  expect(readFileSync(join(state, "execs"), "utf8")).toBe(execs);

  expect(
    client.call("session.create", { cwd: project, model: SONNET, sandbox: "gone" }),
  ).rejects.toThrow("That sandbox environment is gone.");
});

test("a sign-in goes to sbx and is not given back", async () => {
  const before = await client.call("sandboxes.secrets", {});
  expect(before.secrets.find((one) => one.service === "anthropic")?.set).toBe(false);
  await client.call("sandboxes.secret.set", { service: "anthropic", value: "sk-ant-test-123" });
  const after = await client.call("sandboxes.secrets", {});
  expect(after.secrets.find((one) => one.service === "anthropic")?.set).toBe(true);
  expect(JSON.stringify(after)).not.toContain("sk-ant-test-123");
  expect(readFileSync(join(state, "secrets"), "utf8")).toBe("anthropic sk-ant-test-123\n");
  expect(readFileSync(join(state, "asked"), "utf8")).not.toContain("sk-ant-test-123");
  expect(readFileSync(join(root, "home", "sandboxes.json"), "utf8")).not.toContain("sk-ant-test");
});
