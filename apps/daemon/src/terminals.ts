import type { Harness, TerminalHandle, TerminalInfo } from "@cycle/protocol";
import type { Delay } from "./store.ts";

interface Terminal {
  info: TerminalInfo;
  handle: TerminalHandle | null;
  /** What it printed, oldest first, kept up to a limit for whoever attaches next. */
  chunks: Uint8Array[];
  size: number;
  pending: Uint8Array[];
  cancelFlush: (() => void) | null;
}

export interface TerminalsOptions {
  harness: Harness;
  schedule: Delay;
  shell: string;
  env: Record<string, string>;
  publish: {
    output(id: string, data: Uint8Array): void;
    changed(sessionId: string | null, terminals: TerminalInfo[]): void;
  };
}

const KEEP_BYTES = 512 * 1024;
const MAX_PER_SESSION = 8;
/** Output is sent on in batches this far apart, so a flood is a few frames. */
const OUTPUT_FLUSH_MS = 8;

function concat(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * The owner's shells, one pseudo-terminal each, run by the harness on the
 * agent's machine. They outlive the page that opened them and go with their
 * session or with the daemon.
 */
export class Terminals {
  private readonly options: TerminalsOptions;
  private readonly terminals = new Map<string, Terminal>();
  private nextId = 1;

  constructor(options: TerminalsOptions) {
    this.options = options;
  }

  list(sessionId: string | null): TerminalInfo[] {
    return [...this.terminals.values()]
      .filter((terminal) => terminal.info.sessionId === sessionId)
      .map((terminal) => terminal.info);
  }

  async create(
    sessionId: string | null,
    cwd: string,
    cols: number,
    rows: number,
  ): Promise<TerminalInfo> {
    const open = this.list(sessionId);
    if (open.length >= MAX_PER_SESSION) {
      throw new Error(`A session has at most ${MAX_PER_SESSION} terminals. Close one first.`);
    }
    const id = `term-${this.nextId++}-${Math.random().toString(36).slice(2, 8)}`;
    const terminal: Terminal = {
      info: {
        id,
        sessionId,
        cwd,
        title: `Terminal ${open.length + 1}`,
        exitCode: null,
        exited: false,
      },
      handle: null,
      chunks: [],
      size: 0,
      pending: [],
      cancelFlush: null,
    };
    this.terminals.set(id, terminal);
    try {
      terminal.handle = await this.options.harness.openTerminal({
        id,
        argv: [this.options.shell, "-l"],
        cwd,
        cols,
        rows,
        env: this.options.env,
        onData: (bytes) => this.output(terminal, bytes),
        onExit: (exitCode) => this.exited(terminal, exitCode),
      });
    } catch (error) {
      this.terminals.delete(id);
      throw error;
    }
    this.changed(sessionId);
    return terminal.info;
  }

  /** Everything the terminal printed that is still kept, for a client joining it. */
  snapshot(id: string): { terminal: TerminalInfo; data: Uint8Array } {
    const terminal = this.get(id);
    this.flush(terminal);
    return { terminal: terminal.info, data: concat(terminal.chunks) };
  }

  write(id: string, data: Uint8Array): void {
    this.get(id).handle?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.get(id).handle?.resize(cols, rows);
  }

  close(id: string): void {
    const terminal = this.terminals.get(id);
    if (!terminal) return;
    terminal.handle?.kill();
    terminal.cancelFlush?.();
    this.terminals.delete(id);
    this.changed(terminal.info.sessionId);
  }

  closeSession(sessionId: string): void {
    for (const terminal of this.list(sessionId)) this.close(terminal.id);
  }

  closeAll(): void {
    for (const id of this.terminals.keys()) this.close(id);
  }

  private get(id: string): Terminal {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error(`unknown terminal: ${id}`);
    return terminal;
  }

  private output(terminal: Terminal, bytes: Uint8Array): void {
    terminal.pending.push(bytes);
    terminal.cancelFlush ??= this.options.schedule(() => this.flush(terminal), OUTPUT_FLUSH_MS);
  }

  private flush(terminal: Terminal): void {
    terminal.cancelFlush?.();
    terminal.cancelFlush = null;
    if (!terminal.pending.length) return;
    const data = concat(terminal.pending);
    terminal.pending = [];
    terminal.chunks.push(data);
    terminal.size += data.length;
    while (terminal.size > KEEP_BYTES && terminal.chunks.length > 1) {
      terminal.size -= terminal.chunks.shift()?.length ?? 0;
    }
    this.options.publish.output(terminal.info.id, data);
  }

  private exited(terminal: Terminal, exitCode: number | null): void {
    this.flush(terminal);
    terminal.handle = null;
    terminal.info = { ...terminal.info, exitCode, exited: true };
    if (this.terminals.has(terminal.info.id)) this.changed(terminal.info.sessionId);
  }

  private changed(sessionId: string | null): void {
    this.options.publish.changed(sessionId, this.list(sessionId));
  }
}
