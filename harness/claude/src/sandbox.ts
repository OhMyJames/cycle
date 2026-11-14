import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SpawnedProcess } from "./sdk.ts";

/*
 * Docker Sandboxes (`sbx`) on this machine. A sandbox is a small virtual machine made for one
 * folder, which it sees at the same path as here, so only the agent moves into it: files, git and
 * terminals stay this machine's and mean the same thing. Claude Code keeps a folder's conversations
 * in one folder of its home; that folder alone is shared with the sandbox, so what is said inside
 * is stored here, where it is read back, and nothing else of the owner's Claude Code home is.
 *
 * Checked against the `sbx` CLI reference (docs.docker.com/reference/cli/sbx), not against a
 * running `sbx`.
 */

/** What Claude Code is started with, as the SDK asks for it. */
export interface SpawnRequest {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

/** Where sessions can run besides this machine itself. */
export interface Sandboxes {
  /** Whether sandboxes can be made here. */
  available(): boolean;
  /** Finds the sandbox of a folder, or makes it. Answers its name. `name` is one made before. */
  ensure(cwd: string, name?: string): Promise<string>;
  /** Starts Claude Code inside a sandbox. */
  start(name: string, request: SpawnRequest): SpawnedProcess;
}

/** The home of the user an agent runs as in a sandbox Docker provides. */
const SANDBOX_HOME = "/home/agent";
/** Claude Code names a long folder by a part of its path and a hash, which is not ours to guess. */
const MAX_FOLDER = 200;

/** Claude Code's name for the folder that holds a folder's conversations. */
export function projectFolder(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
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

/** A folder's sandbox: named for the folder, and told from another of that name by its path. */
export function sandboxName(cwd: string): string {
  const slug = basename(cwd)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `cycle-${slug || "folder"}-${hash(cwd)}`;
}

/** `sbx` arguments that make a folder's sandbox, with the folder's conversations shared into it. */
export function createArgs(name: string, cwd: string, claudeHome: string): string[] {
  const folder = projectFolder(cwd);
  return [
    "--no-input",
    "create",
    "--name",
    name,
    "claude",
    cwd,
    `${join(claudeHome, "projects", folder)}:${SANDBOX_HOME}/.claude/projects/${folder}`,
  ];
}

/**
 * What of the environment goes into the sandbox: what the SDK sets for Claude Code to know it is
 * driven, and nothing that is a secret. The rest is this machine's, and the sandbox has its own:
 * its sign-in is kept outside it, by `sbx`.
 */
export function sandboxEnv(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(
      ([key, value]) =>
        value !== undefined &&
        /^CLAUDE_(AGENT_SDK|CODE)_/.test(key) &&
        !/TOKEN|KEY|SECRET|PASSWORD/.test(key),
    )
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

/** What the sandboxes need of this machine, so a test can stand in for it. */
export interface SbxPorts {
  /** Where `sbx` is, or null when it is not installed. */
  which(): string | null;
  /** Runs `sbx` with these arguments to its end. */
  run(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Starts `sbx` with these arguments and answers the process. */
  start(args: string[], signal: AbortSignal): SpawnedProcess;
  makeFolder(path: string): Promise<void>;
}

/** Sandboxes through the `sbx` CLI. */
export class SbxSandboxes implements Sandboxes {
  private readonly ports: SbxPorts;
  private readonly claudeHome: string;
  private readonly making = new Map<string, Promise<string>>();

  constructor(ports: SbxPorts, claudeHome: string) {
    this.ports = ports;
    this.claudeHome = claudeHome;
  }

  available(): boolean {
    return this.ports.which() !== null;
  }

  ensure(cwd: string, name: string = sandboxName(cwd)): Promise<string> {
    let making = this.making.get(name);
    if (!making) {
      making = this.find(cwd, name).finally(() => this.making.delete(name));
      this.making.set(name, making);
    }
    return making;
  }

  start(name: string, request: SpawnRequest): SpawnedProcess {
    return this.ports.start(execArgs(name, request), request.signal);
  }

  private async find(cwd: string, name: string): Promise<string> {
    if (!this.available()) {
      throw new Error("Docker Sandboxes is not installed: `sbx` is not on the PATH.");
    }
    const folder = projectFolder(cwd);
    if (folder.length > MAX_FOLDER) {
      throw new Error("This folder's path is too long for its conversations to be shared.");
    }
    const listed = await this.ports.run(["ls", "-q"]);
    if (listed.exitCode !== 0) throw new Error(said("sbx could not list its sandboxes", listed));
    if (listed.stdout.split("\n").some((line) => line.trim() === name)) return name;
    // The folder shared into the sandbox must be there to share.
    await this.ports.makeFolder(join(this.claudeHome, "projects", folder));
    const made = await this.ports.run(createArgs(name, cwd, this.claudeHome));
    if (made.exitCode !== 0) throw new Error(said("sbx could not make the sandbox", made));
    return name;
  }
}

function said(what: string, result: { stdout: string; stderr: string }): string {
  const why = (result.stderr.trim() || result.stdout.trim()).split("\n").at(-1);
  return why ? `${what}: ${why}` : `${what}.`;
}

/** The `sbx` on this machine's `PATH`, with `env` as the environment it and its home are read from. */
export function sbxSandboxes(env: Record<string, string | undefined> = process.env): Sandboxes {
  const path = { PATH: env["PATH"] ?? "" };
  const which = () => Bun.which("sbx", path);
  const command = () => which() ?? "sbx";
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) childEnv[key] = value;
  return new SbxSandboxes(
    {
      which,
      async run(args) {
        const child = Bun.spawn([command(), ...args], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: childEnv,
        });
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        return { exitCode, stdout, stderr };
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
    },
    env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude"),
  );
}
