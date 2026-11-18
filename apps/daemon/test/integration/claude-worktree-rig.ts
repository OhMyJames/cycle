/**
 * A scratch repository, a scripted Claude Code model, and the harness over them, for the tests of
 * what happens when Claude Code's agent enters a worktree. No daemon: the harness is driven direct.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeHarness, type ClaudeHarnessOptions } from "@cycle/harness-claude";
import type { AgentSession, HarnessEvent } from "@cycle/protocol";
import { type ClaudeReply, type MockClaude, startMockClaude } from "./mock-claude.ts";

export const SONNET = "claude-sonnet-5-5";
const MODE = "acceptEdits";

export type Script = (prompt: string, results: number) => ClaudeReply;

/** What the scripted model says to each prompt, by the prompt's text, then by the results so far. */
export function scripted(scripts: Record<string, ClaudeReply[]>): Script {
  return (prompt, results) => scripts[prompt.trim()]?.[results] ?? { text: ["done"] };
}

export const enters = (name: string): ClaudeReply => ({
  call: { name: "EnterWorktree", input: { name } },
});
export const leaves = (action: "keep" | "remove", discard = false): ClaudeReply => ({
  call: {
    name: "ExitWorktree",
    input: { action, ...(discard ? { discard_changes: true } : {}) },
  },
});
export const runs = (command: string): ClaudeReply => ({
  call: { name: "Bash", input: { command, description: command } },
});

export interface Rig {
  root: string;
  /** The scratch repository, whose `pkg/` is a subfolder. */
  repo: string;
  claude: MockClaude;
  script: Script;
  /** A harness over the scripted model; each is its own Claude Code processes. */
  harness(options?: Partial<ClaudeHarnessOptions>): ClaudeHarness;
  /** Runs git in the repository (or in `cwd`) and answers what it printed. */
  git(...args: string[]): string;
  gitIn(cwd: string, ...args: string[]): string;
  stop(): void;
}

export function makeRig(): Rig {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cycle-claude-worktree-")));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "pkg"), { recursive: true });
  const rig: Rig = {
    root,
    repo,
    script: () => ({ text: ["done"] }),
    claude: startMockClaude(root, (prompt, results) => rig.script(prompt, results)),
    harness: (options = {}) => new ClaudeHarness({ env: rig.claude.env, ...options }),
    git: (...args) => rig.gitIn(repo, ...args),
    gitIn: (cwd, ...args) => {
      const result = Bun.spawnSync(["git", ...args], { cwd });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString();
    },
    stop: () => {
      rig.claude.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
  writeFileSync(join(repo, "a.txt"), "hi\n");
  writeFileSync(join(repo, "pkg", "p.txt"), "p\n");
  rig.git("init", "-q", "-b", "main");
  rig.git("config", "user.name", "t");
  rig.git("config", "user.email", "t@example.com");
  rig.git("add", "-A");
  rig.git("commit", "-q", "-m", "first");
  return rig;
}

/** A new session in `cwd`. */
export function begin(harness: ClaudeHarness, cwd: string): Promise<AgentSession> {
  return harness.createSession({ cwd, model: SONNET, mode: MODE });
}

/** Sends a prompt and answers every event of the session until the turn ends. */
export async function turn(
  harness: ClaudeHarness,
  sessionId: string,
  text: string,
): Promise<HarnessEvent[]> {
  const events: HarnessEvent[] = [];
  const ended = new Promise<void>((resolve) => {
    const off = harness.onEvent((event) => {
      if (!("sessionId" in event) || event.sessionId !== sessionId) return;
      events.push(event);
      if (event.type === "approval.requested") {
        harness.respondApproval(event.approval.id, { decision: "accept" });
      }
      if (event.type === "turn.completed") {
        off();
        resolve();
      }
    });
  });
  await harness.send(sessionId, { text, images: [] }, { mode: MODE, model: SONNET });
  await ended;
  return events;
}

/** The text of what the scripted model was last told by tool results, as it received them. */
export function toolResults(requests: unknown[]): string[] {
  const out: string[] = [];
  for (const request of requests) {
    const messages = (request as { messages?: { role: string; content: unknown }[] }).messages;
    for (const message of messages ?? []) {
      if (message.role !== "user" || !Array.isArray(message.content)) continue;
      for (const block of message.content as { type: string; content?: unknown }[]) {
        if (block.type === "tool_result") out.push(JSON.stringify(block.content));
      }
    }
  }
  return out;
}
