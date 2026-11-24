import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { LocationConfig } from "@cycle/ui";

export const LOCAL_LOCATION: LocationConfig = {
  id: "local",
  name: "This computer",
  kind: "local",
};

/** Where the app keeps what the user set up. */
export type Settings = {
  load(): Promise<LocationConfig[]>;
  save(locations: LocationConfig[]): Promise<void>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What ssh may be given as the place to go: an address or an alias, never something it would read as an option. */
export const isSshHost = (host: string): boolean =>
  host.trim() !== "" && !host.trim().startsWith("-") && !/[\s\p{Cc}]/u.test(host);

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined;

/**
 * One entry of the file as a location, or undefined when it is not one this app understands. The entries of
 * `locations` and of `environments` (its name until 2026-11-24) have the same format. The one before that was a list of
 * `hosts`, each `{ id, name, kind: "ssh", host, command? }`: it is read as a remote one reached over SSH, with the same
 * id (the id is what the sessions and drafts are known by).
 */
export const locationOf = (entry: unknown): LocationConfig | undefined => {
  if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string")
    return undefined;
  const { id, name } = entry;
  // This computer is the one "local" there is: another entry that says it is local would be a second way into the same daemon.
  if (entry.kind === "local")
    return id === LOCAL_LOCATION.id ? { id, name, kind: "local" } : undefined;
  if (entry.kind === "remote" && isRecord(entry.transport) && entry.transport.type === "ssh") {
    const { host } = entry.transport;
    const command = strings(entry.transport.command);
    // A command that is not a list of words is not one to run by guessing: the entry is left as it is.
    if (
      typeof host !== "string" ||
      !isSshHost(host) ||
      (entry.transport.command !== undefined && command === undefined)
    )
      return undefined;
    return {
      id,
      name,
      kind: "remote",
      transport: { type: "ssh", host, ...(command !== undefined ? { command } : {}) },
    };
  }
  if (entry.kind === "ssh" && typeof entry.host === "string" && isSshHost(entry.host)) {
    const command = strings(entry.command);
    if (entry.command !== undefined && command === undefined) return undefined;
    return {
      id,
      name,
      kind: "remote",
      transport: { type: "ssh", host: entry.host, ...(command !== undefined ? { command } : {}) },
    };
  }
  return undefined;
};

/**
 * Settings in a JSON file in the app's data directory, written whole and renamed into place. What this version does not
 * understand is not shown and not lost: an entry it cannot read (a newer app wrote it, or it is damaged), the fields it
 * does not know of in an entry it can, and any other key of the file are written back as they were.
 */
export const fileSettings = (path: string): Settings => {
  let unknown: unknown[] = [];
  let rest: Record<string, unknown> = {};
  // What each location was in the file, to write back what it has no field for.
  const raw = new Map<string, Record<string, unknown>>();
  // Saves one after the other: two at once would write the same temporary file.
  let saving: Promise<void> = Promise.resolve();
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
        const record = isRecord(parsed) ? parsed : {};
        // `locations` is the format. Older files have `environments` (the same entries, its name until 2026-11-24) or,
        // before that, `hosts`: the first of the three that is there is read, and none of them is written back.
        const entries = Array.isArray(record.locations)
          ? record.locations
          : Array.isArray(record.environments)
            ? record.environments
            : Array.isArray(record.hosts)
              ? record.hosts
              : [];
        const {
          locations: _locations,
          environments: _environments,
          hosts: _hosts,
          ...others
        } = record;
        rest = others;
        const known: LocationConfig[] = [];
        unknown = [];
        raw.clear();
        for (const entry of entries) {
          const location = locationOf(entry);
          if (location === undefined) unknown.push(entry);
          else if (location.id !== LOCAL_LOCATION.id) {
            known.push(location);
            if (isRecord(entry)) raw.set(location.id, entry);
          }
        }
        // The local daemon is always there, and always first.
        return [LOCAL_LOCATION, ...known];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [LOCAL_LOCATION];
        // A file that is not JSON (a crash while it was written by hand, an editor's leftovers) must not keep the app from
        // opening: it is kept beside, as it was, and the app starts with this computer only.
        // If it cannot be kept, it is not the app's to start without it: the person is told which file.
        if (error instanceof SyntaxError) {
          try {
            await copyFile(path, `${path}.broken-${Date.now()}`);
            return [LOCAL_LOCATION];
          } catch {
            // Falls through to the error below.
          }
        }
        throw new Error(
          `${path} cannot be read: ${error instanceof Error ? error.message : error}`,
        );
      }
    },
    save(locations) {
      const done = saving.then(
        () => write(locations),
        () => write(locations),
      );
      saving = done;
      return done;
    },
  };
  async function write(locations: LocationConfig[]): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    const saved = locations.filter((e) => e.id !== LOCAL_LOCATION.id);
    const ids = new Set(saved.map((e) => e.id));
    const written = [
      // As it was in the file, with its fields we do not know, when it has not changed; else as it is now.
      ...saved.map((e) => {
        const before = raw.get(e.id);
        // Only an entry already in the new format: the older one has other field names, which are not written again.
        return before?.kind === e.kind && isDeepStrictEqual(locationOf(before), e) ? before : e;
      }),
      // An entry with the id of one that is saved now would be two of one: the one the person saved wins.
      ...unknown.filter((u) => !(isRecord(u) && typeof u.id === "string" && ids.has(u.id))),
    ];
    await writeFile(temporary, `${JSON.stringify({ ...rest, locations: written }, null, 2)}\n`);
    await rename(temporary, path);
  }
};
