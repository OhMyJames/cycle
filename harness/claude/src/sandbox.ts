import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SpawnedProcess } from "./sdk.ts";

/*
 * Docker Sandboxes (`sbx`) on this machine. A sandbox is a small virtual machine made for one
 * folder, which it sees under a name of the sandbox's own, so none of where the folder is on this
 * machine is in it: only the agent moves into it, and files, git and terminals stay this machine's.
 * `sbx` will not put the workspace it is made on anywhere but its host path, so an empty folder is
 * that workspace and the folder itself is mounted beside it.
 *
 * Claude Code keeps a folder's conversations in one folder of its home; that folder alone is
 * shared with the sandbox, from a home of the sandbox's own under `CYCLE_HOME`, so what is said
 * inside is stored there and nothing of the owner's Claude Code home is in the sandbox.
 *
 * Checked against the `sbx` CLI on this machine (0.53): a primary workspace cannot be mounted at
 * another path, an additional one can.
 */

/** What Claude Code is started with, as the SDK asks for it. */
export interface SpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

/** What a sandbox is made with. The owner keeps these, by name, and a session chooses one. */
export interface SandboxSpec {
  id: string;
  /** How many CPUs it may use. Null leaves it to `sbx`, which gives it all of them. */
  cpus: number | null;
  /** Its memory in GiB. Null leaves it to `sbx`, which gives it half of this machine's. */
  memoryGb: number | null;
  /** The hosts it may reach beyond what `sbx` allows every sandbox. */
  hosts: string[];
  /** Its environment variables. */
  variables: Record<string, string>;
  /** A script run in it once, when it is made, in the folder. */
  setup: string;
}

/** A sandbox Cycle made, as it was when made: what tells one to be made again from one to keep. */
export interface MadeSandbox {
  environment: string;
  /** `specVersion` of what it was made with. */
  version: string;
  /** The hosts allowed to it so far. */
  hosts: string[];
  /** The folder it works in here. Left out of one made before this was kept. */
  cwd?: string;
  /** What it sees, as `LAYOUT` names it. Left out of one made before this was kept. */
  layout?: number;
}

/** The owner's environments and the sandboxes made of them, which whoever starts this keeps. */
export interface SandboxBook {
  environment(id: string): SandboxSpec | null;
  made(name: string): MadeSandbox | null;
  /** Every sandbox made, by name. */
  allMade(): Record<string, MadeSandbox>;
  setMade(name: string, made: MadeSandbox | null): void;
}

/** Which sandbox is asked for: a folder's in an environment, or one made before, by name. */
export type SandboxAsk = { environment: string } | { name: string };

/** Where sessions can run besides this machine itself. */
export interface Sandboxes {
  /** Whether sandboxes can be made here. */
  available(): boolean;
  /** Finds the sandbox of a folder, or makes it. Answers its name. */
  ensure(cwd: string, ask: SandboxAsk): Promise<string>;
  /** Starts Claude Code inside a sandbox. */
  start(name: string, request: SpawnRequest): SpawnedProcess;
  /** The Claude Code home a sandbox keeps, where its conversations are. */
  home(name: string): string;
  /** The sandboxes made, each with the folder it works in here. */
  made(): { name: string; cwd: string }[];
  /** Says which folder a sandbox works in, when it was made before that was kept. */
  remember(name: string, cwd: string): void;
}

/** The services `sbx` keeps a secret for, outside every sandbox. */
export const SANDBOX_SERVICES = [
  "anthropic",
  "github",
  "openai",
  "google",
  "openrouter",
  "groq",
  "mistral",
  "xai",
] as const;

/** An environment with nothing chosen: what a sandbox whose environment is gone is made with. */
export function plainSpec(id: string): SandboxSpec {
  return {
    id,
    cpus: null,
    memoryGb: null,
    hosts: [],
    variables: {},
    setup: "",
  };
}

/** The home of the user an agent runs as in a sandbox Docker provides. */
const SANDBOX_HOME = "/home/agent";
/** Where a sandbox sees the folder it works in: the folder's name, and nothing above it. */
const SANDBOX_WORKSPACE = "/home/agent/workspace";
/** Where the empty folder each sandbox is made on is kept, named by nothing of the project's. */
const SANDBOX_PRIMARY = "/tmp/cycle-sandbox";
/** How long `sbx` has to make a sandbox, pulling its image the first time. */
const MAKE_TIMEOUT_MS = 20 * 60_000;
/** How long a setup script has. One that waits for an answer waits this long, and has failed. */
const SETUP_TIMEOUT_MS = 30 * 60_000;

