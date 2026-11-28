// A real daemon switching itself to a staged version, and back when the new one does not start (docs/daemon.md "自动更新",
// CYC-538). It needs the compiled daemon (CYCLE_DAEMON_BIN, as the release and daemon-release workflows give it), set
// up where the app puts it (`<root>/daemon/bin`). The staged version is the same program under a higher number, or a
// program that exits at once. The daemon looks for a version to switch to every 30 s, so each step waits up to 75 s.
// No network: the first look at the channel is 2 minutes after the start, after this test.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isListening } from "../../src/transport/server.ts";

const BIN = process.env.CYCLE_DAEMON_BIN;
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cv1-self-update-"));
});
afterAll(async () => {
  const pid = Number(await readFile(join(root, "data", "daemon.pid"), "utf8").catch(() => ""));
  if (pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await rm(root, { recursive: true, force: true });
});

const until = async <T>(what: string, ms: number, look: () => Promise<T | undefined>) => {
  const at = Date.now();
  for (;;) {
    const found = await look();
    if (found !== undefined) return found;
    if (Date.now() - at > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(250);
  }
};

const run = (argv: string[]) => {
  const result = Bun.spawnSync(argv, { stderr: "pipe" });
  if (!result.success) throw new Error(`${argv.join(" ")}: ${result.stderr.toString()}`);
};

test.skipIf(BIN === undefined)(
  "an idle daemon switches to a staged version, and goes back to its own when the new one does not start",
  async () => {
    const installDir = join(root, "daemon", "bin");
    const data = join(root, "data");
    const socket = join(data, "daemon.sock");
    await mkdir(join(root, "daemon"), { recursive: true });
    await mkdir(data, { recursive: true });
    run(["cp", "-R", dirname(BIN as string), installDir]);
    const pidNow = async () =>
      Number((await readFile(join(data, "daemon.pid"), "utf8").catch(() => "")).trim()) ||
      undefined;

    Bun.spawn([join(installDir, "cycle"), "serve", "--data-dir", data, "--socket", socket], {
      env: { PATH: "/usr/bin:/bin", HOME: root },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).unref();
    const first = await until("the daemon to listen", 30_000, async () =>
      (await isListening(socket)) ? await pidNow() : undefined,
    );

    // The same program under a higher number, staged as the app or the channel would.
    run(["cp", "-R", installDir, `${installDir}.staged`]);
    await writeFile(`${installDir}.staged.json`, JSON.stringify({ version: "0.3.999998" }));
    const second = await until("the switch", 75_000, async () => {
      const pid = await pidNow();
      return pid !== undefined && pid !== first && (await isListening(socket)) ? pid : undefined;
    });
    expect(existsSync(`${installDir}.staged`)).toBe(false);
    expect(existsSync(join(`${installDir}.old`, "cycle"))).toBe(true);
    expect(existsSync(join(installDir, "cycle"))).toBe(true);

    // A version that does not start: thrown away, remembered, and the one before is running again.
    run(["cp", "-R", installDir, `${installDir}.staged`]);
    await writeFile(join(`${installDir}.staged`, "cycle"), "#!/bin/sh\nexit 1\n");
    await chmod(join(`${installDir}.staged`, "cycle"), 0o755);
    await writeFile(`${installDir}.staged.json`, JSON.stringify({ version: "0.3.999999" }));
    const third = await until("the way back", 75_000, async () => {
      const pid = await pidNow();
      return pid !== undefined && pid !== second && (await isListening(socket)) ? pid : undefined;
    });
    expect(third).not.toBe(second);
    const bad = JSON.parse(await readFile(join(data, "daemon-update.json"), "utf8")) as {
      bad: string[];
    };
    expect(bad.bad).toContain("0.3.999999");
    // The program in place is the daemon, not the one that would not start.
    expect((await readFile(join(installDir, "cycle"))).byteLength).toBeGreaterThan(1_000_000);
    expect(existsSync(`${installDir}.staged`)).toBe(false);
  },
  200_000,
);
