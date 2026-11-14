import type { MadeSandbox, SandboxBook, SandboxSpec } from "@cycle/harness-claude";
import type { SandboxEnvironment, SandboxEnvironmentDraft, SandboxSecret } from "@cycle/protocol";
import type { JsonStore } from "./store.ts";

/** An environment as it is kept: what a sandbox is made with, and the owner's name for it. */
export interface StoredEnvironment extends SandboxSpec {
  name: string;
}

/**
 * `sandboxes.json`: the owner's sandbox environments, variable values included, so the file is the
 * owner's alone, and what each sandbox Cycle made was made with.
 */
export interface SandboxesFile {
  environments: StoredEnvironment[];
  made: Record<string, MadeSandbox>;
}

/** What a home that has no file yet starts with: one environment with nothing chosen. */
export function newSandboxesFile(): SandboxesFile {
  return {
    environments: [
      {
        id: "standard",
        name: "Standard",
        cpus: null,
        memoryGb: null,
        hosts: [],
        variables: {},
        setup: "",
      },
    ],
    made: {},
  };
}

/** What the daemon asks of the sandboxes themselves. */
export interface SandboxAdmin {
  available(): boolean;
  forget(environment: string): Promise<void>;
  secrets(): Promise<SandboxSecret[]>;
  setSecret(service: string, value: string): Promise<void>;
}

export class SandboxError extends Error {}

const MAX_ENVIRONMENTS = 30;
const MAX_HOSTS = 100;
const MAX_VARIABLES = 50;
const MAX_VALUE = 4096;
const MAX_SETUP = 20_000;
const MAX_CPUS = 64;
const MAX_MEMORY_GB = 512;
/** A host as `sbx` takes one: a name, an address or a pattern of them, with a port or a prefix. */
const HOST = /^[a-z0-9*?[\]!][a-z0-9*?[\]!.:/-]*$/i;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/, "");
}

/** A whole number within a range, or null for nothing chosen. */
function amount(value: unknown, max: number, what: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new SandboxError(`${what} is a whole number from 1 to ${max}.`);
  }
  return value;
}

function cleanHosts(hosts: unknown): string[] {
  if (!Array.isArray(hosts)) return [];
  const clean = new Set<string>();
  for (const given of hosts) {
    const host = typeof given === "string" ? given.trim().toLowerCase() : "";
    if (!host) continue;
    // It goes to `sbx` as an argument, among others of its kind joined by commas.
    if (!HOST.test(host)) throw new SandboxError(`"${host.slice(0, 60)}" is not a host.`);
    clean.add(host);
  }
  if (clean.size > MAX_HOSTS) throw new SandboxError(`At most ${MAX_HOSTS} hosts.`);
  return [...clean];
}

function cleanVariables(given: unknown, stored: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  if (typeof given !== "object" || given === null) return clean;
  for (const [name, value] of Object.entries(given)) {
    if (!VARIABLE.test(name)) {
      throw new SandboxError(`"${name.slice(0, 60)}" is not a variable's name.`);
    }
    const kept = value === null ? stored[name] : value;
    if (typeof kept !== "string") throw new SandboxError(`${name} needs a value.`);
    if (kept.length > MAX_VALUE || /[\n\r\0]/.test(kept)) {
      throw new SandboxError(`${name}'s value is one line of at most ${MAX_VALUE} characters.`);
    }
    clean[name] = kept;
  }
  if (Object.keys(clean).length > MAX_VARIABLES) {
    throw new SandboxError(`At most ${MAX_VARIABLES} variables.`);
  }
  return clean;
}

function toView(stored: StoredEnvironment): SandboxEnvironment {
  const { variables, ...shown } = stored;
  return { ...shown, variables: Object.keys(variables).toSorted() };
}

/** What the sandboxes read and keep of `sandboxes.json`. */
export function sandboxBook(store: JsonStore<SandboxesFile>): SandboxBook {
  return {
    environment: (id) => store.value.environments.find((one) => one.id === id) ?? null,
    made: (name) => store.value.made[name] ?? null,
    allMade: () => ({ ...store.value.made }),
    setMade: (name, made) =>
      store.update((file) => {
        if (made) file.made[name] = made;
        else delete file.made[name];
      }),
  };
}

/**
 * The owner's sandbox environments. A variable's value comes in once and never goes back out: the
 * page sees its name.
 */
export class SandboxEnvironments {
  private readonly store: JsonStore<SandboxesFile>;
  private readonly changed: (environments: SandboxEnvironment[]) => void;

  constructor(
    store: JsonStore<SandboxesFile>,
    changed: (environments: SandboxEnvironment[]) => void,
  ) {
    this.store = store;
    this.changed = changed;
  }

  list(): SandboxEnvironment[] {
    return this.store.value.environments.map(toView);
  }

  has(id: string): boolean {
    return this.store.value.environments.some((one) => one.id === id);
  }

  save(draft: SandboxEnvironmentDraft): SandboxEnvironment {
    const all = this.store.value.environments;
    const existing = draft.id ? all.find((one) => one.id === draft.id) : undefined;
    if (draft.id && !existing) throw new SandboxError("That environment is gone.");
    if (!existing && all.length >= MAX_ENVIRONMENTS) {
      throw new SandboxError(`At most ${MAX_ENVIRONMENTS} environments.`);
    }
    const name = typeof draft.name === "string" ? draft.name.trim().slice(0, 60) : "";
    if (!name) throw new SandboxError("Give the environment a name.");
    if (all.some((one) => one !== existing && one.name.toLowerCase() === name.toLowerCase())) {
      throw new SandboxError("Another environment has that name.");
    }
    const setup = typeof draft.setup === "string" ? draft.setup.replace(/\r\n/g, "\n") : "";
    if (setup.length > MAX_SETUP || setup.includes("\0")) {
      throw new SandboxError(`The setup script is at most ${MAX_SETUP} characters.`);
    }
    const stored: StoredEnvironment = {
      id: existing?.id ?? this.newId(name),
      name,
      cpus: amount(draft.cpus, MAX_CPUS, "CPUs"),
      memoryGb: amount(draft.memoryGb, MAX_MEMORY_GB, "Memory"),
      hosts: cleanHosts(draft.hosts),
      variables: cleanVariables(draft.variables, existing?.variables ?? {}),
      setup: setup.trim() ? setup : "",
    };
    this.store.update((file) => {
      const index = file.environments.findIndex((one) => one.id === stored.id);
      if (index === -1) file.environments.push(stored);
      else file.environments[index] = stored;
    });
    this.changed(this.list());
    return toView(stored);
  }

  remove(id: string): void {
    if (!this.has(id)) return;
    if (this.store.value.environments.length === 1) {
      throw new SandboxError("Keep one environment: a sandbox is made with one.");
    }
    this.store.update((file) => {
      file.environments = file.environments.filter((one) => one.id !== id);
    });
    this.changed(this.list());
  }

  /** An id no environment has: it names the sandboxes made of it, so it never changes. */
  private newId(from: string): string {
    const base = slug(from) || "environment";
    const taken = new Set(this.store.value.environments.map((one) => one.id));
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    return id;
  }
}
