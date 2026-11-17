// The owner's remote servers, in `remotes.json` in the local CYCLE_HOME: names and ssh targets only.
// The list is the desktop's and not a daemon's, so a remote daemon's page shows the same one.
import type { RemoteInput, RemoteResult, RemoteServer } from "../shared/remote-state";
import { checkInput, parseRemotes, serializeRemotes } from "./plan";

export type TextFile = {
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
  /** Moves the file aside, to `<name>.bad`, so a write does not replace what could not be read. Nothing to move is fine. */
  keepAside(): Promise<void>;
};

/** Whether the text is no list at all, which is not the same as an empty one. */
function unreadable(text: string): boolean {
  if (text.trim() === "") return false;
  try {
    return !Array.isArray((JSON.parse(text) as { remotes?: unknown } | null)?.remotes);
  } catch {
    return true;
  }
}

export class RemoteStore {
  #remotes: RemoteServer[] | undefined;
  /** The file held something that was no list: it is moved aside before the first write over it. */
  #aside = false;
  /** One change at a time, so two quick ones do not both start from the same list. */
  #queue: Promise<unknown> = Promise.resolve();

  readonly #file: TextFile;
  readonly #newId: () => string;

  constructor(file: TextFile, newId: () => string) {
    this.#file = file;
    this.#newId = newId;
  }

  async #load(): Promise<RemoteServer[]> {
    if (!this.#remotes) {
      const text = (await this.#file.read()) ?? "";
      this.#aside = unreadable(text);
      this.#remotes = parseRemotes(text);
    }
    return this.#remotes;
  }

  #change<T>(run: (remotes: RemoteServer[]) => T | Promise<T>): Promise<T> {
    const next = this.#queue.then(async () => run(await this.#load()));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** The list in memory changes only once the file has it, so a write that fails leaves both as they were. */
  async #save(next: RemoteServer[]): Promise<void> {
    if (this.#aside) await this.#file.keepAside();
    await this.#file.write(serializeRemotes(next));
    this.#aside = false;
    this.#remotes = next;
  }

  async list(): Promise<readonly RemoteServer[]> {
    return this.#change((remotes) => [...remotes]);
  }

  add(input: unknown): Promise<RemoteResult<RemoteServer>> {
    return this.#change(async (remotes) => {
      const checked = checkInput(input);
      if (!checked.ok) return checked;
      const remote: RemoteServer = { id: this.#newId(), ...checked.value };
      await this.#save([...remotes, remote]);
      return { ok: true, value: remote };
    });
  }

  update(id: string, input: unknown): Promise<RemoteResult<RemoteServer>> {
    return this.#change(async (remotes) => {
      const at = remotes.findIndex((r) => r.id === id);
      if (at === -1) return { ok: false, error: "No such server." };
      const checked = checkInput(input);
      if (!checked.ok) return checked;
      const remote: RemoteServer = { id, ...(checked.value as RemoteInput) };
      await this.#save(remotes.map((r, i) => (i === at ? remote : r)));
      return { ok: true, value: remote };
    });
  }

  remove(id: string): Promise<void> {
    return this.#change(async (remotes) => {
      const at = remotes.findIndex((r) => r.id === id);
      if (at === -1) return;
      await this.#save(remotes.filter((_, i) => i !== at));
    });
  }

  async get(id: string): Promise<RemoteServer | undefined> {
    return (await this.list()).find((r) => r.id === id);
  }
}
