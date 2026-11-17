// Remote servers reached over ssh: what is accepted, which command lines are run, and what a
// failure is called. Pure. An ssh target and a path are arguments, never part of a shell string, apart
// from the one remote command, whose path is held to a few safe characters.
import type { RemoteInput, RemoteServer } from "../shared/remote-state";

/** Where a daemon keeps its files when its CYCLE_HOME is not set. */
export const DEFAULT_HOME = "~/.cycle-codex";
export const MAX_BACKOFF_MS = 30_000;
/** How often a held connection looks at the server's daemon file for a new token. */
export const WATCH_EVERY_MS = 15_000;
/** How often, and how far apart, the tunnel is asked for the daemon's health before giving up. */
export const READY_TRIES = 20;
export const READY_EVERY_MS = 250;

const TARGET = /^[A-Za-z0-9_][A-Za-z0-9._@:%+[\]-]{0,254}$/;
const HOME = /^(~\/|\/)[A-Za-z0-9._@+/-]*$/;
const hasControl = (text: string): boolean =>
  [...text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

export type Checked<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/** What the owner typed, made into what is stored, or why it is not accepted. */
export function checkInput(input: unknown): Checked<RemoteInput> {
  if (typeof input !== "object" || input === null) return { ok: false, error: "Not a server." };
  const { name, target, home } = input as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "" || name.length > 60 || hasControl(name)) {
    return { ok: false, error: "A name is 1 to 60 characters." };
  }
  // A leading dash would be an option of ssh, and whitespace or control characters have no place in
  // one argument that names a host.
  if (typeof target !== "string" || !TARGET.test(target)) {
    return { ok: false, error: "The ssh target is user@host or a name from your ssh config." };
  }
  if (home === undefined || home === "") {
    return { ok: true, value: { name: name.trim(), target } };
  }
  if (typeof home !== "string") return { ok: false, error: "The folder is a path." };
  const folder = home.length > 1 ? home.replace(/\/+$/, "") : home;
  if (!HOME.test(folder) || folder.split("/").includes("..") || folder === "~/" || folder === "/") {
    return { ok: false, error: "The folder is a path such as ~/.cycle-codex, without spaces." };
  }
  return { ok: true, value: { name: name.trim(), target, home: folder } };
}

/** Reads a stored list back, leaving out what would not be accepted today. */
export function parseRemotes(text: string): RemoteServer[] {
  try {
    const list = (JSON.parse(text) as { remotes?: unknown }).remotes;
    if (!Array.isArray(list)) return [];
    const remotes: RemoteServer[] = [];
    for (const entry of list) {
      const id = (entry as { id?: unknown } | null)?.id;
      const checked = checkInput(entry);
      if (typeof id === "string" && id !== "" && checked.ok) {
        remotes.push({ id, ...checked.value });
      }
    }
    return remotes;
  } catch {
    return [];
  }
}

export const serializeRemotes = (remotes: readonly RemoteServer[]): string =>
  `${JSON.stringify({ remotes }, null, 2)}\n`;

// BatchMode: ssh never waits for a password or a host key answer that nobody would see. No
// ControlPath: a tunnel is its own process, which closing it really closes. The owner's own ssh
// config and agent do the rest.
const QUIET = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "ControlPath=none"];

/** Prints the daemon's file on the server. */
export function readArgs(remote: RemoteServer): string[] {
  return [...QUIET, "--", remote.target, `cat ${remote.home ?? DEFAULT_HOME}/daemon.json`];
}

/** The same port here as there, because the daemon accepts only a Host that names its own port. */
export function tunnelArgs(remote: RemoteServer, port: number): string[] {
  return [
    "-N",
    ...QUIET,
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-L",
    `127.0.0.1:${port}:127.0.0.1:${port}`,
    "--",
    remote.target,
  ];
}

export type DaemonFacts = {
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  readonly version: string;
};

/** What the daemon wrote in its `daemon.json`. Its text is never part of an error. */
export function parseDaemonFile(text: string): DaemonFacts | undefined {
  try {
    const file = JSON.parse(text) as Record<string, unknown>;
    if (typeof file["pageUrl"] !== "string" || typeof file["token"] !== "string") return undefined;
    const port = Number(new URL(file["pageUrl"]).port);
    const pid = file["pid"];
    const version = file["version"];
    if (!Number.isInteger(port) || port < 1 || port > 65535 || file["token"] === "") {
      return undefined;
    }
    if (typeof pid !== "number" || typeof version !== "string") return undefined;
    return { port, token: file["token"], pid, version };
  } catch {
    return undefined;
  }
}

/** The page's address through the tunnel. The token is in the fragment, which never leaves the page. */
export const pageUrl = (port: number, token: string): string =>
  `http://127.0.0.1:${port}/#token=${encodeURIComponent(token)}`;

export const originOf = (port: number): string => `http://127.0.0.1:${port}`;

/** The daemon's answer to `/health`, or nothing when it is not one. */
export function parseHealth(text: string): { version: string } | undefined {
  try {
    const health = JSON.parse(text) as { ok?: unknown; version?: unknown };
    return health.ok === true && typeof health.version === "string"
      ? { version: health.version }
      : undefined;
  } catch {
    return undefined;
  }
}

export const versionWarning = (
  remote: RemoteServer,
  remoteVersion: string,
  localVersion: string | undefined,
): string | undefined =>
  localVersion !== undefined && localVersion !== remoteVersion
    ? `The daemon on ${remote.name} is version ${remoteVersion}; this machine's is ${localVersion}.`
    : undefined;

export const backoffMs = (attempt: number): number =>
  Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempt - 1));

/** A short reason from what ssh said, which never carries more than its first useful line. */
export function sshReason(stderr: string, remote: RemoteServer): string {
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) {
    return `ssh does not trust ${remote.target} yet. Run ssh ${remote.target} once in a terminal.`;
  }
  if (/Permission denied/i.test(stderr)) {
    return `ssh was refused by ${remote.target}: it needs a key from your agent or ssh config.`;
  }
  if (/Could not resolve hostname/i.test(stderr)) return `ssh cannot find ${remote.target}.`;
  if (/timed out|Connection refused|No route to host|Network is unreachable/i.test(stderr)) {
    return `ssh could not reach ${remote.target}.`;
  }
  if (/Address already in use|Could not request local forwarding|cannot listen/i.test(stderr)) {
    return "The daemon's port is already used on this machine.";
  }
  const line = stderr
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line ? `ssh failed: ${line.slice(0, 120)}` : "ssh failed.";
}

export const notRunning = (remote: RemoteServer): string =>
  `The daemon is not running on ${remote.name}.`;
