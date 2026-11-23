// Opt-in real Codex regression for CYCL-205/206. It uses a copied auth file and a temporary CODEX_HOME.
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
  "real Codex subagent, compaction and usage updates",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cycle-codex-capabilities-"));
    const dataDir = join(root, "data"),
      home = join(dataDir, "codex"),
      cwd = join(root, "work");
    let daemon: Daemon | undefined;
    try {
      await mkdir(home, { recursive: true, mode: 0o700 });
      await mkdir(cwd);
      await copyFile(login as string, join(home, "auth.json"));
      await chmod(join(home, "auth.json"), 0o600);
      daemon = await Daemon.start({
        dataDir,
        agents: agentsFor(ConfigSchema.parse({}), dataDir, { PATH: "/usr/bin:/bin" }),
      });
      const client = await connectClient(daemon, { onPermission: () => "deny" });
      const { sessionId } = await client.agent.request(methods.agent.session.new, {
        cwd,
        _meta: { [META.agent]: "codex", [META.config]: { mode: "read-only" } },
      });
      await client.agent.request(methods.agent.session.resume, { sessionId, cwd });
      await client.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [
          {
            type: "text",
            text: "You must use the Codex collaboration tool spawn_agent to start exactly one subagent. Ask it to answer with the single word READY, then report that result.",
          },
        ],
      });
      await until(
        () =>
          client.seen.some(
            ({ update }) => "stopReason" in update && update.stopReason !== undefined,
          ),
        "the real subagent turn",
        120_000,
      );
      const subagents = client.seen.filter(
        ({ update }) => update.sessionUpdate === "subagent_update",
      );
      console.log(
        "real Codex update kinds:",
        [...new Set(client.seen.map(({ update }) => update.sessionUpdate))].sort().join(","),
      );
      console.log("real Codex subagent observed:", subagents.length > 0);

      const beforeCompaction = client.seen.length;
      await client.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: "text", text: "/compact" }],
      });
      await until(
        () =>
          client.seen
            .slice(beforeCompaction)
            .some(
              ({ update }) =>
                update.sessionUpdate === "compaction_update" &&
                "status" in update &&
                update.status === "completed",
            ),
        "real Codex compaction",
        60_000,
      );

      await client.agent.request(methods.agent.session.prompt, {
        sessionId,
        prompt: [
          { type: "text", text: "Say a short confirmation that the context is still available." },
        ],
      });
      await until(
        () => client.seen.some(({ update }) => update.sessionUpdate === "usage_update"),
        "real Codex usage update",
        60_000,
      );
      expect(client.seen.some(({ update }) => update.sessionUpdate === "usage_update")).toBe(true);
    } finally {
      try {
        await daemon?.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  260_000,
);
