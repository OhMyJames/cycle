// What the remote connection does to the world: ssh as a child process, the loopback port, files.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import type { ConnectionPorts, Ssh, Tunnel } from "./connection";
import type { TextFile } from "./store";

const RUN_TIMEOUT_MS = 20_000;
const ANSWER_TIMEOUT_MS = 3_000;
const STDERR_KEPT = 2_000;

export function sshPorts(env: Readonly<Record<string, string | undefined>>): Ssh {
  const childEnv = env as NodeJS.ProcessEnv;
  return {
    run: (args) =>
      new Promise((resolve) => {
        execFile(
          "ssh",
          [...args],
          { env: childEnv, timeout: RUN_TIMEOUT_MS },
          (error, stdout, stderr) =>
            resolve({
              code: error ? (typeof error.code === "number" ? error.code : null) : 0,
              stdout,
              stderr: error && typeof error.code !== "number" ? String(error.message) : stderr,
            }),
        );
      }),
    tunnel(args): Tunnel {
      const child: ChildProcess = spawn("ssh", [...args], {
        env: childEnv,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      let exited = false;
      const listeners: (() => void)[] = [];
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_KEPT);
      });
      const end = (message?: string): void => {
        if (exited) return;
        exited = true;
        if (message) stderr += message;
        for (const listener of listeners) listener();
      };
      // A missing `ssh` is an error event and no exit.
      child.once("error", (error) => end(error.message));
      child.once("exit", () => end());
      return {
        exited: () => exited,
        stderr: () => stderr,
        onExit(listener) {
          if (exited) listener();
          else listeners.push(listener);
        },
        kill: () => {
          child.kill();
        },
      };
    },
  };
}

export const localPortFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });

async function get(url: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) });
  return { status: response.status, text: await response.text() };
}

export type SystemOptions = {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** This machine's own daemon's origin. */
  readonly localOrigin: () => string;
  readonly show: ConnectionPorts["show"];
  readonly onState: ConnectionPorts["onState"];
};

export function connectionPorts(options: SystemOptions): ConnectionPorts {
  return {
    ssh: sshPorts(options.env),
    fetch: get,
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    portFree: localPortFree,
    localVersion: async () => {
      try {
        const answer = await get(`${options.localOrigin()}/health`);
        return (JSON.parse(answer.text) as { version?: string }).version;
      } catch {
        return undefined;
      }
    },
    show: options.show,
    onState: options.onState,
  };
}

/** `remotes.json` in the local CYCLE_HOME, for the owner alone. */
export function remotesFile(home: string): TextFile {
  const file = path.join(home, "remotes.json");
  return {
    read: () => readFile(file, "utf8").catch(() => undefined),
    keepAside: () => rename(file, `${file}.bad`).catch(() => undefined),
    async write(text) {
      await mkdir(home, { recursive: true, mode: 0o700 });
      await writeFile(file, text, { mode: 0o600 });
      await chmod(file, 0o600);
    },
  };
}
