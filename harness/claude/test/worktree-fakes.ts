import { type HarnessEvent, type WorktreePort } from "@cycle/protocol";
import { ClaudeHarness } from "../src/index.ts";
import type { QueryOptions } from "../src/index.ts";
import type { WireMessage } from "../src/wire.ts";
import { FakeSdk, settle } from "./fake-sdk.ts";

// What the tests of Claude Code's worktree hooks share: a port, a harness with it, and the hooks'
// inputs.

export const options = { mode: "default", model: "claude-sonnet-5-5" };
export const prompt = (text: string) => ({ text, images: [] });
export const signal = new AbortController().signal;
export const init = (cwd: string): WireMessage =>
  Object.assign({ type: "system", subtype: "init" }, { cwd });

/** A port that says what it was asked and answers a worktree, or the failure it is set to. */
export function fakePort() {
  const calls: string[] = [];
  const port: WorktreePort & { fail: string | null } = {
    fail: null,
    enter: async ({ sessionId, name, helper }) => {
      calls.push(`enter ${sessionId} ${name} helper=${helper}`);
      if (port.fail) throw new Error(port.fail);
      return { path: `/repo/.agents/worktree/cycle-${name}` };
    },
    leave: async ({ sessionId, path, helper }) => {
      calls.push(`leave ${sessionId} ${path} helper=${helper}`);
      if (port.fail) throw new Error(port.fail);
    },
  };
  return { port, calls };
}

export async function setup(worktrees: WorktreePort | false = fakePort().port) {
  const sdk = new FakeSdk();
  const logged: string[] = [];
  const harness = new ClaudeHarness({
    sdk,
    env: { CLAUDE_CONFIG_DIR: "/home/me/.claude" },
    schedule: () => () => {},
    now: () => 1000,
    newId: () => "id1",
    onLog: (line) => logged.push(line),
    ...(worktrees ? { worktrees } : {}),
  });
  const events: HarnessEvent[] = [];
  harness.onEvent((event) => events.push(event));
  const session = await harness.createSession({ cwd: "/project", model: options.model });
  await harness.send(session.id, prompt("hello"), options);
  await settle();
  const hooks = sdk.last.options.hooks as NonNullable<QueryOptions["hooks"]>;
  return { sdk, harness, events, logged, hooks, query: sdk.last };
}

export const create = (name: string, extra: { agent_id?: string } = {}) => ({
  hook_event_name: "WorktreeCreate" as const,
  session_id: "the-sdks-own-id",
  cwd: "/repo",
  name,
  ...extra,
});
export const remove = (path: string, extra: { agent_id?: string } = {}) => ({
  hook_event_name: "WorktreeRemove" as const,
  session_id: "the-sdks-own-id",
  cwd: path,
  worktree_path: path,
  ...extra,
});
/** The model asks for a command in the agent's folder. */
export const call = (id: string) => ({
  type: "assistant",
  uuid: `a-${id}`,
  message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }] },
});

/** What a refusal is answered with: its words, one line, after the prefix no folder has. */
export const refusedWith = (words: string) => ({
  hookSpecificOutput: {
    hookEventName: "WorktreeCreate" as const,
    worktreePath: `/cycle-refused: ${words}`,
  },
});
