import { expect, test } from "bun:test";
import { ClaudeHarness, plainSpec, sandboxName } from "../src/index.ts";
import { fakeSbx } from "./fake-sbx.ts";
import { FakeSdk, user } from "./fake-sdk.ts";

/**
 * The name of a session's container is told by the daemon and derived from the folder and the
 * environment: for a session this harness made they are one, so a daemon may be told either.
 */

const HOMES = "/home/me/.cycle/sandboxes";

function setup() {
  const sdk = new FakeSdk();
  const sbx = fakeSbx([], [plainSpec("node")]);
  let ids = 0;
  /** A harness as a daemon starts it: it knows nothing of the sessions an earlier one made. */
  const start = () =>
    new ClaudeHarness({
      sdk,
      env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" },
      bin: "/opt/claude",
      sandboxes: sbx.sandboxes,
      tools: { name: "cycle", url: "http://127.0.0.1:1/mcp", key: "the-tools-key" },
      schedule: () => () => {},
      now: () => 1000,
      newId: () => `id${++ids}`,
    });
  return { sdk, start, ...sbx };
}

test("a session made in a sandbox has the name its folder and environment make, and is found by it", async () => {
  const { sdk, start } = setup();
  const name = sandboxName("/Users/me/App", "node");
  const session = await start().createSession({
    cwd: "/Users/me/App",
    sandboxed: "node",
    mode: "acceptEdits",
  });
  expect(session.sandbox).toBe(name);
  // What it said is in its sandbox's home, as the conversation of an earlier daemon.
  sdk.homes[`${HOMES}/${name}/claude`] = {
    stored: [
      { sessionId: session.id, summary: "", lastModified: 5, cwd: "/home/agent/workspace/App" },
    ],
    messages: { [session.id]: [user("u1", "hello")] },
  };
  const later = await start().loadSession(session.id, { sandbox: name });
  expect(later.session).toMatchObject({
    sandbox: name,
    cwd: "/Users/me/App",
    sandboxCwd: "/home/agent/workspace/App",
  });
  expect(later.turns).toHaveLength(1);
  // Without being told, it still finds the session where it was kept, by the same name.
  expect((await start().loadSession(session.id, {})).session.sandbox).toBe(name);
});

test("a session known only from the owner's home is put in its environment's container as it opens", async () => {
  const { sdk, made, sandboxes } = setup();
  const name = sandboxName("/Users/me/app", "node");
  const moved: [string, string][] = [];
  const harness = new ClaudeHarness({
    sdk,
    env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" },
    bin: "/opt/claude",
    sandboxes,
    files: {
      async move(from, to) {
        moved.push([from, to]);
        return true;
      },
    },
    tools: { name: "cycle", url: "http://127.0.0.1:1/mcp", key: "the-tools-key" },
    schedule: () => () => {},
    now: () => 1000,
  });
  made[name] = { environment: "node", version: "v", hosts: [] };
  sdk.stored = [{ sessionId: "s1", summary: "", lastModified: 5, cwd: "/Users/me/app" }];
  sdk.messages = { s1: [user("u1", "before")] };
  // Told the environment alone, with no name: the harness makes the name its sandboxes have.
  const loaded = await harness.loadSession("s1", { environment: "node" });
  expect(loaded.session.sandbox).toBe(name);
  expect(moved.map(([, to]) => to)).toEqual([
    `${HOMES}/${name}/claude/projects/-home-agent-workspace-app/s1.jsonl`,
    `${HOMES}/${name}/claude/projects/-home-agent-workspace-app/s1`,
  ]);
});

test("a turn told its environment alone runs in that environment's container", async () => {
  const { sdk, start, made, asked } = setup();
  const name = sandboxName("/Users/me/app", "node");
  sdk.homes[`${HOMES}/${name}/claude`] = {
    stored: [{ sessionId: "s1", summary: "", lastModified: 5, cwd: "/home/agent/workspace/app" }],
    messages: { s1: [user("u1", "before")] },
  };
  made[name] = { environment: "node", version: "v", hosts: [], cwd: "/Users/me/app" };
  await start().send("s1", { text: "again", images: [] }, { environment: "node" });
  expect(sdk.last.options.pathToClaudeCodeExecutable).toBe("claude");
  expect(sdk.last.options.cwd).toBe("/home/agent/workspace/app");
  expect(asked.some((args) => args.includes(name))).toBe(true);
});
