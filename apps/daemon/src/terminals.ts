import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import {
  CycleErrorCode,
  TERMINAL_LIMITS,
  TERMINAL_NOTIFICATIONS,
  type TerminalAttached,
  type TerminalInfo,
} from "@cycle/protocol";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as Headless } from "@xterm/headless";
import { INVALID_PARAMS, RESOURCE_NOT_FOUND, RpcError } from "./errors.ts";
import { type Logger, silentLogger } from "./logger.ts";

/*
 * The terminals the person opens beside a session (docs/protocol.md §8 "终端", decision note
 * 2026-11-22-terminals-in-the-daemon-over-l1). Each is a login shell on a pseudo-terminal of Bun's own, in the
 * session's folder, with an environment built from an allowlist. A headless xterm keeps what it shows, so a client
 * that attaches later, or falls behind, gets the screen instead of a replay. Agents never reach any of it.
 */

/** A shell on a pseudo-terminal. */
export type Pty = {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Closes the terminal's end: the kernel hangs up its foreground job. */
  hangup(): void;
  /** Resolves with the exit code, or null when a signal ended it. */
  readonly exited: Promise<number | null>;
};

export type PtySpawnOptions = {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  onData: (data: Uint8Array) => void;
};

export type PtySpawn = (options: PtySpawnOptions) => Pty;

/** What a terminal shows. Writes are parsed in order; `parsed` is called once that write is. */
export type Screen = {
  write(data: string, parsed: () => void): void;
  /** Resolves with the redraw of everything parsed before the call, once it is. */
  snapshot(): Promise<string>;
  resize(cols: number, rows: number): void;
  onTitle(listener: (title: string) => void): void;
  dispose(): void;
};

export type ScreenFactory = (options: { cols: number; rows: number; scrollback: number }) => Screen;

/** A connection a terminal's output goes to. `send` resolves once the message is written out. */
export type TerminalSink = {
  readonly id: string;
  send(method: string, params: unknown): Promise<void>;
};

export type TerminalsOptions = {
  /** The shell's environment: what the allowlist let through, already picked. */
  env: Record<string, string>;
  /** The shell to start, as a login shell. */
  shell: string;
  maxPerSession: number;
  max: number;
  scrollback: number;
  /** A session's terminals changed: what `list` would answer. */
  onChanged: (sessionId: string, terminals: TerminalInfo[]) => void;
  log?: Logger;
  /** For tests. */
  spawn?: PtySpawn;
  screen?: ScreenFactory;
  /** How long a closed shell has after SIGHUP before SIGKILL. */
  killGraceMs?: number;
  /** Output is gathered for this long, or up to `batchBytes`, into one piece. */
  batchMs?: number;
  batchBytes?: number;
  /** Past this many bytes not yet written out to a connection, it gets no more output until a `reset`. */
  behindBytes?: number;
  /** Past this many bytes the screen has not parsed yet, output is left out of it rather than kept. */
  screenBacklogBytes?: number;
};

/** Picks the shell's environment from the daemon's: only the names allowed (a name ending in `*` is a prefix). */
export const terminalEnv = (
  allow: readonly string[],
  source: Record<string, string | undefined>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const allowed = allow.some((pattern) =>
      pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
    );
    if (allowed) env[name] = value;
  }
  // Where the shell starts reading its own files. Not a secret, and a shell without it misbehaves.
  env.HOME ??= homedir();
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
};

/** The person's shell when it can be run, else `/bin/sh`. */
export const terminalShell = (shell: string | undefined): string => {
  if (shell?.startsWith("/")) {
    try {
      accessSync(shell, constants.X_OK);
      return shell;
    } catch {}
  }
  return "/bin/sh";
};

export const bunPtySpawn: PtySpawn = (options) => {
  const proc = Bun.spawn(options.argv, {
    cwd: options.cwd,
    env: options.env,
    terminal: {
      cols: options.cols,
      rows: options.rows,
      data: (_terminal, data) => options.onData(data),
    },
  });
  const terminal = proc.terminal;
  if (terminal === undefined) throw new Error("no pseudo-terminal");
  return {
    pid: proc.pid,
    write: (data) => {
      if (!terminal.closed) terminal.write(data);
    },
    resize: (cols, rows) => {
      if (!terminal.closed) terminal.resize(cols, rows);
    },
    hangup: () => {
      if (!terminal.closed) terminal.close();
    },
    exited: proc.exited.then((code) => {
      terminal.close();
      return proc.signalCode !== null ? null : code;
    }),
  };
};

