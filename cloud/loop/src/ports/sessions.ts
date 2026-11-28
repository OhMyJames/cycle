// `Sessions` over a running Cycle daemon: the loop is one more client of it, so every session it makes is one a person
// can open in the desktop app, read, and step into (CYC-318).

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CycleClient, connectUnix, type PermissionAnswer } from "@cycle/client";
import { CycleErrorCode, META } from "@cycle/protocol";
import { answeredAs, answerFor, commandPrefix, decide, kindOf } from "../policy.ts";
import { SessionLost, type SessionRole, type Sessions, type TurnResult } from "../types.ts";

/** Writes one event of a run's log (kind and flat data, no free text). */
export type RecordEvent = (
  run: string,
  kind: string,
  data: Record<string, string | number | boolean>,
) => void | Promise<void>;

/** A request left for a person, kept until the app answers it. */
type Left = {
  sessionId: string;
  run: string;
  request: Record<string, unknown>;
  data: Record<string, string>;
};

/**
 * Requests left for a person, by the daemon's id, so the answer can be recorded with what was asked.
 *
 * The daemon's word that a request was settled and its word that the turn ended come in no fixed order: the agent goes
 * on as soon as it has the answer, and may finish its turn before the settlement reaches the loop. So a request is not
 * dropped when its turn ends, only when it is settled or when the session's next turn starts. A request cancelled with
 * its turn is settled as a cancel, which is not an answer; one never settled goes when the next turn starts.
 */
export class LeftRequests {
  readonly #byId = new Map<string, Left>();

  leave(requestId: string, left: Left): void {
    this.#byId.set(requestId, left);
  }

  /** The request was settled: what was asked and how a person answered, or undefined if it was not an answer. */
  settle(
    requestId: string,
    outcome: unknown,
  ): { left: Left; answer: "allow" | "deny" } | undefined {
    const left = this.#byId.get(requestId);
    if (left === undefined) return undefined;
    this.#byId.delete(requestId);
    const answer = answeredAs(left.request, outcome);
    return answer === undefined ? undefined : { left, answer };
  }

  /** A turn of the session starts: what was left in its earlier turns can no longer be answered. */
  turnStarts(sessionId: string): void {
    for (const [id, left] of this.#byId) if (left.sessionId === sessionId) this.#byId.delete(id);
  }
}

/** The text of a prompt's blocks. */
function promptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((b) =>
      (b as { type?: string; text?: unknown }).type === "text"
        ? String((b as { text: unknown }).text)
        : "",
    )
    .join("");
}

/** A failure of the connection, not an answer from the daemon (those carry a JSON-RPC code). */
function isTransportError(error: unknown): boolean {
  return typeof (error as { code?: unknown } | null)?.code !== "number";
}

type Turn = {
  run: string;
  role: SessionRole;
  worktree: string;
  readRoots: string[] | undefined;
  text: string;
  stop: string | undefined;
  interrupted: boolean;
  /** The prompt being sent, and whether the daemon was seen holding it for its update. */
  sending?: string;
  held?: boolean;
  /** Permission requests nobody has answered yet: the time they wait does not count against the turn. */
  waiting: number;
  finish: () => void;
};

/**
 * The permission mode a read-only role's session is put in, by agent; undefined leaves the agent's default.
 *
 * A new session takes Cycle's default mode, which for Claude is `auto`: Claude Code's own classifier answers every
 * request and none reaches `decide`, so this file's rules would never be asked (found in the CYC-445 pilot). In
 * `default` mode what Claude Code does not allow by itself comes here, and these roles are refused without waiting.
 * Dev stays in the agent's default on purpose: under this policy it would wait for a person at every command outside
 * the allowlist. Other agents name their modes differently and are left as they are until mapped.
 */
const READ_ONLY_MODES: Record<string, string> = { claude: "default" };
const READ_ONLY_ROLES: readonly SessionRole[] = [
  "qa",
  "review",
  "research",
  "research_qa",
  "triage",
  "shape",
  "shape_qa",
  "graph_planner",
];

export const readOnlyMode = (role: SessionRole, agent: string): string | undefined =>
  READ_ONLY_ROLES.includes(role) ? READ_ONLY_MODES[agent] : undefined;

