// Daemon + agy adapter against a real model, signed in the way `cycle login agy` leaves it:
// a login in `<data dir>/agy`, and the daemon restarted in the middle. Never reads host `~/.gemini`.
//
// Usage:
//   CYCLE_AGY_REAL_HOME=/tmp/agy-probe-home bun run --cwd apps/daemon test:real:agy
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods, type SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { applyUpdate, emptyConversation } from "../../../../packages/ui/src/model/index.ts";
import { agyHarness, findAgyExecutable, isAgyVersionSupported } from "../../src/agy-agent.ts";
import { ConfigSchema } from "../../src/config.ts";
import { Daemon } from "../../src/index.ts";
import { connectClient, until } from "../client.ts";

const sourceHome = process.env.CYCLE_AGY_REAL_HOME;
const agyPath = findAgyExecutable(ConfigSchema.parse({}).agy, process.env);
const enabled =
  sourceHome !== undefined &&
  sourceHome !== "" &&
  existsSync(join(sourceHome, ".gemini", "antigravity-cli", "antigravity-oauth-token")) &&
  agyPath !== undefined &&
  isAgyVersionSupported(agyPath, process.env);
const main = new URL("../../src/main.ts", import.meta.url).pathname;

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cycle-v1-real-agy-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

const agyDef = (dataDir: string) =>
  agyHarness.definition({
    config: ConfigSchema.parse({ agy: { executable: agyPath, telemetry: false } }),
    dataDir,
    inherited: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmpdir() },
    self: [process.execPath, main],
  });

const say = (text: string) => [{ type: "text" as const, text }];
const ended = (seen: { update: SessionUpdate }[]) =>
  seen.filter((s) => (s.update as { stopReason?: string }).stopReason !== undefined).length;
const textOf = (seen: { update: SessionUpdate }[]) =>
  seen
    .map((s) => s.update as unknown as { sessionUpdate: string; content?: { text?: string } })
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content?.text ?? "")
    .join("");

test.skipIf(!enabled)(
  "signed in via isolated agy HOME: turn 1, daemon restart, history from disk, turn 2 remembers codeword",
  async () => {
    const dataDir = join(root, "data");
    const cwd = join(root, "work");
    await Bun.write(join(cwd, ".keep"), "");
    const srcCli = join(sourceHome as string, ".gemini", "antigravity-cli");
    const dstCli = join(dataDir, "agy", ".gemini", "antigravity-cli");
    mkdirSync(dstCli, { recursive: true, mode: 0o700 });
    cpSync(join(srcCli, "antigravity-oauth-token"), join(dstCli, "antigravity-oauth-token"));
    const cacheSrc = join(srcCli, "cache", "acp-auth-state.json");
    if (existsSync(cacheSrc)) {
      mkdirSync(join(dstCli, "cache"), { recursive: true, mode: 0o700 });
      cpSync(cacheSrc, join(dstCli, "cache", "acp-auth-state.json"));
    }

    const open: Daemon[] = [];
    try {
      const first = await Daemon.start({ dataDir, agents: [agyDef(dataDir)] });
      open.push(first);
      const c1 = await connectClient(first, { onPermission: () => "allow" });
      const { sessionId } = await c1.agent.request(methods.agent.session.new, {
        cwd,
        _meta: { "cycle/agent": "agy", "cycle/config": { mode: "default", effort: "low" } },
      } as never);
      await c1.agent.request(methods.agent.session.resume, { sessionId, cwd });
      await c1.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: say("Remember the codeword QUASAR-99. Reply only with STORED."),
      });
      await until(() => ended(c1.seen) >= 1, "turn 1 idle", 90_000);
      expect(textOf(c1.seen)).toContain("STORED");

      await first.close();
      open.length = 0;

      const second = await Daemon.start({ dataDir, agents: [agyDef(dataDir)] });
      open.push(second);
      const c2 = await connectClient(second, { onPermission: () => "allow" });
      await c2.agent.request(methods.agent.session.resume, {
        sessionId,
        cwd,
        replayFrom: { type: "start" },
      });
      const history = c2.seen
        .map((s) => s.update)
        .reduce((acc, u) => applyUpdate(acc, u), emptyConversation());
      expect(history.ignored).toBe(0);
      expect(history.turns).toBe(1);

      const beforeTurn2 = c2.seen.length;
      await c2.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: say("What codeword did I ask you to remember? Reply with just the codeword."),
      });
      await until(() => ended(c2.seen.slice(beforeTurn2)) >= 1, "turn 2 idle", 90_000);
      expect(textOf(c2.seen.slice(beforeTurn2))).toContain("QUASAR-99");
    } finally {
      for (const d of open) await d.close();
    }
  },
  180_000,
);