/** Claude Code's name for the folder that holds a folder's conversations. */
export function projectFolder(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Where a sandbox sees a folder: its own name, and none of where it is on this machine. */
export function sandboxCwd(cwd: string): string {
  const name = basename(cwd)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 120)
    .replace(/[.-]+$/, "");
  return `${SANDBOX_WORKSPACE}/${name || "project"}`;
}

/** The Claude Code home a sandbox keeps, which is its conversations and no other of the owner's. */
export function sandboxHome(homes: string, name: string): string {
  return join(homes, name, "claude");
}

/** The owner's Claude Code home, where its CLI keeps its settings and conversations. */
export function claudeHomeOf(env: Record<string, string | undefined>): string {
  return env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
}

/** The empty folder a sandbox is made on, which says nothing of the folder it works in. */
function primaryOf(name: string): string {
  return join(SANDBOX_PRIMARY, hash(name));
}

/** FNV-1a: enough to tell two folders of one name apart. */
function hash(text: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(16).padStart(8, "0");
}

/**
 * A folder's sandbox in an environment: named for the folder, and told from another of that name by
 * its path and the environment.
 */
export function sandboxName(cwd: string, environment: string): string {
  const slug = basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `cycle-${slug || "folder"}-${hash(`${cwd}\n${environment}`)}`;
}

/** What the sandboxes of this version see: the paths a sandbox is made with, which are not chosen. */
const LAYOUT = 2;

/** What a sandbox must be made again for: all of its environment that only its making sets. */
export function specVersion(spec: SandboxSpec): string {
  const variables = Object.entries(spec.variables).toSorted(([a], [b]) => a.localeCompare(b));
  return hash(JSON.stringify([LAYOUT, spec.cpus, spec.memoryGb, variables, spec.setup]));
}

/** The saved sandbox an environment's others start from, with its setup already run. */
export function templateTag(spec: SandboxSpec): string {
  return `${templatePrefix(spec.id)}${hash(spec.setup)}`;
}

function templatePrefix(environment: string): string {
  return `cycle-env-${environment}:`;
}

/** An environment's variables as the file `sbx` reads them from: a `NAME=value` on each line. */
export function envFile(variables: Record<string, string>): string {
  return Object.entries(variables)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
}

/**
 * `sbx` arguments that make a folder's sandbox, with the folder's conversations shared into it.
 * Its variables are read from a file, `variablesFile`: no value is in an argument, and none is in
 * the environment `sbx` itself runs with, where a `PATH` or a `HOME` meant for the sandbox would
 * change what `sbx` does here. `template` is a saved sandbox to start from. `home` is the
 * sandbox's own Claude Code home, whose conversations folder is the one shared.
 *
 * The workspace `sbx` is made on is an empty folder: `sbx` mounts a primary workspace at its host
 * path alone, which would put this machine's path in the sandbox. The folder itself is mounted
 * beside it, under a name that is only its own.
 */
export function createArgs(
  name: string,
  cwd: string,
  home: string,
  spec: SandboxSpec = plainSpec(""),
  template: string | null = null,
  variablesFile: string | null = null,
): string[] {
  const inside = sandboxCwd(cwd);
  const folder = projectFolder(inside);
  return [
    "--no-input",
    "create",
    "--name",
    name,
    ...(spec.cpus ? ["--cpus", String(spec.cpus)] : []),
    ...(spec.memoryGb ? ["--memory", `${spec.memoryGb}g`] : []),
    ...(variablesFile ? ["--env-file", variablesFile] : []),
    ...(template ? ["-t", template, "--pull", "never"] : []),
    "claude",
    primaryOf(name),
    `${cwd}:${inside}`,
    `${join(home, "projects", folder)}:${SANDBOX_HOME}/.claude/projects/${folder}`,
  ];
}

/** What the SDK sets for the Claude Code it starts to know it is driven, and how. */
const DRIVEN = new Set([
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SDK_READS_SESSION_STATE",
]);

/**
 * What of the environment goes into the sandbox: what the SDK sets for Claude Code to know it is
 * driven, and nothing else. The rest is this machine's, the daemon's own Claude Code variables
 * among it when it was started from one, and the sandbox has its own: its sign-in is kept outside
 * it, by `sbx`, and its variables are its environment's.
 */
export function sandboxEnv(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([key, value]) => value !== undefined && DRIVEN.has(key))
    .map(([key, value]) => `${key}=${value}`)
    .toSorted();
}

