// `Sessions` over a running Cycle daemon: the loop is one more client of it, so every session it makes is one a person
// can open in the desktop app, read, and step into (CYC-318).

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CycleClient, connectUnix, type PermissionAnswer } from "@cycle/client";
import { CycleErrorCode, META } from "@cycle/protocol";
import { answeredAs, answerFor, commandPrefix, decide, kindOf } from "./policy.ts";
import { SessionLost, type SessionRole, type Sessions, type TurnResult } from "./types.ts";

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

type Turn = {
  run: string;
  role: SessionRole;
  worktree: string;
  text: string;
  stop: string | undefined;
  interrupted: boolean;
  /** Permission requests nobody has answered yet: the time they wait does not count against the turn. */
  waiting: number;
  finish: () => void;
};

export class DaemonSessions implements Sessions {
  readonly #client: CycleClient;
  readonly #turns = new Map<string, Turn>();
  readonly #watched = new Set<string>();
  readonly #onWaiting: (sessionId: string, title: string) => void;
  readonly #record: RecordEvent;
  /** Requests left for a person, by the daemon's id, so the answer can be recorded with what was asked. */
  readonly #left = new Map<string, Left>();

  constructor(
    socketPath: string,
    onWaiting: (sessionId: string, title: string) => void,
    record: RecordEvent = () => {},
  ) {
    this.#onWaiting = onWaiting;
    this.#record = record;
    this.#client = new CycleClient({
      name: "auto-loop",
      connect: () => connectUnix(socketPath),
      events: {
        update: (sessionId, update) => this.#update(sessionId, update as Record<string, unknown>),
        permission: (sessionId, request, requestId) =>
          this.#permission(sessionId, request, requestId),
        resolved: (_sessionId, requestId, outcome) => {
          const left = this.#left.get(String(requestId));
          if (left !== undefined) {
            this.#left.delete(String(requestId));
            const answer = answeredAs(left.request, outcome);
            if (answer !== undefined)
              this.#emit(left.run, "permission_answered", { ...left.data, answer });
          }
          const waiter = this.#waiters.get(String(requestId));
          waiter?.({ outcome: "cancelled" });
          // The answer can overtake the request on this connection: keep it, so the request is not left waiting
          // for an answer that has already come, and the answer is still recorded.
          if (left === undefined && waiter === undefined) {
            this.#early.set(String(requestId), outcome);
            if (this.#early.size > 100) this.#early.delete(this.#early.keys().next().value ?? "");
          }
        },
      },
    });
  }

  /** Outcomes of requests that were resolved before this client had seen the request. */
  readonly #early = new Map<string, unknown>();

  readonly #waiters = new Map<string, (answer: PermissionAnswer) => void>();

  async start(): Promise<void> {
    await this.#client.start();
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
    } else if (update.sessionUpdate === "state_update") {
      // `state` is a string; only an `idle` that carries a `stopReason` ends a turn (one without it is a snapshot of the
      // state: docs/protocol.md "turn 的状态由 state_update 表达").
      if (update.state === "idle" && typeof update.stopReason === "string") {
        turn.stop = update.stopReason;
        const error = update.error as { code?: unknown } | undefined;
        turn.interrupted = error?.code === CycleErrorCode.DaemonStopped;
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
    const verdict = decide(request, { role: turn.role, worktree: turn.worktree });
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
    if (requestId !== undefined) {
      const early = this.#early.get(requestId);
      if (this.#early.delete(requestId)) {
        const answered = answeredAs(request, early);
        if (answered !== undefined)
          this.#emit(turn.run, "permission_answered", { ...data, answer: answered });
        return { outcome: "cancelled" };
      }
      this.#left.set(requestId, { sessionId, run: turn.run, request, data });
    }
    // Not for the loop to decide: the request stays open until a person answers it in the app.
    this.#onWaiting(sessionId, typeof request.title === "string" ? request.title : "");
    return wait(true);
  }

  async create(input: {
    role: SessionRole;
    agent: string;
    title: string;
    cwd: string;
    worktree?: { base: string; name: string };
  }): Promise<{ sessionId: string; cwd: string; branch: string | null }> {
    const sessionId = await this.#client.newSession({
      cwd: input.cwd,
      agent: input.agent,
      ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
    });
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

  async turn(
    sessionId: string,
    prompt: string,
    context: { run: string; role: SessionRole; worktree: string; timeoutMs: number },
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
      text: "",
      stop: undefined,
      interrupted: false,
      waiting: 0,
      finish,
    };
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
      try {
        await this.#client.prompt(sessionId, [{ type: "text", text: prompt }]);
      } catch (error) {
        throw new SessionLost(String(error));
      }
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
      // A request nobody answered before the turn ended is not answered later by anyone the Loop would credit.
      for (const [id, left] of this.#left) if (left.sessionId === sessionId) this.#left.delete(id);
    }
  }
}
