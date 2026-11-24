import { dlopen, FFIType } from "bun:ffi";
import { accessSync, constants, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
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
  /**
   * The processes whose controlling terminal this is: the shell, the job in front and the jobs in the background
   * (each in a group of its own). Asked while this end is open, so the device cannot have gone to another terminal.
   * And those left behind by a shell that exited: they lost the terminal with it, and are found by its session.
   */
  processes(): Promise<number[]>;
  /** Closes this end of the pseudo-terminal. Until then output keeps coming, even after the shell exits. */
  hangup(): void;
  /** Resolves with the shell's exit code, or null when a signal ended it. */
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
  /** How long a closed terminal's shell has after SIGHUP before its group is killed. */
  killGraceMs?: number;
  /** Output is gathered for this long, or up to `batchBytes`, into one piece. */
  batchMs?: number;
  batchBytes?: number;
  /** Past this many bytes of output not yet written out to a connection, it gets no more until a `reset`. */
  behindBytes?: number;
  /** Past this many bytes the screen has not parsed yet, it is started again empty rather than kept growing. */
  screenBacklogBytes?: number;
};

/** Picks the shell's environment from the daemon's: only the names allowed (a name ending in `*` is a prefix). */
export const terminalEnv = (
  allow: readonly string[],
  source: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
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
  // macOS's own `ls` (and the other BSD tools) draw in colour only when asked to.
  env.CLICOLOR ??= "1";
  // On a Mac, a daemon started from the app (Finder, launchd) has no locale: without one, a prompt's or a file name's
  // characters past ASCII come out as `?` or escapes. What Terminal does: LANG, not macOS's own `LC_CTYPE=UTF-8`, which
  // ssh passes on to servers that do not know it. Elsewhere the daemon is started over ssh, with the login's locale.
  if (
    platform === "darwin" &&
    env.LANG === undefined &&
    env.LC_ALL === undefined &&
    env.LC_CTYPE === undefined
  )
    env.LANG = "en_US.UTF-8";
  return env;
};

