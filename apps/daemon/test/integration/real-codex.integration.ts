// The daemon and the Codex adapter against a real model, signed in the way `cycle login codex` leaves it: a login in
// `<data dir>/codex`, and the daemon restarted in the middle. Not part of `bun run test:integration`: it spends a
// little of an account's quota. Run it with the login given on purpose:
//
//   CYCLE_CODEX_AUTH=<path to a Codex auth.json> bun run test:real:codex   (in apps/daemon)
//
// The file is copied into the temporary data directory, where only the Codex process reads it; the one given is never
// written. See harness/codex/test/integration/real-model.integration.ts on sharing a ChatGPT login.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods, type SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { applyUpdate, emptyConversation } from "../../../../packages/ui/src/model/index.ts";
import { codexHarness } from "../../src/codex-agent.ts";
import { ConfigSchema } from "../../src/config.ts";
import { Daemon } from "../../src/index.ts";
import { connectClient, until } from "../client.ts";

const auth = process.env.CYCLE_CODEX_AUTH;
const enabled = auth !== undefined && auth !== "" && existsSync(auth);
const main = new URL("../../src/main.ts", import.meta.url).pathname;

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cycle-v1-real-codex-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

/** Codex as the daemon defines it, with this checkout's `cycle` as the adapter's command. */
const codex = (dataDir: string) =>
  codexHarness.definition({
    config: ConfigSchema.parse({}),
    dataDir,
    inherited: { PATH: "/usr/bin:/bin" },
    self: [process.execPath, main],
  });
const say = (text: string) => [{ type: "text" as const, text }];
const ended = (seen: { update: SessionUpdate }[]) =>
  seen.filter((s) => (s.update as { stopReason?: string }).stopReason !== undefined).length;
const text = (seen: { update: SessionUpdate }[]) =>
  seen
    .map((s) => s.update as unknown as { sessionUpdate: string; content?: { text?: string } })
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content?.text ?? "")
    .join("");

test.skipIf(!enabled)(
  "signed in as `cycle login codex` leaves it: a new session's turn, a restart of the daemon, history from disk, and the conversation goes on",
  async () => {
    const dataDir = join(root, "data");
    const cwd = join(root, "work");
    await Bun.write(join(cwd, ".keep"), "");
    // A fresh data directory is signed out, whatever the machine's own Codex has.
    const status = () =>
      Bun.spawnSync([process.execPath, main, "--data-dir", dataDir, "codex", "login", "status"], {
        env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "" },
      });
    const before = status();
    expect(before.exitCode).not.toBe(0);
    await mkdir(join(dataDir, "codex"), { recursive: true, mode: 0o700 });
    await copyFile(auth as string, join(dataDir, "codex", "auth.json"));
    const after = status();
    console.log("REAL codex login status:", `${after.stdout}${after.stderr}`.trim());
    expect(after.exitCode).toBe(0);

    const open: Daemon[] = [];
    try {
      const first = await Daemon.start({ dataDir, agents: [codex(dataDir)] });
      open.push(first);
      const c = await connectClient(first, { onPermission: () => "allow" });
      const { sessionId } = await c.agent.request(methods.agent.session.new, {
        cwd,
        _meta: { "cycle/agent": "codex", "cycle/config": { mode: "default", effort: "low" } },
      } as never);
      await c.agent.request(methods.agent.session.resume, { sessionId, cwd });
      await c.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: say(
          "Remember this code word: ZEPPELIN. Then run exactly this shell command: touch from-the-daemon.txt  and say finished.",
        ),
      });
      await until(() => ended(c.seen) >= 1, "the first turn", 120_000);
      console.log(
        "REAL codex daemon turn 1 kinds:",
        JSON.stringify(
          Object.fromEntries(
            [...new Set(c.kinds())].map((k) => [k, c.kinds().filter((x) => x === k).length]),
          ),
        ),
      );
      expect(existsSync(join(cwd, "from-the-daemon.txt"))).toBe(true);

      // The daemon goes away, and with it the adapter and Codex. Only the disk is left.
      await first.close();
      open.length = 0;
      const second = await Daemon.start({ dataDir, agents: [codex(dataDir)] });
      open.push(second);
      const d = await connectClient(second);
      await d.agent.request(methods.agent.session.resume, {
        sessionId,
        cwd,
        replayFrom: { type: "start" },
      });
      const conversation = d.seen
        .map((s) => s.update)
        .reduce((c, u) => applyUpdate(c, u), emptyConversation());
      console.log(
        "REAL codex history:",
        JSON.stringify({
          items: conversation.items.map((i) => i.kind),
          turns: conversation.turns,
          ignored: conversation.ignored,
        }),
      );
      expect(conversation.ignored).toBe(0);
      expect(conversation.turns).toBe(1);
      expect(conversation.items.map((i) => i.kind)).toContain("tool");

      const done = ended(d.seen);
      await d.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: say("What was the code word? Answer with the word only."),
      });
      await until(() => ended(d.seen) > done, "the turn after the restart", 120_000);
      console.log("REAL codex after restart:", JSON.stringify(text(d.seen).slice(-80)));
      expect(text(d.seen).toUpperCase()).toContain("ZEPPELIN");
    } finally {
      for (const daemon of open) await daemon.close();
    }
  },
  300_000,
);
