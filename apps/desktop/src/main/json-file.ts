// How the app keeps a file of its own data (settings.json, environments.json): one JSON object, written whole to a
// temporary file and renamed into place, one save after another, with what this version does not understand written back
// as it was. A file that is not JSON is kept beside, and the app starts without it.
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type JsonFile = {
  /**
   * The file's object. Undefined when there is no file, or when it is not JSON: then it is copied beside as
   * `<path>.broken-<time>` and left in place. An object of nothing when it is JSON and not an object. Throws, naming the
   * file, when it cannot be read at all (or a broken one cannot be kept).
   */
  read(): Promise<Record<string, unknown> | undefined>;
  /** Writes it whole and renames it into place, after any write still going on. */
  write(record: Record<string, unknown>): Promise<void>;
};

/** `mode`: what the file is made with, and set to on every write (a file left wider is narrowed). */
export const jsonFile = (path: string, options: { mode?: number } = {}): JsonFile => {
  let saving: Promise<void> = Promise.resolve();
  const write = async (record: Record<string, unknown>): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    const text = `${JSON.stringify(record, null, 2)}\n`;
    if (options.mode === undefined) await writeFile(temporary, text);
    else {
      await writeFile(temporary, text, { mode: options.mode });
      // The mode a file is made with is narrowed by the umask, never widened: said again, in case it was left wider.
      await chmod(temporary, options.mode);
    }
    await rename(temporary, path);
  };
  return {
    async read() {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
        return isRecord(parsed) ? parsed : {};
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        if (error instanceof SyntaxError) {
          try {
            await copyFile(path, `${path}.broken-${Date.now()}`);
            return undefined;
          } catch {
            // Falls through to the error below.
          }
        }
        throw new Error(
          `${path} cannot be read: ${error instanceof Error ? error.message : error}`,
        );
      }
    },
    write(record) {
      // Two at once would write the same temporary file.
      const done = saving.then(
        () => write(record),
        () => write(record),
      );
      saving = done;
      return done;
    },
  };
};

/** An entry's id, when it is an object with a string id. */
export const entryIdOf = (entry: unknown): string | undefined =>
  isRecord(entry) && typeof entry.id === "string" ? entry.id : undefined;

/** What to write for some values, and what to remember once it is written. */
export type KeptWrite = {
  entries: unknown[];
  /** Call once the file has these entries: until then the next write compares with what the file still holds. */
  commit(): void;
};

/**
 * A list of entries this version reads some of. What it reads comes back as values; on writing, a value that has not
 * changed is written as the entry was (with the fields this version does not know), and an entry it could not read is
 * written back unless a value now has its id: then that value took its place, for good. Of two entries with one id, the
 * second is one it could not read.
 */
export class KeptEntries<T> {
  readonly #parse: (entry: unknown) => T | undefined;
  readonly #idOf: (value: T) => string;
  readonly #same: (entry: Record<string, unknown>, value: T) => boolean;
  #raw = new Map<string, Record<string, unknown>>();
  #unknown: unknown[] = [];

  constructor(options: {
    parse: (entry: unknown) => T | undefined;
    idOf: (value: T) => string;
    /** Whether a value is the entry it was read from. Default: it reads as the same value. */
    same?: (entry: Record<string, unknown>, value: T) => boolean;
  }) {
    this.#parse = options.parse;
    this.#idOf = options.idOf;
    this.#same = options.same ?? ((entry, value) => isDeepStrictEqual(this.#parse(entry), value));
  }

  read(entries: readonly unknown[]): T[] {
    this.#raw = new Map();
    this.#unknown = [];
    const values: T[] = [];
    for (const entry of entries) {
      const value = this.#parse(entry);
      if (value === undefined || !isRecord(entry) || this.#raw.has(this.#idOf(value)))
        this.#unknown.push(entry);
      else {
        values.push(value);
        this.#raw.set(this.#idOf(value), entry);
      }
    }
    return values;
  }

  /** The entries to write for these values. Nothing is remembered of them until `commit`. */
  write(values: readonly T[]): KeptWrite {
    const ids = new Set(values.map(this.#idOf));
    const known = values.map((value) => {
      const before = this.#raw.get(this.#idOf(value));
      return before !== undefined && this.#same(before, value) ? before : value;
    });
    const unknown = this.#unknown.filter((u) => {
      const id = entryIdOf(u);
      return id === undefined || !ids.has(id);
    });
    return {
      entries: [...known, ...unknown],
      commit: () => {
        this.#raw = new Map(
          values.map((value, at) => [this.#idOf(value), known[at] as Record<string, unknown>]),
        );
        this.#unknown = unknown;
      },
    };
  }
}