/** The account's login shell, from the system's user database: what `SHELL` would have said. */
export const accountShell = (): string | undefined => {
  try {
    return userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
};

const runnable = (path: string | undefined): path is string => {
  if (!path?.startsWith("/")) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * The person's shell: `SHELL` when it can be run, else the account's login shell (a daemon started by an older app has
 * no `SHELL`: it passed only a few variables), else `/bin/sh`. The account is only looked up when `SHELL` will not do.
 */
export const terminalShell = (
  shell: string | undefined,
  account: () => string | undefined,
): string => {
  if (runnable(shell)) return shell;
  const login = account();
  return runnable(login) ? login : "/bin/sh";
};

/** `ps`, with nothing of the daemon's environment. Its output, or "" when it fails. */
const ps = async (args: string[]): Promise<string> => {
  try {
    const run = Bun.spawn(["ps", ...args], {
      env: { PATH: "/bin:/usr/bin" },
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(run.stdout).text();
    await run.exited;
    return out;
  } catch {
    return "";
  }
};

const pidsOf = (out: string): number[] =>
  out
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 1);

/** `getsid(2)`, where only it says a process's session (a Mac's `ps` does not); undefined where it cannot be had. */
let getsid: ((pid: number) => number) | null | undefined;
const sessionOf = (pid: number): number | undefined => {
  if (getsid === undefined) {
    try {
      const lib = dlopen("/usr/lib/libSystem.B.dylib", {
        getsid: { args: [FFIType.i32], returns: FFIType.i32 },
      });
      getsid = (p) => lib.symbols.getsid(p);
    } catch {
      getsid = null;
    }
  }
  if (getsid === null) return undefined;
  const sid = getsid(pid);
  return sid < 0 ? undefined : sid;
};

/**
 * The processes still in the session `sid` led, once its leader has exited: what a shell left behind loses the
 * terminal with it, so `ps -t` no longer finds them. The session's number is the shell's: the caller makes sure no
 * other process has taken that number since.
 */
const sessionMembers = async (sid: number): Promise<number[]> => {
  if (process.platform === "linux") return pidsOf(await ps(["-s", String(sid), "-o", "pid="]));
  if (process.platform !== "darwin") return [];
  // This account's processes only: no other's could be signalled.
  return pidsOf(await ps(["-x", "-o", "pid="])).filter((pid) => sessionOf(pid) === sid);
};

/** Whether a process has this number now (one of another user's included). */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
  // The device's name (`ttys003`, `pts/3`), read from the shell while it is surely alive.
  const device = ps(["-o", "tty=", "-p", String(proc.pid)]).then((out) => {
    const name = out.trim();
    return name === "" || name.startsWith("?") ? undefined : name;
  });
  return {
    pid: proc.pid,
    write: (data) => {
      if (!terminal.closed) terminal.write(data);
    },
    resize: (cols, rows) => {
      if (!terminal.closed) terminal.resize(cols, rows);
    },
    processes: async () => {
      if (terminal.closed) return [];
      const name = await device;
      const on = name === undefined ? [] : pidsOf(await ps(["-t", name, "-o", "pid="]));
      // The session the shell led has the shell's number. Until Bun has waited for the shell (running, or exited and
      // not yet reaped) the number is still the shell's; after, it is the session's only while no process has taken
      // it, which is asked before the session is looked up and again after.
      const reaped = proc.exitCode !== null || proc.signalCode !== null;
      const ours = () => !reaped || !alive(proc.pid);
      if (!ours()) return on;
      const members = await sessionMembers(proc.pid);
      if (!ours()) return on;
      return [...new Set([...on, ...members])];
    },
    hangup: () => {
      if (!terminal.closed) terminal.close();
    },
    exited: proc.exited.then((code) => (proc.signalCode !== null ? null : code)),
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

type Piece = { seq: number; data: string; bytes: number };

type Viewer = {
  sink: TerminalSink;
  /** Bytes of output sent and not yet written out: what decides it has fallen behind. */
  inflight: number;
  /** Resets sent and not yet written out. Not counted as falling behind: a screen can be larger than the limit. */
  resetting: number;
  /** `live`: gets output. `behind`: gets none until it catches up. `syncing`: a reset is being made; output waits. */
  state: "live" | "behind" | "syncing";
  waiting: Piece[];
};

/** A screen and what is written to it and not yet parsed. */
type ScreenState = { screen: Screen; backlog: number };

type Entry = {
  info: TerminalInfo;
  pty: Pty;
  screen: ScreenState;
  decoder: TextDecoder;
  /** The last piece of output made. */
  seq: number;
  batch: string;
  batchBytes: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  viewers: Map<string, Viewer>;
  /** Closed: no longer listed or reachable, though its processes may still be ending. */
  gone: boolean;
  closing: Promise<void> | undefined;
};

const notFound = (terminalId: string) =>
  new RpcError(RESOURCE_NOT_FOUND, "Terminal not found", { terminalId });

let counter = 0;
const newTerminalId = () =>
  `t_${Date.now().toString(36)}${(++counter).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

const signal = (pid: number, name: NodeJS.Signals): void => {
  try {
    process.kill(pid, name);
  } catch {}
};

export class Terminals {
  readonly #options: TerminalsOptions;
  /** The shells' environment, and `SHELL` naming the shell that runs: what rc files and programs read, unset by zsh. */
  readonly #env: Record<string, string>;
  readonly #spawn: PtySpawn;
  readonly #screen: ScreenFactory;
  readonly #log: Logger;
  readonly #terminals = new Map<string, Entry>();
  /** Set once the daemon stops: no terminal is opened after its last ones are closed. */
  #stopped = false;

  constructor(options: TerminalsOptions) {
    this.#options = options;
    this.#env = { ...options.env, SHELL: options.shell };
    this.#spawn = options.spawn ?? bunPtySpawn;
    this.#screen = options.screen ?? xtermScreen;
    this.#log = options.log ?? silentLogger;
  }

  list(sessionId: string): TerminalInfo[] {
    return [...this.#terminals.values()]
      .filter((entry) => entry.info.sessionId === sessionId && !entry.gone)
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
    if (this.#stopped)
      throw new RpcError(INVALID_PARAMS, "The daemon is stopping", {
        sessionId,
        reason: "daemon_stopping",
      });
    // Terminals still closing hold their processes and screens: they count until they are gone.
    const ofSession = [...this.#terminals.values()].filter((e) => e.info.sessionId === sessionId);
    if (ofSession.length >= this.#options.maxPerSession)
      throw new RpcError(
        CycleErrorCode.TerminalLimit,
        "This session has as many terminals as it may",
        { sessionId, limit: this.#options.maxPerSession },
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
    // Output can come as soon as the shell starts: it waits for the entry it belongs to.
    let entry: Entry | undefined;
    const early: Uint8Array[] = [];
    let pty: Pty;
    try {
      pty = this.#spawn({
        argv: [this.#options.shell, "-l"],
        cwd,
        env: this.#env,
        cols,
        rows,
        onData: (data) => (entry ? this.#onData(entry, data) : early.push(data)),
      });
    } catch (error) {
      this.#log.warn("terminal_spawn_failed", { session: sessionId });
      throw new RpcError(INVALID_PARAMS, "The shell could not be started", {
        sessionId,
        reason: "spawn_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    const info: TerminalInfo = {
      terminalId,
      sessionId,
      title: basename(this.#options.shell),
      cols,
      rows,
      status: "running",
    };
    entry = {
      info,
      pty,
      screen: this.#newScreen(info),
      decoder: new TextDecoder(),
      seq: 0,
      batch: "",
      batchBytes: 0,
      timer: undefined,
      viewers: new Map(),
      gone: false,
      closing: undefined,
    };
    const created = entry;
    for (const data of early) this.#onData(created, data);
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
    entry.screen.screen.resize(cols, rows);
    this.#changed(entry.info.sessionId);
  }

  /**
   * Hangs up every process on the terminal and forgets it: gone from the list at once, its processes ended in the
   * background of the returned promise.
   */
  close(terminalId: string): Promise<void> {
    return this.#close(this.#entry(terminalId));
  }

  /** A session was archived or deleted. */
  closeSession(sessionId: string): Promise<void> {
    const entries = [...this.#terminals.values()].filter((e) => e.info.sessionId === sessionId);
    return Promise.all(entries.map((entry) => this.#close(entry))).then(() => {});
  }

  /** The daemon is stopping: every terminal is closed, and no new one is opened. */
  closeAll(): Promise<void> {
    this.#stopped = true;
    return Promise.all([...this.#terminals.values()].map((entry) => this.#close(entry))).then(
      () => {},
    );
  }

  /** How many there are, closing ones included. */
  get size(): number {
    return this.#terminals.size;
  }

  #entry(terminalId: string): Entry {
    const entry = this.#terminals.get(terminalId);
    if (entry === undefined || entry.gone) throw notFound(terminalId);
    return entry;
  }

  #newScreen(info: TerminalInfo): ScreenState {
    const screen = this.#screen({
      cols: info.cols,
      rows: info.rows,
      scrollback: this.#options.scrollback,
    });
    const state: ScreenState = { screen, backlog: 0 };
    screen.onTitle((title) => {
      const entry = this.#terminals.get(info.terminalId);
      const next = title.slice(0, 200);
      if (entry?.screen !== state || entry.gone || info.title === next) return;
      info.title = next;
      this.#changed(info.sessionId);
    });
    return state;
  }

  async #attach(entry: Entry, sink: TerminalSink): Promise<TerminalAttached> {
    // Output made from here on goes to the sink; what came before is in the snapshot taken of it now. Both may
    // carry the same piece; the client drops output whose seq the answer already covers.
    this.#flush(entry);
    const seq = entry.seq;
    entry.viewers.set(sink.id, { sink, inflight: 0, resetting: 0, state: "live", waiting: [] });
    const screen = await entry.screen.screen.snapshot();
    return { terminal: { ...entry.info }, screen, seq };
  }

  #onData(entry: Entry, data: Uint8Array): void {
    const text = entry.decoder.decode(data, { stream: true });
    if (text.length === 0) return;
    entry.batch += text;
    entry.batchBytes += data.byteLength;
    if (entry.batchBytes >= (this.#options.batchBytes ?? 64 * 1024)) this.#flush(entry);
    else entry.timer ??= setTimeout(() => this.#flush(entry), this.#options.batchMs ?? 16);
  }

  /** Makes what was gathered one piece of output: to the screen, and to each connection watching. */
  #flush(entry: Entry): void {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    if (entry.batch.length === 0) return;
    const piece: Piece = { seq: ++entry.seq, data: entry.batch, bytes: entry.batchBytes };
    entry.batch = "";
    entry.batchBytes = 0;
    let state = entry.screen;
    if (state.backlog + piece.bytes > (this.#options.screenBacklogBytes ?? 8 * 1024 * 1024)) {
      // A shell printing faster than the screen parses. Dropping a piece would leave the screen in a state the
      // shell never had (a mode switched, a region never reset); starting it again empty keeps it one it could
      // have. The old one finishes what it holds first, so a snapshot already asked of it still comes.
      this.#log.warn("terminal_screen_restarted", { terminal: entry.info.terminalId });
      const old = state.screen;
      void old.snapshot().then(() => old.dispose());
      state = this.#newScreen(entry.info);
      entry.screen = state;
    }
    const written = state;
    written.backlog += piece.bytes;
    written.screen.write(piece.data, () => {
      written.backlog -= piece.bytes;
    });
    for (const viewer of entry.viewers.values()) this.#deliver(entry, viewer, piece);
  }

  #deliver(entry: Entry, viewer: Viewer, piece: Piece): void {
    if (viewer.state === "syncing") {
      viewer.waiting.push(piece);
      return;
    }
    if (viewer.state === "behind") return;
    if (viewer.inflight > (this.#options.behindBytes ?? 1024 * 1024)) {
      // It is not taking what it is sent: no more until it has, then the screen as it is by then.
      viewer.state = "behind";
      return;
    }
    viewer.inflight += piece.bytes;
    this.#send(viewer, TERMINAL_NOTIFICATIONS.output, {
      terminalId: entry.info.terminalId,
      seq: piece.seq,
      data: piece.data,
    }).finally(() => {
      viewer.inflight -= piece.bytes;
      this.#drained(entry, viewer);
    });
  }

  #send(viewer: Viewer, method: string, params: object): Promise<void> {
    return viewer.sink.send(method, params).catch(() => {});
  }

  #drained(entry: Entry, viewer: Viewer): void {
    if (viewer.state === "behind" && viewer.inflight === 0 && viewer.resetting === 0)
      void this.#reset(entry, viewer);
  }

  /** Brings a connection that fell behind up to date: the screen now, then what comes after it. */
  async #reset(entry: Entry, viewer: Viewer): Promise<void> {
    if (entry.viewers.get(viewer.sink.id) !== viewer || entry.gone) return;
    this.#flush(entry);
    const seq = entry.seq;
    viewer.state = "syncing";
    viewer.waiting = [];
    const screen = await entry.screen.screen.snapshot();
    if (entry.viewers.get(viewer.sink.id) !== viewer) return;
    viewer.resetting++;
    void this.#send(viewer, TERMINAL_NOTIFICATIONS.reset, {
      terminalId: entry.info.terminalId,
      seq,
      screen,
      cols: entry.info.cols,
      rows: entry.info.rows,
    }).finally(() => {
      viewer.resetting--;
      this.#drained(entry, viewer);
    });
    viewer.state = "live";
    const waiting = viewer.waiting;
    viewer.waiting = [];
    for (const piece of waiting) this.#deliver(entry, viewer, piece);
  }

  #onExit(entry: Entry, code: number | null): void {
    // The terminal stays open: what the shell printed last may still be on its way.
    this.#flush(entry);
    entry.info.status = "exited";
    entry.info.exitCode = code;
    this.#log.info("terminal_exited", { terminal: entry.info.terminalId });
    if (!entry.gone) this.#changed(entry.info.sessionId);
  }

  #close(entry: Entry): Promise<void> {
    if (entry.closing !== undefined) return entry.closing;
    // Gone from the list at once; what follows only ends its processes.
    entry.gone = true;
    entry.viewers.clear();
    this.#changed(entry.info.sessionId);
    entry.closing = (async () => {
      const { terminalId, sessionId } = entry.info;
      // What closing a terminal window does: every process on it is hung up (one that ignores it, as under nohup,
      // is left). A shell still there after the grace is killed with its group. The terminal is closed last: while
      // it is open its device is not another terminal's, so the processes found on it are this one's.
      // A shell that has exited and been waited for is not signalled: its number may be another process's by now.
      const shell = entry.pty.pid;
      const processes = new Set(await entry.pty.processes());
      if (entry.info.status !== "exited") processes.add(shell);
      for (const pid of processes) signal(pid, "SIGHUP");
      const grace = this.#options.killGraceMs ?? 2000;
      const ended = await Promise.race([
        entry.pty.exited.then(() => true),
        Bun.sleep(grace).then(() => false),
      ]);
      if (!ended) {
        signal(-shell, "SIGKILL");
        await Promise.race([entry.pty.exited, Bun.sleep(grace)]);
      }
      entry.pty.hangup();
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entry.screen.screen.dispose();
      this.#terminals.delete(terminalId);
      this.#log.info("terminal_closed", { session: sessionId, terminal: terminalId });
    })();
    return entry.closing;
  }

  #changed(sessionId: string): void {
    this.#options.onChanged(sessionId, this.list(sessionId));
  }
}
