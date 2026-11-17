// The owner's remote servers, in `remotes.json` in the local CYCLE_HOME: names and ssh targets only.
// The list is the desktop's and not a daemon's, so a remote daemon's page shows the same one.
import type { RemoteInput, RemoteResult, RemoteServer } from "../shared/remote-state";
import { checkInput, parseRemotes, serializeRemotes } from "./plan";

export type TextFile = {
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
};

export class RemoteStore {
  #remotes: RemoteServer[] | undefined;
  /** One change at a time, so two quick ones do not both start from the same list. */
  #queue: Promise<unknown> = Promise.resolve();

  readonly #file: TextFile;
  readonly #newId: () => string;

  constructor(file: TextFile, newId: () => string) {
    this.#file = file;
    this.#newId = newId;
  }

  async #load(): Promise<RemoteServer[]> {
    // shortcut: a file that cannot be read is an empty list and the next change replaces it; upgrade when owners keep more than names here.
    this.#remotes ??= parseRemotes((await this.#file.read()) ?? "");
    return this.#remotes;
  }

  #change<T>(run: (remotes: RemoteServer[]) => T | Promise<T>): Promise<T> {
    const next = this.#queue.then(async () => run(await this.#load()));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async list(): Promise<readonly RemoteServer[]> {
    return this.#change((remotes) => [...remotes]);
  }

  add(input: unknown): Promise<RemoteResult<RemoteServer>> {
    return this.#change(async (remotes) => {
      const checked = checkInput(input);
      if (!checked.ok) return checked;
      const remote: RemoteServer = { id: this.#newId(), ...checked.value };
      remotes.push(remote);
      await this.#file.write(serializeRemotes(remotes));
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
      remotes[at] = remote;
      await this.#file.write(serializeRemotes(remotes));
      return { ok: true, value: remote };
    });
  }

  remove(id: string): Promise<void> {
    return this.#change(async (remotes) => {
      const at = remotes.findIndex((r) => r.id === id);
      if (at === -1) return;
      remotes.splice(at, 1);
      await this.#file.write(serializeRemotes(remotes));
    });
  }

  async get(id: string): Promise<RemoteServer | undefined> {
    return (await this.list()).find((r) => r.id === id);
  }
}
