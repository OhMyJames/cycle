// The environments the person defined (docs/desktop.md "环境"): reusable setups of scripts, variables and actions, and
// the one each workspace starts with. Kept in `environments.json` of the app's data, apart from `settings.json` (whose
// old `environments` key was the list of locations), with mode 0600: variables can be secrets. Nothing here knows
// Electron; nothing here logs or reports a name, a value or a command.
import { chmod, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { EventName, EventProps } from "@cycle/analytics/events";
import {
  type Environment,
  type EnvironmentProblem,
  type EnvironmentScripts,
  type EnvironmentsState,
  environmentProblem,
  environmentSnapshot,
  SCRIPT_SYSTEMS,
} from "@cycle/ui";

/** What the file holds, as this app reads it, and what it does not understand, to be written back as it was. */
export type EnvironmentsFile = EnvironmentsState;

export type EnvironmentStore = {
  load(): Promise<EnvironmentsFile>;
  save(state: EnvironmentsFile): Promise<void>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const scriptsOf = (value: unknown): EnvironmentScripts | undefined | false => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return false;
  const scripts: EnvironmentScripts = {};
  for (const system of SCRIPT_SYSTEMS) {
    const text = value[system];
    if (text === undefined) continue;
    if (typeof text !== "string") return false;
    scripts[system] = text;
  }
  return scripts;
};

/** One entry of the file as an environment, or undefined when it is not one this app understands. */
export const environmentOf = (entry: unknown): Environment | undefined => {
  if (!isRecord(entry) || typeof entry.id !== "string" || entry.id === "") return undefined;
  if (typeof entry.name !== "string") return undefined;
  if (!Array.isArray(entry.variables) || !Array.isArray(entry.actions)) return undefined;
  const variables: Environment["variables"] = [];
  for (const v of entry.variables) {
    if (!isRecord(v) || typeof v.name !== "string" || typeof v.value !== "string") return undefined;
    variables.push({ name: v.name, value: v.value });
  }
  const actions: Environment["actions"] = [];
  for (const a of entry.actions) {
    if (!isRecord(a) || typeof a.id !== "string" || typeof a.name !== "string") return undefined;
    if (a.icon !== undefined && typeof a.icon !== "string") return undefined;
    const command = scriptsOf(a.command);
    if (command === false || command === undefined) return undefined;
    actions.push({
      id: a.id,
      name: a.name,
      ...(typeof a.icon === "string" ? { icon: a.icon } : {}),
      command,
    });
  }
  const setup = scriptsOf(entry.setup);
  const cleanup = scriptsOf(entry.cleanup);
  if (setup === false || cleanup === false) return undefined;
  return {
    id: entry.id,
    name: entry.name,
    variables,
    actions,
    ...(setup !== undefined ? { setup } : {}),
    ...(cleanup !== undefined ? { cleanup } : {}),
  };
};

/**
 * The file, written whole and renamed into place, mode 0600. What this version does not understand is not shown and not
 * lost: an entry it cannot read, the fields it does not know of in one it can, a default that is not an id, and any
 * other key of the file are written back as they were. A file that is not JSON is kept beside, and the app starts
 * without environments.
 */
export const fileEnvironments = (path: string): EnvironmentStore => {
  let unknown: unknown[] = [];
  let rest: Record<string, unknown> = {};
  /** The defaults as they were in the file, with what is not an id among them. */
  let rawDefaults: Record<string, unknown> = {};
  const raw = new Map<string, Record<string, unknown>>();
  let saving: Promise<void> = Promise.resolve();

  const write = async (state: EnvironmentsFile): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    const ids = new Set(state.environments.map((e) => e.id));
    const environments = [
      ...state.environments.map((e) => {
        const before = raw.get(e.id);
        return before !== undefined && isDeepStrictEqual(environmentOf(before), e) ? before : e;
      }),
      ...unknown.filter((u) => !(isRecord(u) && typeof u.id === "string" && ids.has(u.id))),
    ];
    const defaults: Record<string, unknown> = {};
    for (const [locationId, folders] of Object.entries(rawDefaults)) {
      // What was there and is not a map of ids: kept as it was, unless the person set one for that location now.
      if (!isRecord(folders)) {
        if (state.defaults[locationId] === undefined) defaults[locationId] = folders;
        continue;
      }
      const kept = Object.fromEntries(
        Object.entries(folders).filter(([, id]) => typeof id !== "string"),
      );
      if (Object.keys(kept).length > 0) defaults[locationId] = kept;
    }
    for (const [locationId, folders] of Object.entries(state.defaults)) {
      const before = isRecord(defaults[locationId]) ? defaults[locationId] : {};
      const merged = { ...before, ...folders };
      if (Object.keys(merged).length > 0) defaults[locationId] = merged;
    }
    const text = `${JSON.stringify({ ...rest, environments, defaults }, null, 2)}\n`;
    await writeFile(temporary, text, { mode: 0o600 });
    // The mode a file is made with is narrowed by the umask, never widened: said again, in case it was left wider.
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    rawDefaults = defaults;
    raw.clear();
    for (const entry of environments)
      if (isRecord(entry) && typeof entry.id === "string" && ids.has(entry.id))
        raw.set(entry.id, entry);
  };

  return {
    async load() {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { environments: [], defaults: {} };
        if (error instanceof SyntaxError) {
          try {
            await copyFile(path, `${path}.broken-${Date.now()}`);
            unknown = [];
            rest = {};
            rawDefaults = {};
            raw.clear();
            return { environments: [], defaults: {} };
          } catch {
            // Falls through to the error below.
          }
        }
        throw new Error(
          `${path} cannot be read: ${error instanceof Error ? error.message : error}`,
        );
      }
      const record = isRecord(parsed) ? parsed : {};
      const { environments: entries, defaults: defaultsRead, ...others } = record;
      rest = others;
      unknown = [];
      raw.clear();
      const environments: Environment[] = [];
      for (const entry of Array.isArray(entries) ? entries : []) {
        const environment = environmentOf(entry);
        if (environment === undefined || raw.has(environment.id)) unknown.push(entry);
        else {
          environments.push(environment);
          raw.set(environment.id, entry as Record<string, unknown>);
        }
      }
      rawDefaults = isRecord(defaultsRead) ? defaultsRead : {};
      const defaults: EnvironmentsState["defaults"] = {};
      for (const [locationId, folders] of Object.entries(rawDefaults)) {
        if (!isRecord(folders)) continue;
        const ids = Object.entries(folders).filter(
          (pair): pair is [string, string] => typeof pair[1] === "string",
        );
        if (ids.length > 0) defaults[locationId] = Object.fromEntries(ids);
      }
      return { environments, defaults };
    },
    save(state) {
      const done = saving.then(
        () => write(state),
        () => write(state),
      );
      saving = done;
      return done;
    },
  };
};

