/** The most daemon.log holds: past it, the older half is kept as `daemon.log.1` and the file starts again. */
export const LOG_LIMIT = 1_000_000;

/** What the log needs of the disk, so it is tried without one. */
export interface LogFile {
  /** How many bytes it holds; none when it is not there yet. */
  size(): number;
  append(text: string): void;
  /** Keeps what it holds as the previous log, over the one before, and starts it empty. */
  rotate(): void;
}

/**
 * The daemon's log, kept from one start to the next. Each line it prints is stamped with the time it
 * was written, and the file never holds more than `limit` bytes beyond one line: the daemon runs for
 * days and its lines add up.
 */
export class DaemonLog {
  private readonly file: LogFile;
  private readonly now: () => Date;
  private readonly limit: number;
  private bytes: number;
  /** The start of a line whose end has not come. */
  private rest = "";

  constructor(file: LogFile, now: () => Date, limit = LOG_LIMIT) {
    this.file = file;
    this.now = now;
    this.limit = limit;
    this.bytes = file.size();
  }

  /** Marks where a daemon began, so the lines of each start can be told apart. */
  start(): void {
    this.line("daemon starting");
  }

  /** What the daemon printed: whole lines are written, and the rest waits for its end. */
  write(chunk: string): void {
    const lines = (this.rest + chunk).split("\n");
    this.rest = lines.pop() ?? "";
    for (const line of lines) this.line(line);
  }

  /** The daemon ended: a last line with no newline is still a line. */
  end(): void {
    if (this.rest) this.line(this.rest);
    this.rest = "";
  }

  private line(text: string): void {
    const written = `${this.now().toISOString()} ${text}\n`;
    if (this.bytes > 0 && this.bytes + written.length > this.limit) {
      this.file.rotate();
      this.bytes = 0;
    }
    this.file.append(written);
    this.bytes += written.length;
  }
}
