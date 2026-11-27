// The built executable, on its own, against a real model: what a user gets from `bun run build`.
// Not part of `bun run test:integration` (it spends a little of an account's quota). Run it with:
//
//   bun run build   (in apps/daemon)
//   CYCLE_REAL_MODEL_TOKEN=<oauth token> bun test ./test/integration/real-binary.integration.ts
//
// The process that runs the executable has a bare environment: no bun, no node, no token. The token
// is written to the daemon's config.json in a temporary directory, which is where a user puts it,
// and from there only the Claude process gets it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CycleClient, commandChannel } from "@cycle/client";
import { ensureHomeKeychain } from "../../src/home-keychain.ts";

const token = process.env.CYCLE_REAL_MODEL_TOKEN;
const model = process.env.CYCLE_REAL_MODEL ?? "haiku";
const bin = new URL(`../../dist/cycle-${process.platform}-${process.arch}/cycle`, import.meta.url)
  .pathname;
const enabled = token !== undefined && token !== "" && existsSync(bin);

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cv1-bin-"));
  // The agents get this as HOME and keep keys with `security`: without a keychain, a window on the screen.
  ensureHomeKeychain(root);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const bare = () => ({ PATH: "/usr/bin:/bin", HOME: root });

test.skipIf(!enabled)(
  "the executable alone: ssh-style proxy, a real turn with a permission, status and stop",
  async () => {
    const dataDir = join(root, "data");
    const socket = join(root, "d.sock");
    const cwd = join(root, "work");
    await Bun.write(join(cwd, ".keep"), "");
    await Bun.write(
      join(dataDir, "config.json"),
      JSON.stringify({ claude: { env: { CLAUDE_CODE_OAUTH_TOKEN: token as string } } }),
    );
    const run = async (...args: string[]) => {
      const p = Bun.spawn([bin, ...args, "--data-dir", dataDir, "--socket", socket], {
        env: bare(),
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: await p.exited, out: await new Response(p.stdout).text() };
    };
    expect((await run("status")).code).toBe(1);

    const updates: { sessionUpdate: string; stopReason?: string; content?: { text?: string } }[] =
      [];
    let asked = 0;
    const client = new CycleClient({
      connect: async () =>
        commandChannel({
          command: [bin, "proxy", "--data-dir", dataDir, "--socket", socket],
          env: bare(),
        }),
      events: {
        update: (_id, update) => updates.push(update as never),
        permission: async (_id, request) => {
          asked++;
          const options = (request.options ?? []) as { optionId: string; kind: string }[];
          const allow = options.find((o) => o.kind.startsWith("allow"));
          return allow
            ? { outcome: "selected", optionId: allow.optionId }
            : { outcome: "cancelled" };
        },
      },
    });
    let stopped = "";
    try {
      await client.start();
      expect((await run("status")).code).toBe(0);
      // The mode that asks first: new sessions start in auto, where nothing may be asked.
      const sessionId = await client.newSession({ cwd, config: { model, mode: "default" } });
      await client.watch(sessionId, cwd);
      await client.prompt(sessionId, [
        {
          type: "text",
          text: "Use the Bash tool to run exactly: touch made-by-the-binary.txt  Then say finished.",
        },
      ]);
      const started = Date.now();
      while (!updates.some((u) => u.stopReason !== undefined)) {
        if (Date.now() - started > 90_000) throw new Error("the turn did not end");
        await Bun.sleep(50);
      }
      expect(asked).toBeGreaterThan(0);
      expect(existsSync(join(cwd, "made-by-the-binary.txt"))).toBe(true);
    } finally {
      await client.close();
      // Whatever happened above, no daemon is left running.
      stopped = (await run("stop")).out;
    }
    expect(stopped).toContain("stopped");
    expect((await run("status")).code).toBe(1);
  },
  150_000,
);
