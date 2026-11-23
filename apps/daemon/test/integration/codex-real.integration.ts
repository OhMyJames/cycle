// Opt in with an isolated copy of a Codex login. The original session store is never opened.
import { expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { META } from "@cycle/protocol";
import { ConfigSchema } from "../../src/config.ts";
import { agentsFor } from "../../src/harnesses.ts";
import { Daemon } from "../../src/index.ts";
import { connectClient, until } from "../client.ts";

const login = process.env.CYCLE_REAL_CODEX_AUTH_FILE;
test.skipIf(!login || process.env.CI === "true")(
  "real Codex remembers a random word across a daemon restart",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cycle-codex-real-"));
    const dataDir = join(root, "data"),
      home = join(dataDir, "codex"),
      cwd = join(root, "work");
    let daemon: Daemon | undefined;
    try {
      await mkdir(home, { recursive: true, mode: 0o700 });
      await mkdir(cwd);
      await copyFile(login as string, join(home, "auth.json"));
      await chmod(join(home, "auth.json"), 0o600);
      const start = () =>
        Daemon.start({
          dataDir,
          agents: agentsFor(ConfigSchema.parse({}), dataDir, { PATH: "/usr/bin:/bin" }),
        });
      daemon = await start();
      let c = await connectClient(daemon, { onPermission: () => "deny" });
      const { sessionId } = await c.agent.request(methods.agent.session.new, {
        cwd,
        _meta: { [META.agent]: "codex", [META.config]: { mode: "read-only" } },
      });
      const word = crypto.randomUUID().slice(0, 12);
      async function ask(text: string) {
        const start = c.seen.length;
        await c.agent.request(methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text }],
        });
        const updates = () => c.seen.slice(start).map((s) => s.update);
        await until(
          () => updates().some((u) => "stopReason" in u && !!u.stopReason),
          "real Codex reply",
          75_000,
        );
        expect(updates().find((u) => "stopReason" in u && !!u.stopReason)).toMatchObject({
          stopReason: "end_turn",
        });
        return updates()
          .filter((u) => u.sessionUpdate === "agent_message_chunk")
          .map((u) => (u as { content: { text: string } }).content.text)
          .join("");
      }
      await c.agent.request(methods.agent.session.resume, { sessionId, cwd });
      await ask(`Remember the exact string ${word}. Reply only OK. Do not use tools.`);
      await daemon.close();
      daemon = await start();
      c = await connectClient(daemon, { onPermission: () => "deny" });
      await c.agent.request(methods.agent.session.resume, {
        sessionId,
        cwd,
        replayFrom: { type: "start" },
      });
      expect(
        await ask("Return only the exact string I asked you to remember. Do not use tools."),
      ).toContain(word);
    } finally {
      try {
        await daemon?.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  170_000,
);
