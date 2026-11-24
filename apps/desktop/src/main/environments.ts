// The environments the person defined (docs/desktop.md "环境"): reusable setups of scripts, variables and actions, and
// the one each workspace starts with. Kept in `environments.json` of the app's data, apart from `settings.json` (whose
// old `environments` key was the list of locations), with mode 0600: variables can be secrets. Nothing here knows
// Electron; nothing here logs or reports a name, a value or a command.
import type { EventName, EventProps } from "@cycle/analytics/events";
import {
  type Environment,
  type EnvironmentProblem,
  type EnvironmentRefusal,
  type EnvironmentScripts,
  type EnvironmentSecret,
  type EnvironmentsState,
  environmentProblem,
  environmentSnapshot,
  SCRIPT_SYSTEMS,
  workspaceKey,
} from "@cycle/ui";
import { isRecord, jsonFile, KeptEntries } from "./json-file.ts";

/** What the file holds, as this app reads it, and what it does not understand, to be written back as it was. */
export type EnvironmentsFile = EnvironmentsState;

export type EnvironmentStore = {
  load(): Promise<EnvironmentsFile>;
  save(state: EnvironmentsFile): Promise<void>;
};

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

const isSecret = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.name === "string" &&
  (value.from === undefined || typeof value.from === "string");

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
  // A file from before secrets has none.
  if (
    entry.secrets !== undefined &&
    !(Array.isArray(entry.secrets) && entry.secrets.every(isSecret))
  )
    return undefined;
  const secrets = ((entry.secrets ?? []) as Record<string, unknown>[]).map(
    (s): EnvironmentSecret => ({
      name: s.name as string,
      ...(typeof s.from === "string" ? { from: s.from } : {}),
    }),
  );
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
    secrets,
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
  const file = jsonFile(path, { mode: 0o600 });
  const entries = new KeptEntries({ parse: environmentOf, idOf: (e: Environment) => e.id });
  let rest: Record<string, unknown> = {};
  /** The defaults as they were in the file, with what is not an id among them. */
  let rawDefaults: Record<string, unknown> = {};
  return {
    async load() {
      const record = (await file.read()) ?? {};
      const { environments: list, defaults: defaultsRead, ...others } = record;
      rest = others;
      const environments = entries.read(Array.isArray(list) ? list : []);
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
    async save(state) {
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
      // Remembered once the file has it: a write that fails leaves what the file still holds to compare with.
      const written = entries.write(state.environments);
      await file.write({ ...rest, environments: written.entries, defaults });
      written.commit();
      rawDefaults = defaults;
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
    this.#state ??= this.#store.load().then(keyedByWorkspace, (error: unknown) => {
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

  /**
   * The environment as a session is sent it; or why it cannot be: there is none of that id (`missing`), or it does not
   * pass the daemon's rules (`needs_fix`, with its name: the file was written by hand or by another version; Settings
   * says what to fix). `invalid_environment` is the daemon's own word, for one it could not read.
   */
  async snapshot(environmentId: string): Promise<Environment | { problem: EnvironmentRefusal }> {
    const found = (await this.#read()).environments.find((e) => e.id === environmentId);
    if (found === undefined) return { problem: { reason: "missing" } };
    if (environmentProblem(found) !== undefined)
      return { problem: { reason: "needs_fix", name: found.name } };
    return environmentSnapshot(found);
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
      this.#track("environment_config_saved", {
        has_setup: sent.setup !== undefined,
        has_cleanup: sent.cleanup !== undefined,
        variables: named.variables.length + named.secrets.length,
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
      this.#track("environment_config_removed", {});
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
      const key = workspaceKey(cwd);
      if (environmentId === null) delete folders[key];
      else folders[key] = environmentId;
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

/**
 * The defaults under their workspace's key (`/repo/` is `/repo`): what an older version kept under another form of the
 * same folder is that folder's, unless the folder's own form has one.
 */
const keyedByWorkspace = (state: EnvironmentsFile): EnvironmentsFile => {
  const defaults: EnvironmentsState["defaults"] = {};
  for (const [locationId, folders] of Object.entries(state.defaults)) {
    const keyed: Record<string, string> = {};
    for (const [cwd, id] of Object.entries(folders)) {
      const key = workspaceKey(cwd);
      if (keyed[key] === undefined || key === cwd) keyed[key] = id;
    }
    defaults[locationId] = keyed;
  }
  return { ...state, defaults };
};

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
