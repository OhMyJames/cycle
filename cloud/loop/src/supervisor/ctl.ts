// `bun cloud/loop/src/supervisor/ctl.ts status|stop|start|restart [--data-dir DIR]` (CYC-484).

import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LOOP_STATUS, LoopStatusResultSchema } from "@cycle/protocol/loop";

export const pidFileOf = (dataDir: string): string => join(dataDir, "loop-supervisor.pid");

export const readSupervisorPid = (dataDir: string): number | null => {
  const path = pidFileOf(dataDir);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").trim();
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
};

export const rpcSocket = (
  socketPath: string,
  method: string,
  params?: unknown,
  timeoutMs = 5_000,
): Promise<unknown> =>
  new Promise((resolvePromise, reject) => {
    const socket = connect(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("socket timeout"));
    }, timeoutMs);
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })}\n`);
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        const msg = JSON.parse(buf.slice(0, nl)) as {
          result?: unknown;
          error?: { message: string };
        };
        if (msg.error) reject(new Error(msg.error.message));
        else resolvePromise(msg.result);
      } catch (err) {
        reject(err);
      }
    });
  });

if (import.meta.main) {
  const cmd = process.argv[2] ?? "status";
  const arg = (name: string) => {
    const at = process.argv.indexOf(name);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const dataDir = arg("--data-dir") ?? process.env.CYCLE_HOME ?? join(homedir(), ".cycle");
  const sock = join(dataDir, "loop.sock");
  const pid = readSupervisorPid(dataDir);

  if (cmd === "status") {
    console.log(`supervisor: ${pid !== null ? `running (pid ${pid})` : "stopped"}`);
    try {
      const status = LoopStatusResultSchema.parse(await rpcSocket(sock, LOOP_STATUS));
      console.log(`work loop: version ${status.version}, restartedAt ${status.restartedAt}`);
      for (const p of status.projects) {
        const busy =
          p.working.length === 0
            ? "idle"
            : p.working.map((w) => `${w.key}(${w.kind}:${w.phase})`).join(", ");
        console.log(`  [${p.project}] workers=${p.workers}: ${busy}`);
      }
    } catch (err) {
      console.log(`work loop: unreachable (${err instanceof Error ? err.message : String(err)})`);
    }
    process.exit(0);
  }

  if (cmd === "stop" || cmd === "restart") {
    if (pid !== null) {
      process.kill(pid, "SIGTERM");
      console.log(`sent SIGTERM to supervisor pid=${pid}`);
      if (cmd === "restart") {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0);
          } catch {
            break;
          }
          await Bun.sleep(200);
        }
        try {
          process.kill(pid, 0);
          console.error(
            `supervisor pid=${pid} is still draining after 30s; aborting restart to avoid lock collision`,
          );
          process.exit(1);
        } catch {
          // Exited cleanly.
        }
      }
    } else {
      console.log("supervisor is not running");
    }
    if (cmd === "stop") process.exit(0);
  }

  if (cmd === "start" || cmd === "restart") {
    const entry = resolve(import.meta.dir, "main.ts");
    const child = Bun.spawn([process.execPath, entry, "--data-dir", dataDir], {
      stdout: "inherit",
      stderr: "inherit",
      detached: true,
    });
    child.unref();
    console.log(`started supervisor pid=${child.pid}`);
    process.exit(0);
  }

  console.error(`unknown command: ${cmd} (expected status|stop|start|restart)`);
  process.exit(2);
}
