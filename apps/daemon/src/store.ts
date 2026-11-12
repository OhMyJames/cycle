import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Where a store keeps its text. Tests give one that touches no disk. */
export interface TextFile {
  read(): Promise<string | null>;
  write(text: string): Promise<void>;
}

export function diskFile(path: string): TextFile {
  return {
    async read() {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    // A reader sees the old file or the new one, never half of either.
    async write(text) {
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, text, { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, path);
    },
  };
}

export type Schedule = (callback: () => void, ms: number) => () => void;

export const realSchedule: Schedule = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => clearTimeout(timer);
};

const WRITE_DELAY_MS = 150;

/**
 * One JSON value kept in memory and written behind. Changes within a short
 * window share one write, and writes never overlap, so a burst of events
 * costs one file write instead of one each.
 */
export class JsonStore<T> {
  value: T;
  private readonly file: TextFile;
  private readonly schedule: Schedule;
  private dirty = false;
  private cancel: (() => void) | null = null;
  private writing: Promise<void> = Promise.resolve();

  private constructor(file: TextFile, value: T, schedule: Schedule) {
    this.file = file;
    this.value = value;
    this.schedule = schedule;
  }

  /** Reads the file. A file that cannot be parsed is an error, never an empty start. */
  static async open<T>(
    file: TextFile,
    initial: T,
    schedule: Schedule = realSchedule,
  ): Promise<JsonStore<T>> {
    const text = await file.read();
    const value = text === null ? initial : { ...initial, ...(JSON.parse(text) as T) };
    return new JsonStore(file, value, schedule);
  }

  /** Changes the value in place and schedules the write. */
  update(change: (value: T) => void): void {
    change(this.value);
    this.dirty = true;
    this.cancel ??= this.schedule(() => {
      this.cancel = null;
      void this.flush();
    }, WRITE_DELAY_MS);
  }

  /** Writes now if anything changed, and waits for any write under way. */
  flush(): Promise<void> {
    this.cancel?.();
    this.cancel = null;
    if (this.dirty) {
      this.dirty = false;
      const text = `${JSON.stringify(this.value, null, 2)}\n`;
      this.writing = this.writing.then(() => this.file.write(text)).catch(() => {});
    }
    return this.writing;
  }
}
