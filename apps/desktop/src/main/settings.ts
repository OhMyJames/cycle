import { isDeepStrictEqual } from "node:util";
import type { LocationConfig } from "@cycle/ui";
import { entryIdOf, isRecord, jsonFile, KeptEntries } from "./json-file.ts";

export const LOCAL_LOCATION: LocationConfig = {
  id: "local",
  name: "Local",
  kind: "local",
};

/** Where the app keeps what the user set up. */
export type Settings = {
  load(): Promise<LocationConfig[]>;
  save(locations: LocationConfig[]): Promise<void>;
};

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
  if (entry.kind === "local") return id === LOCAL_LOCATION.id ? { ...LOCAL_LOCATION } : undefined;
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
 * Settings in a JSON file in the app's data directory, written whole and renamed into place (json-file.ts), mode 0600 as
 * environments.json is: it says which machines the person reaches over ssh. What this version does not understand is not
 * shown and not lost: an entry it cannot read (a newer app wrote it, or it is damaged), the fields it does not know of in
 * an entry it can, and any other key of the file are written back as they were.
 */
export const fileSettings = (path: string): Settings => {
  const file = jsonFile(path, { mode: 0o600 });
  // Only an entry already in the new format is written as it was: the older one has other field names.
  const entries = new KeptEntries({
    parse: locationOf,
    idOf: (location: LocationConfig) => location.id,
    same: (entry, location) =>
      entry.kind === location.kind && isDeepStrictEqual(locationOf(entry), location),
  });
  let rest: Record<string, unknown> = {};
  return {
    async load() {
      const record = (await file.read()) ?? {};
      // `locations` is the format. Older files have `environments` (the same entries, its name until 2026-11-24) or,
      // before that, `hosts`. All three are read: an older app opened on a newer file adds to `environments`, and what it
      // added is kept, after the entries of `locations`, unless one of them has its id. An entry with no id (damaged, or
      // of a format this app does not know) is kept from any of them, once. None but `locations` is written.
      const lists = [record.locations, record.environments, record.hosts].map((list) =>
        Array.isArray(list) ? list : [],
      );
      const seen = new Set<string>();
      const merged: unknown[] = [];
      for (const list of lists)
        for (const entry of list) {
          const id = entryIdOf(entry);
          if (id !== undefined) {
            if (seen.has(id)) continue;
            seen.add(id);
          } else if (merged.some((m) => entryIdOf(m) === undefined && isDeepStrictEqual(m, entry)))
            // The same one in two of the lists: an older app wrote back what it read.
            continue;
          merged.push(entry);
        }
      const {
        locations: _locations,
        environments: _environments,
        hosts: _hosts,
        ...others
      } = record;
      rest = others;
      // The local daemon is always there, and always first: an entry for it in the file is not another.
      return [
        LOCAL_LOCATION,
        ...entries.read(merged).filter((location) => location.id !== LOCAL_LOCATION.id),
      ];
    },
    async save(locations) {
      const written = entries.write(locations.filter((e) => e.id !== LOCAL_LOCATION.id));
      await file.write({ ...rest, locations: written.entries });
      written.commit();
    },
  };
};