/** `sbx` arguments that run the sandbox's own Claude Code with what the SDK asked for. */
export function execArgs(name: string, request: SpawnRequest): string[] {
  return [
    "exec",
    "-i",
    ...(request.cwd ? ["-w", request.cwd] : []),
    ...sandboxEnv(request.env).flatMap((pair) => ["-e", pair]),
    name,
    "claude",
    ...request.args,
  ];
}

/** What `sbx` said of a command it ran to its end. */
export interface SbxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** What the sandboxes need of this machine, so a test can stand in for it. */
export interface SbxPorts {
  /** Where `sbx` is, or null when it is not installed. */
  which(): string | null;
  /**
   * Runs `sbx` with these arguments to its end, with this on its input. One that is not over
   * after `timeoutMs` is stopped, and has failed.
   */
  run(args: string[], more?: { input?: string; timeoutMs?: number }): Promise<SbxResult>;
  /** Keeps text in a file only the owner can read, for as long as `use` runs. */
  withFile<T>(text: string, use: (path: string) => Promise<T>): Promise<T>;
  /** Starts `sbx` with these arguments and answers the process. */
  start(args: string[], signal: AbortSignal): SpawnedProcess;
  makeFolder(path: string): Promise<void>;
  /** Told what went wrong with something that is not worth failing for. */
  log?(line: string): void;
}

function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Sandboxes through the `sbx` CLI. */
export class SbxSandboxes implements Sandboxes {
  private readonly ports: SbxPorts;
  private readonly homes: string;
  private readonly book: SandboxBook;
  private readonly making = new Map<string, Promise<string>>();
  /** How many processes this started in each sandbox are still running. */
  private readonly running = new Map<string, number>();

  constructor(ports: SbxPorts, homes: string, book: SandboxBook) {
    this.ports = ports;
    this.homes = homes;
    this.book = book;
  }

  available(): boolean {
    return this.ports.which() !== null;
  }

  home(name: string): string {
    return sandboxHome(this.homes, name);
  }

  made(): { name: string; cwd: string }[] {
    return Object.entries(this.book.allMade())
      .filter(([, made]) => made.cwd !== undefined)
      .map(([name, made]) => ({ name, cwd: made.cwd as string }));
  }

  remember(name: string, cwd: string): void {
    const made = this.book.made(name);
    if (made && made.cwd === undefined) this.book.setMade(name, { ...made, cwd });
  }

  ensure(cwd: string, ask: SandboxAsk): Promise<string> {
    if ("environment" in ask && !this.book.environment(ask.environment)) {
      return Promise.reject(new Error("That sandbox environment is gone."));
    }
    const environment =
      "environment" in ask ? ask.environment : (this.book.made(ask.name)?.environment ?? "");
    const name = "name" in ask ? ask.name : sandboxName(cwd, environment);
    let making = this.making.get(name);
    if (!making) {
      making = this.find(cwd, name, environment).finally(() => this.making.delete(name));
      this.making.set(name, making);
    }
    return making;
  }

  start(name: string, request: SpawnRequest): SpawnedProcess {
    const child = this.ports.start(execArgs(name, request), request.signal);
    this.running.set(name, (this.running.get(name) ?? 0) + 1);
    let over = false;
    const ended = () => {
      if (over) return;
      over = true;
      const left = (this.running.get(name) ?? 1) - 1;
      if (left > 0) this.running.set(name, left);
      else this.running.delete(name);
    };
    child.once("exit", ended);
    // One that never started says so, and never exits.
    child.once("error", ended);
    return child;
  }

  /**
   * Removes what was made of an environment that is gone: its sandboxes, but for one with a session
   * running in it, and the saved sandbox its others started from.
   */
  async forget(environment: string): Promise<void> {
    if (!this.available()) return;
    for (const [name, made] of Object.entries(this.book.allMade())) {
      if (made.environment !== environment || this.running.has(name)) continue;
      const removed = await this.ports.run(["rm", "--force", name]);
      // One that could not be removed is still known, so it can be found and removed later.
      if (removed.exitCode === 0) this.book.setMade(name, null);
      else this.ports.log?.(said(`sbx could not remove ${name}`, removed));
    }
    await this.dropTemplates(environment, null);
  }

