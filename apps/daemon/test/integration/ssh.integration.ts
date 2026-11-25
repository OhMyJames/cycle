// The ssh layer for real: a private sshd (unprivileged, on a loopback port, with a host key and an
// authorized key made for this test) and the system's `ssh` client, so nothing in ~/.ssh is read or
// changed. A client reaches the daemon through it, has a turn with a mock model, loses the connection,
// and comes back to the same daemon and the same history.
// Skipped if there is no sshd or ssh-keygen. Run with `bun run test:integration` (in apps/daemon).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { CycleClient, sshChannel } from "@cycle/client";
import {
  startMock,
  textReply,
} from "../../../../harness/claude/test/integration/mock-anthropic.ts";

const sshd = ["/usr/sbin/sshd", "/usr/local/sbin/sshd"].find((p) => existsSync(p));
const keygen = Bun.which("ssh-keygen");
const ssh = Bun.which("ssh");
const ready = sshd !== undefined && keygen !== null && ssh !== null;

const MAIN = new URL("../../src/main.ts", import.meta.url).pathname;
const BIN = process.env.CYCLE_DAEMON_BIN;
const DAEMON = BIN !== undefined ? [BIN] : [process.execPath, MAIN];

let root: string;
let server: ReturnType<typeof Bun.spawn> | undefined;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cv1-ssh-"));
});
afterAll(async () => {
  server?.kill();
  await rm(root, { recursive: true, force: true });
});

const until = async (condition: () => boolean, what: string, ms = 30_000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};

/**
 * Under Cycle's isolated agent env (`USER` and `LOGNAME` unset), Bun on macOS reports
 * `os.userInfo().username === "unknown"`, which sshd rejects. Fall back to `id -un`.
 */
const currentUsername = (): string => {
  try {
    const name = userInfo().username;
    if (name && name !== "unknown") return name;
  } catch {
    // Fall through to passwd lookup.
  }
  const id = Bun.spawnSync(["id", "-un"], { stdout: "pipe", stderr: "ignore" });
  const resolved = id.exitCode === 0 ? new TextDecoder().decode(id.stdout).trim() : "";
  if (resolved) return resolved;
  return userInfo().username;
};

test.skipIf(!ready)(
  "over real ssh: a turn, a dropped connection that changes nothing, and a new connection with the history",
  async () => {
    const username = currentUsername();
    const run = async (command: string[]) => {
      const p = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
      await p.exited;
      if (p.exitCode !== 0)
        throw new Error(`${command[0]} failed: ${await new Response(p.stderr).text()}`);
    };
    const hostKey = join(root, "host_key");
    const userKey = join(root, "user_key");
    await run([keygen as string, "-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
    await run([keygen as string, "-q", "-t", "ed25519", "-N", "", "-f", userKey]);
    await Bun.write(join(root, "authorized_keys"), await Bun.file(`${userKey}.pub`).text());
    const port = 20000 + Math.floor(Math.random() * 20000);
    const config = join(root, "sshd_config");
    await Bun.write(
      config,
      [
        `Port ${port}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${hostKey}`,
        `AuthorizedKeysFile ${join(root, "authorized_keys")}`,
        `PidFile ${join(root, "sshd.pid")}`,
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "UsePAM no",
        "StrictModes no",
        `AllowUsers ${username}`,
      ].join("\n"),
    );
    server = Bun.spawn([sshd as string, "-D", "-e", "-f", config], {
      stdout: "ignore",
      stderr: Bun.file(join(root, "sshd.log")),
    });
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      up = await Bun.connect({
        hostname: "127.0.0.1",
        port,
        socket: {
          data() {},
          open(s) {
            s.end();
          },
        },
      }).then(
        () => true,
        () => false,
      );
      if (!up) await Bun.sleep(50);
    }
    // An sshd that cannot start (no privilege separation directory, say) is a failure to explain, not to skip past.
    if (!up)
      throw new Error(`sshd did not start: ${await Bun.file(join(root, "sshd.log")).text()}`);

    const mock = startMock(() => textReply("Hello over ssh."));
    const dataDir = join(root, "data");
    const cwd = join(root, "work");
    await Bun.write(join(cwd, ".keep"), "");
    await Bun.write(
      join(dataDir, "config.json"),
      JSON.stringify({
        claude: {
          configDir: join(root, "claude"),
          env: { ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: "mock-key-not-real" },
        },
      }),
    );
    const connect = () =>
      sshChannel({
        host: `${username}@127.0.0.1`,
        args: [
          "-p",
          String(port),
          "-i",
          userKey,
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "StrictHostKeyChecking=accept-new",
          "-o",
          `UserKnownHostsFile=${join(root, "known_hosts")}`,
        ],
        command: [...DAEMON, "proxy", "--data-dir", dataDir, "--socket", join(root, "d.sock")],
      });
    try {
      const seen: SessionUpdate[] = [];
      const first = new CycleClient({
        connect: async () => connect(),
        events: { update: (_i, u) => seen.push(u) },
      });
      await first.start();
      const sessionId = await first.newSession({ cwd });
      await first.watch(sessionId, cwd);
      await first.prompt(sessionId, [{ type: "text", text: "Say hello." }]);
      await until(
        () => seen.some((u) => (u as { stopReason?: string }).stopReason === "end_turn"),
        "the turn",
      );
      await first.close();

      const again: SessionUpdate[] = [];
      const second = new CycleClient({
        connect: async () => connect(),
        events: { update: (_i, u) => again.push(u) },
      });
      await second.start();
      expect((await second.listSessions()).map((s) => s.sessionId)).toEqual([sessionId]);
      await second.watch(sessionId, cwd);
      const text = again
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => (u as unknown as { content: { text: string } }).content.text)
        .join("");
      expect(text).toBe("Hello over ssh.");
      await second.close();
    } finally {
      const pid = Number(
        (
          await Bun.file(join(dataDir, "daemon.pid"))
            .text()
            .catch(() => "")
        ).trim(),
      );
      if (pid > 0) process.kill(pid, "SIGTERM");
      mock.stop();
    }
  },
  90_000,
);