export class DaemonSessions implements Sessions {
  readonly #client: CycleClient;
  readonly #turns = new Map<string, Turn>();
  readonly #watched = new Set<string>();
  readonly #onWaiting: (sessionId: string, title: string) => void;
  readonly #record: RecordEvent;
  readonly #onPermissionResolved: ((sessionId: string) => void) | undefined;
  readonly #projectKey: string | undefined;
  readonly #left = new LeftRequests();
  readonly #cancelledBySupervisor = new Set<string>();

  constructor(
    socketPath: string,
    onWaiting: (sessionId: string, title: string) => void,
    record: RecordEvent = () => {},
    onPermissionResolved?: (sessionId: string) => void,
    projectKey?: string,
  ) {
    this.#onWaiting = onWaiting;
    this.#record = record;
    this.#onPermissionResolved = onPermissionResolved;
    this.#projectKey = projectKey;
    this.#client = new CycleClient({
      name: "auto-loop",
      connect: () => connectUnix(socketPath),
      events: {
        update: (sessionId, update) => this.#update(sessionId, update as Record<string, unknown>),
        permission: (sessionId, request, requestId) =>
          this.#permission(sessionId, request, requestId),
        resolved: (sessionId, requestId, outcome) => {
          const settled = this.#left.settle(String(requestId), outcome);
          if (settled !== undefined)
            this.#emit(settled.left.run, "permission_answered", {
              ...settled.left.data,
              answer: settled.answer,
            });
          const waiter = this.#waiters.get(String(requestId));
          waiter?.({ outcome: "cancelled" });
          const turn = this.#turns.get(sessionId);
          if (turn !== undefined && turn.waiting === 0) {
            this.#onPermissionResolved?.(sessionId);
          }
        },
      },
    });
  }

  readonly #waiters = new Map<string, (answer: PermissionAnswer) => void>();

  async start(): Promise<void> {
    await this.#client.start();
  }

  async cancel(sessionId: string): Promise<boolean> {
    if (!this.#turns.has(sessionId)) return false;
    this.#cancelledBySupervisor.add(sessionId);
    await this.#client.cancel(sessionId).catch(() => {});
    return true;
  }

  async updatePending(): Promise<string | null> {
    if (this.#client.state !== "connected") return null;
    const state = await this.#client.readDaemonUpdate().catch(() => undefined);
    return state?.pending?.version ?? null;
  }

  async close(): Promise<void> {
    await this.#client.close();
  }

  /** Events go out one at a time, in the order they happened. */
  #queue: Promise<void> = Promise.resolve();

  #emit(run: string, kind: string, data: Record<string, string>): void {
    // A failed write must not fail the session's permission handling, but it is not silent.
    this.#queue = this.#queue
      .then(() => this.#record(run, kind, data))
      .catch((error) => console.error(`could not record ${kind} for ${run}: ${String(error)}`));
  }

  #update(sessionId: string, update: Record<string, unknown>): void {
    const turn = this.#turns.get(sessionId);
    if (turn === undefined) return;
    if (update.sessionUpdate === "agent_message_chunk") {
      const content = update.content as { type?: string; text?: string } | undefined;
      if (content?.type === "text" && typeof content.text === "string") turn.text += content.text;
    } else if (update.sessionUpdate === "_cycle/queue_update") {
      // A prompt the daemon holds for its update is sent by the new daemon: seeing it queued, the loop must not resend.
      const entries = Array.isArray(update.entries)
        ? (update.entries as Record<string, unknown>[])
        : [];
      if (
        turn.sending !== undefined &&
        entries.some((e) => e.hold === "update" && promptText(e.prompt) === turn.sending)
      )
        turn.held = true;
    } else if (update.sessionUpdate === "state_update") {
      // `state` is a string; only an `idle` that carries a `stopReason` ends a turn (one without it is a snapshot of the
      // state: docs/protocol.md "turn 的状态由 state_update 表达").
      if (update.state === "idle" && typeof update.stopReason === "string") {
        turn.stop = update.stopReason;
        const error = update.error as { code?: unknown } | undefined;
        turn.interrupted =
          error?.code === CycleErrorCode.DaemonStopped ||
          this.#cancelledBySupervisor.delete(sessionId);
        turn.finish();
      }
    }
  }

  async #permission(
    sessionId: string,
    request: Record<string, unknown>,
    requestId: string | undefined,
  ): Promise<PermissionAnswer> {
    const turn = this.#turns.get(sessionId);
    const key = requestId ?? `${sessionId}:${Date.now()}`;
    const wait = (counted: boolean) =>
      new Promise<PermissionAnswer>((resolve) => {
        if (counted && turn !== undefined) turn.waiting++;
        this.#waiters.set(key, (a) => {
          this.#waiters.delete(key);
          if (counted && turn !== undefined) turn.waiting--;
          resolve(a);
        });
      });
    // No turn of the loop's is running: a person is working in this session (a blocked run they took over). Their
    // requests are theirs; the loop does not answer them, and gives the request up when someone else does.
    if (turn === undefined) return wait(false);
    const verdict = decide(request, {
      role: turn.role,
      worktree: turn.worktree,
      ...(turn.readRoots !== undefined ? { readRoots: turn.readRoots } : {}),
    });
    const answer = answerFor(request, verdict);
    const command = commandPrefix(request, turn.role);
    const data = {
      role: turn.role,
      // Not `kind`: that is the name of the event itself.
      tool: kindOf(request),
      ...(command !== undefined ? { command } : {}),
    };
    // `decide` names an unrecognized kind in its reason: that is the agent's word, so it is not recorded.
    const reason =
      data.tool === "other" && / request$/.test(verdict.reason)
        ? "a request of an unrecognized kind"
        : verdict.reason;
    // Only what the policy did not allow is recorded: the allowed ones are routine.
    if (verdict.decision !== "allow")
      this.#emit(turn.run, "permission_requested", { ...data, decision: verdict.decision, reason });
    if (answer !== undefined) return answer;
    if (requestId !== undefined)
      this.#left.leave(requestId, { sessionId, run: turn.run, request, data });
    // Not for the loop to decide: the request stays open until a person answers it in the app.
    this.#onWaiting(sessionId, typeof request.title === "string" ? request.title : "");
    return wait(true);
  }

  async create(input: {
    role: SessionRole;
    agent: string;
    model?: string;
    effort?: string;
    title: string;
    cwd: string;
    run?: string;
    worktree?: { base: string; name: string };
  }): Promise<{ sessionId: string; cwd: string; branch: string | null }> {
    const sessionId = await this.#client.newSession({
      cwd: input.cwd,
      agent: input.agent,
      origin: {
        kind: "loop",
        role: input.role,
        ...(this.#projectKey !== undefined ? { project: this.#projectKey } : {}),
        ...(input.run !== undefined ? { run: input.run } : {}),
      },
      ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
    });
    const mode = readOnlyMode(input.role, input.agent);
    try {
      if (input.model) await this.#client.setConfig(sessionId, "model", input.model);
      if (input.effort) await this.#client.setConfig(sessionId, "effort", input.effort);
      if (mode !== undefined) await this.#client.setConfig(sessionId, "mode", mode);
    } catch (error) {
      // The session id is never returned, so nobody could remove it later: do it here. The worktree is kept, a
      // replacement or retry session uses the same one.
      await this.#client.delete(sessionId).catch(() => {});
      const what = [
        input.model ? `model ${input.model}` : "",
        input.effort ? `effort ${input.effort}` : "",
        mode !== undefined ? `mode ${mode}` : "",
      ]
        .filter(Boolean)
        .join(", ");
      throw new Error(
        `could not set ${what} for the ${input.role} session: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let cwd = input.cwd;
    let branch: string | null = null;
    if (input.worktree !== undefined) {
      // A session nobody has prompted is not in the daemon's list yet, so its row cannot say where the worktree is.
      // The place is fixed by the protocol (docs/protocol.md §6 "Worktree"): ask git where the main checkout is.
      const row = (await this.#client.listSessions()).find((r) => r.sessionId === sessionId);
      const info = row?._meta?.[META.worktree] as { path?: string; branch?: string } | undefined;
      if (info?.path !== undefined) {
        cwd = info.path;
        branch = info.branch ?? null;
      } else {
        const common = Bun.spawnSync([
          "git",
          "-C",
          input.cwd,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]);
        const gitDir = common.stdout.toString().trim();
        if (common.exitCode !== 0 || gitDir === "")
          throw new Error("could not find the main checkout");
        cwd = join(dirname(gitDir), ".agents", "worktree", input.worktree.name);
        branch = `worktree-${input.worktree.name}`;
        if (!existsSync(cwd)) throw new Error(`the daemon did not make the worktree at ${cwd}`);
      }
    }
    await this.#client.rename(sessionId, input.title).catch(() => {});
    return { sessionId, cwd, branch };
  }

  async #connected(limitMs = 120_000): Promise<void> {
    for (let waited = 0; this.#client.state !== "connected"; waited += 250) {
      if (this.#client.state === "closed" || waited >= limitMs)
        throw new Error("daemon unavailable: the connection did not come back");
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Waits for the connection to drop (briefly: it may already have) and to come back. */
  async #reconnected(): Promise<void> {
    for (let waited = 0; this.#client.state === "connected" && waited < 5_000; waited += 50)
      await new Promise((r) => setTimeout(r, 50));
    await this.#connected();
  }

  /**
   * Sends the prompt. If the connection dropped under it (Cycle is switching to a new version: docs/protocol.md §3),
   * waits for it to come back and sends again, once; that is not a lost session. A prompt the old daemon had taken
   * is ended by its stop, not replayed, so the resend does not double it; one it had queued for the update (`hold:
   * "update"`) is sent by the new daemon, so it is not sent again either. Any other failure is a lost session.
   */
  async #send(sessionId: string, prompt: string): Promise<void> {
    const content = [{ type: "text" as const, text: prompt }];
    const turn = this.#turns.get(sessionId);
    if (turn !== undefined) {
      turn.sending = prompt;
      turn.held = false;
    }
    try {
      await this.#client.prompt(sessionId, content);
      return;
    } catch (error) {
      if (!isTransportError(error) || !(await this.#connectionDropped()))
        throw new SessionLost(String(error));
    }
    try {
      await this.#connected();
      if (turn?.held === true) return;
      await this.#client.prompt(sessionId, content);
    } catch (error) {
      throw new SessionLost(String(error));
    }
  }

  /** Whether the connection is down, or goes down within a moment: the failure may be seen before the close is. */
  async #connectionDropped(): Promise<boolean> {
    for (let waited = 0; waited <= 1_000; waited += 50) {
      if (this.#client.state !== "connected") return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  async turn(
    sessionId: string,
    prompt: string,
    context: {
      run: string;
      role: SessionRole;
      worktree: string;
      timeoutMs: number;
      readRoots?: string[];
    },
  ): Promise<TurnResult> {
    // After an update of Cycle the connection is down or coming back: a prompt sent now would be lost.
    await this.#connected();
    if (!this.#watched.has(sessionId)) {
      try {
        await this.#client.watch(sessionId, context.worktree);
      } catch (error) {
        throw new SessionLost(String(error));
      }
      this.#watched.add(sessionId);
    }
    let finish: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const turn: Turn = {
      run: context.run,
      role: context.role,
      worktree: context.worktree,
      readRoots: context.readRoots,
      text: "",
      stop: undefined,
      interrupted: false,
      waiting: 0,
      finish,
    };
    this.#left.turnStarts(sessionId);
    this.#turns.set(sessionId, turn);
    let timedOut = false;
    let elapsed = 0;
    const timer = setInterval(() => {
      if (turn.waiting > 0) return;
      elapsed += 1000;
      if (elapsed >= context.timeoutMs && !timedOut) {
        timedOut = true;
        void this.#client.cancel(sessionId).catch(() => {});
      }
    }, 1000);
    try {
      await this.#send(sessionId, prompt);
      await ended;
      // The daemon's stop is on record before the client sees the socket close. Let the connection go and come back
      // first, or the resend goes over a dying connection and fails as a lost session.
      clearInterval(timer);
      if (turn.interrupted) await this.#reconnected();
      return {
        stopReason: turn.stop ?? "error",
        text: turn.text,
        timedOut,
        ...(turn.interrupted ? { interrupted: true } : {}),
      };
    } finally {
      clearInterval(timer);
      this.#turns.delete(sessionId);
      this.#cancelledBySupervisor.delete(sessionId);
    }
  }
}