  /** The services, and whether `sbx` holds a secret for each that every sandbox may use. */
  async secrets(): Promise<{ service: string; set: boolean }[]> {
    const listed = this.available()
      ? await this.ports.run(["secret", "ls", "--global", "-q"])
      : null;
    const words = new Set(
      listed?.exitCode === 0 ? listed.stdout.toLowerCase().split(/[^a-z0-9]+/) : [],
    );
    return SANDBOX_SERVICES.map((service) => ({
      service,
      set: words.has(service),
    }));
  }

  /** Gives `sbx` a service's secret to keep, over its input: it is in no argument and kept nowhere here. */
  async setSecret(service: string, value: string): Promise<void> {
    if (!(SANDBOX_SERVICES as readonly string[]).includes(service)) {
      throw new Error("That service is not one sbx keeps a secret for.");
    }
    const secret = value.trim();
    if (!secret || /\s/.test(secret)) throw new Error("Enter the secret, with no spaces in it.");
    this.installed();
    const set = await this.ports.run(["secret", "set", service, "--force"], {
      input: `${secret}\n`,
    });
    // What `sbx` says of a failure could repeat its input, so none of it is passed on.
    if (set.exitCode !== 0) throw new Error("sbx could not store the secret.");
  }

  private installed(): void {
    if (!this.available()) {
      throw new Error("Docker Sandboxes is not installed: `sbx` is not on the PATH.");
    }
  }

  private async find(cwd: string, name: string, environment: string): Promise<string> {
    this.installed();
    const folder = projectFolder(sandboxCwd(cwd));
    if (cwd.includes(":")) {
      throw new Error("This folder's path holds a colon, which sbx would read as a mount target.");
    }
    // Both folders a sandbox is made on must be there to share: the empty one it is made on, which
    // a reboot can take away, and the one what is said in it is kept in.
    const home = this.home(name);
    await this.ports.makeFolder(primaryOf(name));
    await this.ports.makeFolder(join(home, "projects", folder));
    const spec = this.book.environment(environment) ?? plainSpec(environment);
    const version = specVersion(spec);
    const listed = await this.ports.run(["ls", "-q"]);
    if (listed.exitCode !== 0) throw new Error(said("sbx could not list its sandboxes", listed));
    let exists = lines(listed.stdout).includes(name);
    // One this did not make was made with nothing chosen.
    let made = exists ? (this.book.made(name) ?? plainMade(environment)) : null;
    // One made before its folder was kept gets it now, so its conversations can be found again.
    if (made && made.cwd === undefined) {
      made = { ...made, cwd };
      this.book.setMade(name, made);
    }
    if (made && made.version !== version && this.running.has(name) && made.layout !== LAYOUT) {
      // The paths a sandbox sees are not what they were, so it cannot run the session asked for.
      throw new Error(
        "The sandbox must be made again, and a session is running in it. Stop it, then try again.",
      );
    }
    if (made && made.version !== version && !this.running.has(name)) {
      // What changed is set only as a sandbox is made, so it is made again. One with a session
      // running in it stays as it is until that is over.
      const removed = await this.ports.run(["rm", "--force", name]);
      if (removed.exitCode !== 0)
        throw new Error(said("sbx could not remove the sandbox", removed));
      this.book.setMade(name, null);
      exists = false;
      made = null;
    }
    if (!exists) {
      await this.make(cwd, name, spec);
      made = { environment, version, hosts: [], cwd, layout: LAYOUT };
      this.book.setMade(name, made);
    }
    if (made) await this.allow(name, made, spec.hosts);
    return name;
  }

  private async make(cwd: string, name: string, spec: SandboxSpec): Promise<void> {
    const home = this.home(name);
    const tag = spec.setup.trim() ? templateTag(spec) : null;
    const saved = tag !== null && (await this.templates()).includes(tag);
    const create = (file: string | null) =>
      this.ports.run(createArgs(name, cwd, home, spec, saved ? tag : null, file), {
        timeoutMs: MAKE_TIMEOUT_MS,
      });
    const variables = envFile(spec.variables);
    const made = variables ? await this.ports.withFile(variables, create) : await create(null);
    if (made.exitCode !== 0) throw new Error(said("sbx could not make the sandbox", made));
    if (tag === null || saved) return;
    const setup = await this.ports.run(
      ["exec", "-w", sandboxCwd(cwd), name, "bash", "-lc", spec.setup],
      { timeoutMs: SETUP_TIMEOUT_MS },
    );
    if (setup.exitCode !== 0) {
      // A sandbox half set up is not one to work in, or to find again as if it were whole.
      await this.ports.run(["rm", "--force", name]);
      // What the script printed may hold a variable's value, which is not for the page or a log.
      throw new Error(hide(said("The sandbox's setup script failed", setup), spec.variables));
    }
    // Saved, the next folder's sandbox starts from here instead of running the script again.
    const kept = await this.ports.run(["template", "save", name, tag]);
    if (kept.exitCode !== 0) this.ports.log?.(said("sbx could not save the sandbox", kept));
    else await this.dropTemplates(spec.id, tag);
  }

