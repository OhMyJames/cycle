// `cycle stop`: what it asks the daemon before it stops it, and what it says. docs/daemon.md "停止和升级".
import { CycleClient, connectUnix, ProtocolMismatchError, type SessionRow } from "@cycle/client";
import { META } from "@cycle/protocol";

/** A session a stop would cut short, as the session list shows it. */
export type Working = {
  sessionId: string;
  title?: string;
  state: string;
  background: number;
};

/**
 * The sessions that are working, from `session/list`: a turn running or waiting on the owner, or background
 * sub-agents. The list, not a method of its own, so that a new `cycle` can ask an older daemon (an upgrade does).
 */
export const workingOf = (rows: readonly SessionRow[]): Working[] =>
  rows.flatMap((row) => {
    const meta = row._meta ?? {};
    const state = typeof meta[META.state] === "string" ? (meta[META.state] as string) : "unknown";
    const said = meta[META.background];
    const background = typeof said === "number" ? said : 0;
    if (state !== "running" && state !== "requires_action" && background === 0) return [];
    const title = (row as { title?: unknown }).title ?? meta.title;
    return [
      {
        sessionId: row.sessionId,
        ...(typeof title === "string" && title !== "" ? { title } : {}),
        state,
        background,
      },
    ];
  });

/** Asks the daemon on a socket which of its sessions are working. Speaks the daemon's protocol when it is another. */
export const askWorking = async (socket: string, timeoutMs = 5_000): Promise<Working[]> => {
  const once = async (protocolVersion?: string): Promise<Working[]> => {
    const client = new CycleClient({
      connect: () => connectUnix(socket),
      name: "cycle-stop",
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    });
    try {
      await client.start();
      return workingOf(await client.listSessions());
    } finally {
      await client.close();
    }
  };
  const asking = once().catch((error: unknown) => {
    // Only reading a list: the version it speaks has one, whatever else differs.
    const theirs = error instanceof ProtocolMismatchError ? error.supported[0] : undefined;
    if (theirs === undefined) throw error;
    return once(theirs);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("it did not answer in time")), timeoutMs);
  });
  try {
    return await Promise.race([asking, late]);
  } finally {
    clearTimeout(timer);
  }
};

const nameOf = (w: Working) => w.title ?? w.sessionId;

/** One line per session: what it is doing, in words. */
export const describeWorking = (working: readonly Working[]): string[] =>
  working.map((w) => {
    const doing: string[] = [];
    if (w.state === "running") doing.push("a turn is running");
    if (w.state === "requires_action") doing.push("waiting for an answer to a request");
    if (w.background > 0)
      doing.push(`${w.background} background task${w.background === 1 ? "" : "s"}`);
    return `  - ${nameOf(w)}: ${doing.join(", ")}`;
  });

/** What stopping now loses, said before it is done. */
export const LOST = [
  "Stopping now interrupts them:",
  "  - a running turn ends, and the history marks it as interrupted;",
  "  - requests waiting for an answer are cancelled;",
  "  - background tasks are stopped and are not restarted.",
  "Messages waiting in a queue are kept, and come back to the input box.",
];

export type StopChoice = "wait" | "force" | "cancel";

export type StopDeps = {
  force: boolean;
  wait: boolean;
  /** Whether a person is there to answer (stdin is a terminal). */
  interactive: boolean;
  isRunning: () => Promise<boolean>;
  working: () => Promise<Working[]>;
  /** Asks the person what to do, when the daemon is working and no flag said. */
  choose: (question: string, unknown: boolean) => Promise<StopChoice>;
  /** Sends the daemon its stop signal. */
  signal: () => void;
  say: (line: string) => void;
  /** Between looks while waiting. */
  pollMs?: number;
  /** How long the daemon has to go once it is told to. */
  stopWithinMs?: number;
};

/** Exit codes: 0 stopped (or was not running), 1 did not stop, 4 not stopped because it is working. */
export const BUSY_EXIT = 4;

/**
 * Stops a daemon, but not over work in progress without being told to: the work is listed, and the person waits for
 * it (`--wait`), stops anyway (`--force`), or, at a terminal, chooses. Without a terminal and without a flag it is
 * not stopped (exit 4).
 */
export const stopDaemon = async (deps: StopDeps): Promise<number> => {
  const { say } = deps;
  const look = async (): Promise<Working[] | Error> =>
    deps
      .working()
      .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  let working = await look();
  if (working instanceof Error) {
    say(`Could not ask the daemon what it is doing (${working.message}).`);
  } else if (working.length > 0) {
    say(`${working.length} session${working.length === 1 ? " is" : "s are"} working:`);
    for (const line of describeWorking(working)) say(line);
  }
  const busy = working instanceof Error || working.length > 0;
  let choice: StopChoice | undefined = busy ? undefined : "force";
  if (busy && deps.force) choice = "force";
  else if (busy && deps.wait) choice = "wait";
  else if (busy && deps.interactive) {
    say("");
    choice = await deps.choose(
      working instanceof Error
        ? "Stop it anyway? [f]orce stop, [c]ancel: "
        : "[w]ait until they finish, then stop; [f]orce stop now; [c]ancel: ",
      working instanceof Error,
    );
  }
  if (choice === undefined || choice === "cancel") {
    say(
      choice === "cancel"
        ? "Not stopped."
        : "Not stopped. Run `cycle stop --wait` to stop once they finish, or `cycle stop --force` to stop now.",
    );
    return BUSY_EXIT;
  }
  if (choice === "wait") {
    if (working instanceof Error) {
      say("Cannot wait for work the daemon does not say. Not stopped.");
      return BUSY_EXIT;
    }
    say("Waiting for them to finish. (Ctrl-C leaves the daemon running.)");
    const poll = deps.pollMs ?? 2_000;
    while (working.length > 0) {
      await Bun.sleep(poll);
      if (!(await deps.isRunning())) {
        say("stopped");
        return 0;
      }
      const now = await look();
      if (now instanceof Error) {
        say(`Could not ask the daemon what it is doing (${now.message}). Not stopped.`);
        return 1;
      }
      working = now;
    }
  } else if (busy) {
    for (const line of LOST) say(line);
  }
  deps.signal();
  const started = Date.now();
  const within = deps.stopWithinMs ?? 10_000;
  // The answer is the look that ended the wait, not another one after it: two looks can disagree.
  let gone = !(await deps.isRunning());
  while (!gone && Date.now() - started < within) {
    await Bun.sleep(50);
    gone = !(await deps.isRunning());
  }
  say(gone ? "stopped" : `did not stop within ${Math.round(within / 1000)}s`);
  return gone ? 0 : 1;
};
