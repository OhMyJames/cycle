import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { z } from "zod";

/**
 * What is in a small JSON file the daemon keeps, read by `schema`: undefined when there is none. One that is there and
 * cannot be read throws what `unreadable` makes of it; without `unreadable`, it counts as none (a cache).
 */
export const readJsonFile = async <S extends z.ZodType>(
  path: string,
  schema: S,
  unreadable?: (detail: string) => Error,
): Promise<z.infer<S> | undefined> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  try {
    return schema.parse(JSON.parse(await file.text()));
  } catch (error) {
    if (unreadable === undefined) return undefined;
    throw unreadable(error instanceof Error ? error.message : String(error));
  }
};

/** What a change makes of the value, and what its caller is answered. Without `value`, the value is left as it is. */
export type Change<T, R> = { value?: T; answer: R };

/**
 * A value kept in a JSON file, written whole: each change to a temporary file that is then renamed over the old one,
 * so a crash leaves the old file or the new one and never half of one. Changes are made one at a time, each on the
 * value as the ones before it left it. A change that cannot be written is undone: the value is what is on disk.
 *
 * The file is 0600, and a folder made for it 0700: the session index holds what an MCP server signs in with.
 * `ownFolder`: the folder is this file's alone (the connectors'), and is made 0700 though it was there. One JsonFile
 * for a path in a process: its temporary file is named by the process.
 */
export class JsonFile<T> {
  readonly #path: string;
  readonly #body: (value: T) => unknown;
  readonly #ownFolder: boolean;
  #value: T;
  #queue: Promise<unknown> = Promise.resolve();

  /** `body`: what is written for a value (its version and shape on disk). */
  constructor(
    path: string,
    value: T,
    body: (value: T) => unknown,
    options: { ownFolder?: boolean } = {},
  ) {
    this.#path = path;
    this.#value = value;
    this.#body = body;
    this.#ownFolder = options.ownFolder ?? false;
  }

  /** The value as changed so far, a change being written included. Replaced by each change, never changed in place. */
  get value(): T {
    return this.#value;
  }

  /**
   * Changes the value when the changes before it are done. `apply` is given the value then, and returns the next one
   * (a new object: the old is what an undo goes back to) and what the caller is answered. Seen at once in `value`;
   * undone if it cannot be written, and the error thrown. A change that leaves the value writes nothing.
   */
  change<R = undefined>(apply: (value: T) => Change<T, R>): Promise<R> {
    const run = this.#queue.then(async () => {
      const before = this.#value;
      const next = apply(before);
      if (!("value" in next) || next.value === undefined) return next.answer;
      this.#value = next.value;
      try {
        await this.#write();
      } catch (error) {
        this.#value = before;
        throw error;
      }
      return next.answer;
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Resolves when every change made so far is on disk, or has failed. */
  async flush(): Promise<void> {
    await this.#queue;
  }

  async #write(): Promise<void> {
    const folder = dirname(this.#path);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (this.#ownFolder) await chmod(folder, 0o700);
    const temporary = `${this.#path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#body(this.#value), null, 2)}\n`, {
      mode: 0o600,
    });
    // The mode above is only for a file that is made new: one left by a crash keeps the one it had.
    await chmod(temporary, 0o600);
    await rename(temporary, this.#path);
  }
}
