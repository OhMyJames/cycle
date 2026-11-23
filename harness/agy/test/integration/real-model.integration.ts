// Real-model verification for harness/agy against an explicitly supplied isolated agy HOME.
// Never reads host ~/.gemini and never runs in CI.
//
// Usage:
//   CYCLE_AGY_REAL_HOME=/tmp/agy-probe-home bun run --cwd harness/agy test:real
import { describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, type SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { META } from "@cycle/protocol";
import { findAgyExecutable, isAgyVersionSupported } from "../../../../apps/daemon/src/agy-agent.ts";
import { ConfigSchema } from "../../../../apps/daemon/src/config.ts";
import {
  applyUpdate,
  emptyConversation,
  sessionEdits,
} from "../../../../packages/ui/src/model/index.ts";
import { createAdapter } from "../../src/agent.ts";

const sourceHome = process.env.CYCLE_AGY_REAL_HOME;
const agyPath = findAgyExecutable(ConfigSchema.parse({}).agy, process.env);
const enabled =
  sourceHome !== undefined &&
  sourceHome !== "" &&
  existsSync(join(sourceHome, ".gemini", "antigravity-cli", "antigravity-oauth-token")) &&
  agyPath !== undefined &&
  isAgyVersionSupported(agyPath, process.env);

const copyAuthToTempHome = (destHome: string) => {
  const srcCli = join(sourceHome as string, ".gemini", "antigravity-cli");
  const dstCli = join(destHome, ".gemini", "antigravity-cli");
  mkdirSync(dstCli, { recursive: true, mode: 0o700 });
  cpSync(join(srcCli, "antigravity-oauth-token"), join(dstCli, "antigravity-oauth-token"));
  const cacheSrc = join(srcCli, "cache", "acp-auth-state.json");
  if (existsSync(cacheSrc)) {
    mkdirSync(join(dstCli, "cache"), { recursive: true, mode: 0o700 });
    cpSync(cacheSrc, join(dstCli, "cache", "acp-auth-state.json"));
  }
};

const waitIdle = async (
  updates: SessionUpdate[],
  since: number,
  timeoutMs = 90_000,
): Promise<SessionUpdate> => {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const found = updates
      .slice(since)
      .find((u) => u.sessionUpdate === "state_update" && u.state === "idle" && "stopReason" in u);
    if (found) return found;
    if (Date.now() > deadline) throw new Error("Timed out waiting for agy turn to become idle");
    await Bun.sleep(50);
  }
};

const replyText = (updates: SessionUpdate[], since: number) =>
  updates
    .slice(since)
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => (u as { content?: { text?: string } }).content?.text ?? "")
    .join("");

describe("harness/agy real-model integration (opt-in via CYCLE_AGY_REAL_HOME)", () => {
  test.skipIf(!enabled)(
    "edits a file, runs a command with approval, resumes after adapter restart, and feeds UI model with ignored === 0",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "cycle-agy-real-"));
      const agyHome = join(root, "home");
      const workDir = join(root, "work");
      mkdirSync(workDir, { recursive: true });
      writeFileSync(join(workDir, "hello.txt"), "hello world\n");
      copyAuthToTempHome(agyHome);

      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: agyHome, TMPDIR: tmpdir() };
      const updates: SessionUpdate[] = [];
      let agySessionId = "";

      // Phase 1: create session, set low effort, remember codeword + edit file + run command.
      const adapter1 = createAdapter({
        env,
        agyExecutable: agyPath as string,
        telemetry: false,
      });
      const app1 = client()
        .onNotification(methods.client.session.update, ({ params }) => {
          updates.push(params.update);
        })
        .onRequest(methods.client.session.requestPermission, () => {
          return { outcome: { outcome: "selected", optionId: "allow" } } as never;
        });

      try {
        await app1.connectWith(adapter1.app, async (agent) => {
          await agent.request(methods.agent.initialize, {
            protocolVersion: 2,
            capabilities: { elicitation: { form: {} } },
            info: { name: "agy-real-test", version: "1" },
          } as never);
          const created = (await agent.request(methods.agent.session.new, {
            cwd: workDir,
          } as never)) as { sessionId: string; configOptions: unknown[] };
          agySessionId = created.sessionId;
          expect(created.configOptions.length).toBeGreaterThanOrEqual(3);

          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: agySessionId,
            configId: "effort",
            type: "id",
            value: "low",
          } as never);

          const since = updates.length;
          await agent.request(methods.agent.session.prompt, {
            sessionId: agySessionId,
            prompt: [
              {
                type: "text",
                text: "Remember the secret codeword ALBATROSS-42. Edit hello.txt to add a second line 'done' using edit_file, then reply with OK.",
              },
            ],
          } as never);
          const idle = await waitIdle(updates, since);
          expect((idle as { stopReason?: string }).stopReason).toBe("end_turn");
          expect(readFileSync(join(workDir, "hello.txt"), "utf8")).toContain("done");
        });
      } finally {
        adapter1.close();
      }

      // Verify UI model accepts every real update with ignored === 0 and sees the edit diff.
      let conv = emptyConversation();
      for (const u of updates) conv = applyUpdate(conv, u);
      expect(conv.ignored).toBe(0);
      const edits = sessionEdits(conv);
      expect(edits.length).toBeGreaterThanOrEqual(1);

      // Phase 2: fresh adapter process resumes by agySessionId and recalls the codeword.
      const updates2: SessionUpdate[] = [];
      const adapter2 = createAdapter({
        env,
        agyExecutable: agyPath as string,
        telemetry: false,
      });
      const app2 = client()
        .onNotification(methods.client.session.update, ({ params }) => {
          updates2.push(params.update);
        })
        .onRequest(methods.client.session.requestPermission, () => {
          return { outcome: { outcome: "selected", optionId: "allow" } } as never;
        });

      try {
        await app2.connectWith(adapter2.app, async (agent) => {
          await agent.request(methods.agent.initialize, {
            protocolVersion: 2,
            capabilities: { elicitation: { form: {} } },
            info: { name: "agy-real-test", version: "1" },
          } as never);
          await agent.request(methods.agent.session.resume, {
            sessionId: agySessionId,
            cwd: workDir,
            _meta: { [META.hadTurn]: true },
          } as never);
          const since = updates2.length;
          await agent.request(methods.agent.session.prompt, {
            sessionId: agySessionId,
            prompt: [
              { type: "text", text: "What was the secret codeword? Reply with just the codeword." },
            ],
          } as never);
          await waitIdle(updates2, since);
          expect(replyText(updates2, since)).toContain("ALBATROSS-42");
        });
      } finally {
        adapter2.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
