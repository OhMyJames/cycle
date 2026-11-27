import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  client,
  methods,
  ndJsonStream,
  type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2";
import { ensureHomeKeychain } from "../../../../apps/daemon/src/home-keychain.ts";

const entry = new URL("../../src/main.ts", import.meta.url).pathname;

/** What a test sees of one adapter process. */
export type Run = {
  agent: Parameters<Parameters<ReturnType<typeof client>["connectWith"]>[1]>[0];
  updates: SessionUpdate[];
  permissions: unknown[];
  elicitations: unknown[];
  idle: () => Promise<SessionUpdate>;
};

export type Options = {
  mockUrl?: string;
  /** The Claude process's whole environment, instead of the mock's. For a real model: explicit, never inherited. */
  env?: Record<string, string>;
  configDir: string;
  /** More of the adapter's own configuration (`warmStart`, `idleMs`), beside the Claude process's environment. */
  adapter?: Record<string, unknown>;
  /** How to answer a permission request. */
  onPermission?: (request: unknown) => "allow" | "deny" | "cancel";
  /** Says this client can answer forms, and how it does. Without it the daemon-side rule applies: none can. */
  onElicitation?: (request: unknown) => Record<string, unknown>;
};

/**
 * Starts the adapter as its own process, as the daemon will, with an explicit environment and
 * nothing inherited, and speaks ACP v2 to it over stdio. Resolves when `body` is done.
 */
export const withAdapter = async <T>(
  options: Options,
  body: (run: Run) => Promise<T>,
): Promise<T> => {
  const config = {
    ...options.adapter,
    env: options.env ?? {
      PATH: process.env.PATH ?? "",
      HOME: options.configDir,
      CLAUDE_CONFIG_DIR: options.configDir,
      ANTHROPIC_BASE_URL: options.mockUrl ?? "",
      ANTHROPIC_API_KEY: "mock-key-not-real",
    },
  };
  const proc = Bun.spawn(["bun", entry], {
    env: { PATH: process.env.PATH ?? "", CYCLE_ADAPTER_CONFIG: JSON.stringify(config) },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  const input = new WritableStream<Uint8Array>({
    write: (chunk) => {
      proc.stdin.write(chunk);
      proc.stdin.flush();
    },
    close: () => {
      proc.stdin.end();
    },
  });
  const updates: SessionUpdate[] = [];
  const permissions: unknown[] = [];
  const elicitations: unknown[] = [];
  const waiting: ((u: SessionUpdate) => void)[] = [];
  const app = client()
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update);
      const update = params.update as { sessionUpdate: string; state?: string };
      if (update.sessionUpdate === "state_update" && update.state === "idle") {
        for (const resolve of waiting.splice(0)) resolve(params.update);
      }
    })
    .onRequest(methods.client.elicitation.create, ({ params }) => {
      elicitations.push(params);
      return (options.onElicitation?.(params) ?? {
        action: "cancel",
        _meta: { "cycle/noClient": true },
      }) as never;
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      permissions.push(params);
      const answer = options.onPermission?.(params) ?? "allow";
      return answer === "cancel"
        ? { outcome: { outcome: "cancelled" } }
        : { outcome: { outcome: "selected", optionId: answer } };
    });
  try {
    return await app.connectWith(ndJsonStream(input, proc.stdout), async (agent) => {
      await agent.request(methods.agent.initialize, {
        protocolVersion: 2,
        info: { name: "integration-test", version: "0" },
        ...(options.onElicitation !== undefined
          ? { capabilities: { elicitation: { form: {} } } }
          : {}),
      } as never);
      return body({
        agent,
        updates,
        permissions,
        elicitations,
        idle: () => new Promise((resolve) => waiting.push(resolve)),
      });
    });
  } finally {
    proc.kill();
  }
};

export const tempConfigDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-v1-claude-config-"));
  // It is Claude's HOME too (withAdapter): without a keychain there, macOS opens "Keychain Not Found" on the screen.
  ensureHomeKeychain(dir);
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
};