/** For tests, and for an app run without a data directory: kept for as long as it runs. */
export const memoryEnvironments = (initial?: EnvironmentsFile): EnvironmentStore => {
  let state: EnvironmentsFile = structuredClone(initial ?? { environments: [], defaults: {} });
  return {
    load: async () => structuredClone(state),
    save: async (next) => {
      state = structuredClone(next);
    },
  };
};

type Track = <N extends EventName>(name: N, props: EventProps<N>) => void;

/**
 * The environments as the page asks for them: read once, changed one at a time, each change written before it is
 * answered. A default that names an environment that is not there is not one: it is left out of what the page sees.
 */
export class Environments {
  readonly #store: EnvironmentStore;
  readonly #track: Track;
  #state: Promise<EnvironmentsFile> | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(store: EnvironmentStore, track: Track = () => {}) {
    this.#store = store;
    this.#track = track;
  }

  #read(): Promise<EnvironmentsFile> {
    this.#state ??= this.#store.load().catch((error: unknown) => {
      this.#state = undefined;
      throw error;
    });
    return this.#state;
  }

  /** Changes run one after another, each from what the one before left. */
  #change<T>(change: (state: EnvironmentsFile) => Promise<T>): Promise<T> {
    const run = this.#queue.then(
      async () => change(await this.#read()),
      async () => change(await this.#read()),
    );
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async list(): Promise<EnvironmentsState> {
    return shown(await this.#read());
  }

  /** The environment as a session is sent it, or undefined when there is none of that id. */
  async snapshot(environmentId: string): Promise<Environment | undefined> {
    const found = (await this.#read()).environments.find((e) => e.id === environmentId);
    return found === undefined ? undefined : environmentSnapshot(found);
  }

  save(value: unknown): Promise<{ state: EnvironmentsState } | EnvironmentProblem> {
    return this.#change(async (state) => {
      const environment = environmentOf(value);
      if (environment === undefined)
        return { problem: "invalid", message: "This is not an environment Cycle can keep." };
      const named = { ...environment, name: environment.name.trim() };
      const problem = environmentProblem(named);
      if (problem !== undefined) return problem;
      const at = state.environments.findIndex((e) => e.id === named.id);
      const environments =
        at === -1
          ? [...state.environments, named]
          : state.environments.map((e, i) => (i === at ? named : e));
      const next = { ...state, environments };
      await this.#store.save(next);
      this.#state = Promise.resolve(next);
      const sent = environmentSnapshot(named);
      this.#track("environment_saved", {
        has_setup: sent.setup !== undefined,
        has_cleanup: sent.cleanup !== undefined,
        variables: named.variables.length,
        actions: named.actions.length,
      });
      return { state: shown(next) };
    });
  }

  remove(environmentId: unknown): Promise<EnvironmentsState> {
    return this.#change(async (state) => {
      if (
        typeof environmentId !== "string" ||
        !state.environments.some((e) => e.id === environmentId)
      )
        return shown(state);
      const defaults = withoutEmpty(
        Object.fromEntries(
          Object.entries(state.defaults).map(([locationId, folders]) => [
            locationId,
            Object.fromEntries(Object.entries(folders).filter(([, id]) => id !== environmentId)),
          ]),
        ),
      );
      const next = {
        environments: state.environments.filter((e) => e.id !== environmentId),
        defaults,
      };
      await this.#store.save(next);
      this.#state = Promise.resolve(next);
      this.#track("environment_removed", {});
      return shown(next);
    });
  }

  setDefault(
    locationId: unknown,
    cwd: unknown,
    environmentId: unknown,
  ): Promise<EnvironmentsState> {
    return this.#change(async (state) => {
      if (typeof locationId !== "string" || typeof cwd !== "string" || cwd === "")
        throw new Error("A workspace is a location and a folder");
      if (environmentId !== null && typeof environmentId !== "string")
        throw new Error("Not an environment");
      if (environmentId !== null && !state.environments.some((e) => e.id === environmentId))
        throw new Error("That environment was removed");
      const folders = { ...state.defaults[locationId] };
      if (environmentId === null) delete folders[cwd];
      else folders[cwd] = environmentId;
      const next = {
        ...state,
        defaults: withoutEmpty({ ...state.defaults, [locationId]: folders }),
      };
      await this.#store.save(next);
      this.#state = Promise.resolve(next);
      this.#track("environment_chosen", { none: environmentId === null });
      return shown(next);
    });
  }
}

const withoutEmpty = (defaults: EnvironmentsState["defaults"]): EnvironmentsState["defaults"] =>
  Object.fromEntries(
    Object.entries(defaults).filter(([, folders]) => Object.keys(folders).length > 0),
  );

/** What the page is given: the defaults that name an environment that is there. */
const shown = (state: EnvironmentsFile): EnvironmentsState => {
  const ids = new Set(state.environments.map((e) => e.id));
  const defaults: EnvironmentsState["defaults"] = {};
  for (const [locationId, folders] of Object.entries(state.defaults)) {
    const kept = Object.entries(folders).filter(([, id]) => ids.has(id));
    if (kept.length > 0) defaults[locationId] = Object.fromEntries(kept);
  }
  return { environments: structuredClone(state.environments), defaults };
};