export const xtermScreen: ScreenFactory = ({ cols, rows, scrollback }) => {
  const term = new Headless({ cols, rows, scrollback, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer as never);
  return {
    write: (data, parsed) => term.write(data, parsed),
    // A write's callback runs once it is parsed and before any later write is: an empty one marks "everything
    // written so far".
    snapshot: () => new Promise((resolve) => term.write("", () => resolve(serializer.serialize()))),
    resize: (c, r) => term.resize(c, r),
    onTitle: (listener) => {
      term.onTitleChange(listener);
    },
    dispose: () => term.dispose(),
  };
};

type Viewer = {
  sink: TerminalSink;
  /** Bytes sent and not yet written out. */
  inflight: number;
  /** `live`: gets output. `behind`: gets none until it catches up. `syncing`: a reset is being made; output waits. */
  state: "live" | "behind" | "syncing";
  waiting: { seq: number; data: string }[];
};

type Entry = {
  info: TerminalInfo;
  pty: Pty;
  screen: Screen;
  decoder: TextDecoder;
  /** The last piece of output made. */
  seq: number;
  batch: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Bytes written to the screen and not yet parsed. */
  backlog: number;
  viewers: Map<string, Viewer>;
  closing: Promise<void> | undefined;
};

const notFound = (terminalId: string) =>
  new RpcError(RESOURCE_NOT_FOUND, "Terminal not found", { terminalId });

let counter = 0;
const newTerminalId = () =>
  `t_${Date.now().toString(36)}${(++counter).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export class Terminals {
  readonly #options: TerminalsOptions;
  readonly #spawn: PtySpawn;
  readonly #screen: ScreenFactory;
  readonly #log: Logger;
  readonly #terminals = new Map<string, Entry>();

  constructor(options: TerminalsOptions) {
    this.#options = options;
    this.#spawn = options.spawn ?? bunPtySpawn;
    this.#screen = options.screen ?? xtermScreen;
    this.#log = options.log ?? silentLogger;
  }

  list(sessionId: string): TerminalInfo[] {
    return [...this.#terminals.values()]
      .filter((entry) => entry.info.sessionId === sessionId && entry.closing === undefined)
      .map((entry) => ({ ...entry.info }));
  }

  /** Opens a terminal in `cwd` for a session, and attaches `sink` to it. */
  async create(
    sessionId: string,
    cwd: string,
    cols: number,
    rows: number,
    sink: TerminalSink,
  ): Promise<TerminalAttached> {
    if (this.list(sessionId).length >= this.#options.maxPerSession)
      throw new RpcError(
        CycleErrorCode.TerminalLimit,
        "This session has as many terminals as it may",
        {
          sessionId,
          limit: this.#options.maxPerSession,
        },
      );
    if (this.#terminals.size >= this.#options.max)
      throw new RpcError(
        CycleErrorCode.TerminalLimit,
        "The daemon has as many terminals as it may",
        {
          sessionId,
          limit: this.#options.max,
        },
      );
    let isFolder = false;
    try {
      isFolder = statSync(cwd).isDirectory();
    } catch {}
    if (!isFolder)
      throw new RpcError(INVALID_PARAMS, "The session's folder is not there", {
        sessionId,
        reason: "cwd_missing",
      });

    const terminalId = newTerminalId();
    const screen = this.#screen({ cols, rows, scrollback: this.#options.scrollback });
    // Output can come as soon as the shell starts: it waits for the entry it belongs to.
    let entry: Entry | undefined;
    const early: Uint8Array[] = [];
    let pty: Pty;
    try {
      pty = this.#spawn({
        argv: [this.#options.shell, "-l"],
        cwd,
        env: this.#options.env,
        cols,
        rows,
        onData: (data) => (entry ? this.#onData(entry, data) : early.push(data)),
      });
    } catch (error) {
      screen.dispose();
      this.#log.warn("terminal_spawn_failed", { session: sessionId });
      throw new RpcError(INVALID_PARAMS, "The shell could not be started", {
        sessionId,
        reason: "spawn_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    entry = {
      info: {
        terminalId,
        sessionId,
        title: basename(this.#options.shell),
        cols,
        rows,
        status: "running",
      },
      pty,
      screen,
      decoder: new TextDecoder(),
      seq: 0,
      batch: "",
      timer: undefined,
      backlog: 0,
      viewers: new Map(),
      closing: undefined,
    };
    const created = entry;
    for (const data of early) this.#onData(created, data);
    screen.onTitle((title) => {
      created.info.title = title.slice(0, 200);
      this.#changed(sessionId);
    });
    this.#terminals.set(terminalId, created);
    this.#log.info("terminal_opened", { session: sessionId, terminal: terminalId });
    void pty.exited.then((code) => this.#onExit(created, code));
    this.#changed(sessionId);
    return this.#attach(created, sink);
  }

  attach(terminalId: string, sink: TerminalSink): Promise<TerminalAttached> {
    return this.#attach(this.#entry(terminalId), sink);
  }

  detach(terminalId: string, sinkId: string): void {
    this.#entry(terminalId).viewers.delete(sinkId);
  }

  /** A connection went: it watches nothing any more. */
  detachAll(sinkId: string): void {
    for (const entry of this.#terminals.values()) entry.viewers.delete(sinkId);
  }

  input(terminalId: string, data: string): void {
    const entry = this.#entry(terminalId);
    if (Buffer.byteLength(data) > TERMINAL_LIMITS.input)
      throw new RpcError(INVALID_PARAMS, "Too much input at once", {
        terminalId,
        reason: "too_large",
      });
    if (entry.info.status === "exited")
      throw new RpcError(INVALID_PARAMS, "The terminal's shell has exited", {
        terminalId,
        reason: "exited",
      });
    entry.pty.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const entry = this.#entry(terminalId);
    if (entry.info.cols === cols && entry.info.rows === rows) return;
    entry.info.cols = cols;
    entry.info.rows = rows;
    if (entry.info.status === "running") entry.pty.resize(cols, rows);
    entry.screen.resize(cols, rows);
    this.#changed(entry.info.sessionId);
  }

  /** Ends the shell's whole process group and forgets the terminal. */
  close(terminalId: string): Promise<void> {
    return this.#close(this.#entry(terminalId));
  }

  /** A session was archived or deleted. */
  closeSession(sessionId: string): Promise<void> {
    const entries = [...this.#terminals.values()].filter((e) => e.info.sessionId === sessionId);
    return Promise.all(entries.map((entry) => this.#close(entry))).then(() => {});
  }

  /** The daemon is stopping. */
  closeAll(): Promise<void> {
    return Promise.all([...this.#terminals.values()].map((entry) => this.#close(entry))).then(
      () => {},
    );
  }

  /** How many there are, for tests and the log. */
  get size(): number {
    return this.#terminals.size;
  }

  #entry(terminalId: string): Entry {
    const entry = this.#terminals.get(terminalId);
    if (entry === undefined || entry.closing !== undefined) throw notFound(terminalId);
    return entry;
  }

  async #attach(entry: Entry, sink: TerminalSink): Promise<TerminalAttached> {
    // Output made from here on goes to the sink; what came before is in the snapshot taken of it now. Both may
    // carry the same piece; the client drops output whose seq the answer already covers.
    this.#flush(entry);
    const seq = entry.seq;
    const viewer: Viewer = { sink, inflight: 0, state: "live", waiting: [] };
    entry.viewers.set(sink.id, viewer);
    const screen = await entry.screen.snapshot();
    return { terminal: { ...entry.info }, screen, seq };
  }

  #onData(entry: Entry, data: Uint8Array): void {
    const text = entry.decoder.decode(data, { stream: true });
    if (text.length === 0) return;
    entry.batch += text;
    if (entry.batch.length >= (this.#options.batchBytes ?? 64 * 1024)) this.#flush(entry);
    else entry.timer ??= setTimeout(() => this.#flush(entry), this.#options.batchMs ?? 16);
  }

  /** Makes what was gathered one piece of output: to the screen, and to each connection watching. */
  #flush(entry: Entry): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    const data = entry.batch;
    if (data.length === 0) return;
    entry.batch = "";
    const seq = ++entry.seq;
    const bytes = Buffer.byteLength(data);
    if (entry.backlog + bytes <= (this.#options.screenBacklogBytes ?? 8 * 1024 * 1024)) {
      entry.backlog += bytes;
      entry.screen.write(data, () => {
        entry.backlog -= bytes;
      });
    } else {
      // A shell printing faster than the screen parses: left out of the screen rather than held in memory.
      this.#log.warn("terminal_screen_behind", { terminal: entry.info.terminalId });
    }
    for (const viewer of entry.viewers.values()) this.#deliver(entry, viewer, seq, data);
  }

  #deliver(entry: Entry, viewer: Viewer, seq: number, data: string): void {
    if (viewer.state === "syncing") {
      viewer.waiting.push({ seq, data });
      return;
    }
    if (viewer.state === "behind") return;
    if (viewer.inflight > (this.#options.behindBytes ?? 1024 * 1024)) {
      // It is not taking what it is sent: no more until it has, then the screen as it is by then.
      viewer.state = "behind";
      return;
    }
    this.#send(entry, viewer, TERMINAL_NOTIFICATIONS.output, {
      terminalId: entry.info.terminalId,
      seq,
      data,
    });
  }

  #send(entry: Entry, viewer: Viewer, method: string, params: { [key: string]: unknown }): void {
    const bytes =
      typeof params.data === "string"
        ? params.data.length
        : typeof params.screen === "string"
          ? params.screen.length
          : 0;
    viewer.inflight += bytes;
    void viewer.sink
      .send(method, params)
      .catch(() => {})
      .finally(() => {
        viewer.inflight -= bytes;
        if (viewer.state === "behind" && viewer.inflight === 0) void this.#reset(entry, viewer);
      });
  }

  /** Brings a connection that fell behind up to date: the screen now, then what comes after it. */
  async #reset(entry: Entry, viewer: Viewer): Promise<void> {
    if (entry.viewers.get(viewer.sink.id) !== viewer) return;
    this.#flush(entry);
    const seq = entry.seq;
    viewer.state = "syncing";
    viewer.waiting = [];
    const screen = await entry.screen.snapshot();
    if (entry.viewers.get(viewer.sink.id) !== viewer) return;
    this.#send(entry, viewer, TERMINAL_NOTIFICATIONS.reset, {
      terminalId: entry.info.terminalId,
      seq,
      screen,
      cols: entry.info.cols,
      rows: entry.info.rows,
    });
    viewer.state = "live";
    const waiting = viewer.waiting;
    viewer.waiting = [];
    for (const piece of waiting) this.#deliver(entry, viewer, piece.seq, piece.data);
  }

  #onExit(entry: Entry, code: number | null): void {
    const tail = entry.decoder.decode();
    if (tail.length > 0) entry.batch += tail;
    this.#flush(entry);
    entry.info.status = "exited";
    entry.info.exitCode = code;
    this.#log.info("terminal_exited", { terminal: entry.info.terminalId });
    if (entry.closing === undefined) this.#changed(entry.info.sessionId);
  }

  #close(entry: Entry): Promise<void> {
    entry.closing ??= (async () => {
      const { terminalId, sessionId } = entry.info;
      if (entry.info.status === "running") {
        const group = -entry.pty.pid;
        const signal = (name: NodeJS.Signals) => {
          try {
            process.kill(group, name);
          } catch {}
        };
        // The shell's group, and through the closed terminal the job in front, which runs in a group of its
        // own (job control). Both are what a closed terminal window does; a shell that outlives them is killed.
        signal("SIGHUP");
        entry.pty.hangup();
        const grace = this.#options.killGraceMs ?? 2000;
        const ended = await Promise.race([
          entry.pty.exited.then(() => true),
          Bun.sleep(grace).then(() => false),
        ]);
        if (!ended) {
          signal("SIGKILL");
          await Promise.race([entry.pty.exited, Bun.sleep(grace)]);
        }
      }
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.viewers.clear();
      entry.screen.dispose();
      this.#terminals.delete(terminalId);
      this.#log.info("terminal_closed", { session: sessionId, terminal: terminalId });
      this.#changed(sessionId);
    })();
    return entry.closing;
  }

  #changed(sessionId: string): void {
    this.#options.onChanged(sessionId, this.list(sessionId));
  }
}