  /** Brings the hosts a sandbox may reach to what its environment says now. */
  private async allow(name: string, made: MadeSandbox, hosts: string[]): Promise<void> {
    const added = hosts.filter((host) => !made.hosts.includes(host));
    const dropped = made.hosts.filter((host) => !hosts.includes(host));
    if (!added.length && !dropped.length) return;
    if (dropped.length) {
      const gone = await this.ports.run([
        "policy",
        "rm",
        "network",
        "--sandbox",
        name,
        "--force",
        "--resource",
        dropped.join(","),
      ]);
      if (gone.exitCode !== 0) throw new Error(said("sbx could not close the network", gone));
    }
    if (added.length) {
      const open = await this.ports.run([
        "policy",
        "allow",
        "network",
        "--sandbox",
        name,
        added.join(","),
      ]);
      if (open.exitCode !== 0) throw new Error(said("sbx could not open the network", open));
    }
    this.book.setMade(name, { ...made, hosts: [...hosts] });
  }

  private async templates(): Promise<string[]> {
    const listed = await this.ports.run(["template", "ls", "-q"]);
    return listed.exitCode === 0 ? lines(listed.stdout) : [];
  }

  /** Removes an environment's saved sandboxes, but for the one to keep. */
  private async dropTemplates(environment: string, keep: string | null): Promise<void> {
    const prefix = templatePrefix(environment);
    for (const tag of await this.templates()) {
      if (tag.startsWith(prefix) && tag !== keep) await this.ports.run(["template", "rm", tag]);
    }
  }
}

/** A text with each variable's value taken out of it. */
function hide(text: string, variables: Record<string, string>): string {
  let shown = text;
  for (const value of Object.values(variables)) {
    if (value.length >= 4) shown = shown.split(value).join("***");
  }
  return shown;
}

function plainMade(environment: string): MadeSandbox {
  return {
    environment,
    version: specVersion(plainSpec(environment)),
    hosts: [],
  };
}

function said(what: string, result: { stdout: string; stderr: string }): string {
  const why = (result.stderr.trim() || result.stdout.trim()).split("\n").at(-1);
  return why ? `${what}: ${why}` : `${what}.`;
}

/**
 * The `sbx` on this machine's `PATH`, with `env` as the environment it is run with. `homes` is
 * where the sandboxes keep their own Claude Code homes, under `CYCLE_HOME`.
 */
export function sbxSandboxes(
  book: SandboxBook,
  homes: string,
  env: Record<string, string | undefined> = process.env,
  log?: (line: string) => void,
): SbxSandboxes {
  const path = { PATH: env["PATH"] ?? "" };
  const which = () => Bun.which("sbx", path);
  const command = () => which() ?? "sbx";
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) childEnv[key] = value;
  return new SbxSandboxes(
    {
      which,
      async run(args, more) {
        const child = Bun.spawn([command(), ...args], {
          stdin: more?.input === undefined ? "ignore" : new Response(more.input),
          stdout: "pipe",
          stderr: "pipe",
          env: childEnv,
          ...(more?.timeoutMs ? { timeout: more.timeoutMs } : {}),
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        if (child.signalCode && more?.timeoutMs) {
          return { exitCode: exitCode || 1, stdout, stderr: `${stderr}\nIt took too long.` };
        }
        return { exitCode, stdout, stderr };
      },
      async withFile(text, use) {
        const folder = await mkdtemp(join(tmpdir(), "cycle-sbx-"));
        const file = join(folder, "variables");
        try {
          await writeFile(file, text, { mode: 0o600 });
          return await use(file);
        } finally {
          await rm(folder, { recursive: true, force: true });
        }
      },
      // A child process is what the SDK starts itself: it has all the SDK asks of one.
      start: (args, signal) =>
        spawn(command(), args, {
          env: childEnv,
          stdio: ["pipe", "pipe", "inherit"],
          signal,
        }) as unknown as SpawnedProcess,
      makeFolder: async (folder) => {
        await mkdir(folder, { recursive: true });
      },
      ...(log ? { log } : {}),
    },
    homes,
    book,
  );
}
