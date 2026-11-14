/**
 * Runs Cycle against a scripted stand-in for the model, in a throwaway
 * project, so the whole app can be tried (and driven by tests) with no
 * account and no network. Everything but the models and the sandbox is
 * real: codex app-server and Claude Code, their tools, the daemon and the page.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeHarness } from "@cycle/harness-claude";
import { CodexHarness } from "@cycle/harness-codex";
import {
  Harnesses,
  TOOLS_KEY_ENV,
  TOOLS_SERVER,
  diskFile,
  openProviders,
  startDaemon,
  startTools,
} from "../../src/index.ts";
import { installFakeSbx, openSandboxes } from "./fake-sbx.ts";
import { type ClaudeReply, startMockClaude } from "./mock-claude.ts";
import { type MockReply, startMockModel } from "./mock-model.ts";

const ANSWER = `Here is what I found and changed.

## Summary

The project had no greeting, so I added one in \`src/greet.ts:1\` and noted it in the README.

- **Read** the README and listed the files
- **Wrote** a small module with one exported function
- Left the tests alone: there are none yet

\`\`\`ts
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

| File | Change |
| --- | --- |
| \`src/greet.ts\` | new |
| \`README.md\` | one line added |

> Run \`bun test\` once there is something to test.
`;

const STEPS: MockReply[] = [
  { call: { name: "exec_command", arguments: { cmd: "ls -la" } } },
  { call: { name: "exec_command", arguments: { cmd: "cat README.md" } } },
  {
    call: {
      name: "exec_command",
      arguments: {
        cmd: "mkdir -p src && printf 'export function greet(name: string): string {\\n  return `Hello, ${name}!`;\\n}\\n' > src/greet.ts && printf '\\nSee src/greet.ts for the greeting.\\n' >> README.md",
      },
    },
  },
];

interface InputItem {
  type?: string;
  role?: string;
  content?: string | { text?: string }[];
}

/** The latest prompt, and how many tool results have come back since it. */
function progress(body: unknown): { prompt: string; outputs: number } {
  const input = (body as { input?: InputItem[] }).input ?? [];
  let prompt = "";
  let outputs = 0;
  for (const item of input) {
    // Codex marks a message as one; a request that came through a provider's client may not.
    if ((item.type ?? "message") === "message" && item.role === "user") {
      const text =
        typeof item.content === "string"
          ? item.content
          : (item.content?.map((part) => part.text ?? "").join("") ?? "");
      if (text.startsWith("<")) continue;
      prompt = text;
      outputs = 0;
    } else if (item.type === "function_call_output") outputs++;
  }
  return { prompt, outputs };
}

function chunks(text: string, size = 12): string[] {
  return text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")) ?? [];
}

/** A very long reply, to see how the page holds up: about 150 KB of mixed markdown. */
const STRESS = Array.from(
  { length: 120 },
  (_, index) =>
    `## Section ${index + 1}\n\n${"A paragraph of ordinary prose with `inline code`, **bold** and a [link](https://example.com). ".repeat(6)}\n\n- first point\n- second point with \`src/file${index}.ts:${index + 1}\`\n\n\`\`\`ts\n${`export const value${index} = compute(${index}, "text", { deep: [1, 2, 3] });\n`.repeat(8)}\`\`\`\n`,
).join("\n");

const root = process.env["CYCLE_DEMO_DIR"] ?? mkdtempSync(join(tmpdir(), "cycle-demo-"));
const project = join(root, "demo-project");
mkdirSync(join(root, "codex"), { recursive: true });
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "README.md"), "# Demo project\n\nA place to try Cycle.\n");
const git = (...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.name=demo", "-c", "user.email=demo@example.com", ...args], {
    cwd: project,
  });
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-q", "-m", "Start");

const model = startMockModel((_index, body) => {
  const { prompt, outputs } = progress(body);
  if (/approv|permission/i.test(prompt) && outputs === 0) {
    return {
      call: {
        name: "exec_command",
        arguments: {
          cmd: "date > stamp.txt",
          sandbox_permissions: "require_escalated",
          justification: "Writing stamp.txt needs your approval in this mode.",
        },
      },
    };
  }
  if (/stress/i.test(prompt)) return { text: chunks(STRESS, 48) };
  if (/change|add|fix|build|write/i.test(prompt)) {
    const step = STEPS[outputs];
    if (step) return step;
    return { text: chunks(ANSWER), delayMs: Number(process.env["CYCLE_DEMO_DELAY"] ?? 25) };
  }
  return {
    text: chunks(
      `You said: **${prompt.trim()}**. Ask me to *change* something to see tools at work.`,
    ),
    delayMs: 20,
  };
});

/** The same work as `STEPS`, with Claude Code's own tools. */
const CLAUDE_STEPS: ClaudeReply[] = [
  { call: { name: "Bash", input: { command: "ls -la", description: "List the files" } } },
  { call: { name: "Read", input: { file_path: join(project, "README.md") } } },
  {
    call: {
      name: "Write",
      input: {
        file_path: join(project, "src", "greet.ts"),
        content: "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n",
      },
    },
  },
];

const claudeModel = startMockClaude(root, (prompt, results) => {
  if (/approv|permission/i.test(prompt) && results === 0) {
    const command = "python3 -c \"open('stamp.txt', 'w').write('now')\"";
    return { call: { name: "Bash", input: { command, description: "Write stamp.txt" } } };
  }
  if (/stress/i.test(prompt)) return { text: chunks(STRESS, 48) };
  if (/change|add|fix|build|write/i.test(prompt)) {
    const step = CLAUDE_STEPS[results];
    if (step) return step;
    return { text: chunks(ANSWER), delayMs: Number(process.env["CYCLE_DEMO_DELAY"] ?? 25) };
  }
  return {
    text: chunks(
      `You said: **${prompt.trim()}**. Ask me to *change* something to see tools at work.`,
    ),
    delayMs: 20,
  };
});

const providers = await openProviders(
  diskFile(join(root, "home", "providers.json")),
  crypto.randomUUID(),
  join(root, "home", "provider-models.json"),
);
const tools = startTools("demo-tools-key");
const harness = new CodexHarness({
  tools: { name: TOOLS_SERVER, url: tools.url, keyEnv: TOOLS_KEY_ENV, key: tools.key },
  config: model.codexConfig,
  env: { CODEX_HOME: join(root, "codex") },
  provider: providers.provider,
});
// A stand-in for Docker's `sbx`, so a session can be asked into a sandbox here too.
const sbx = installFakeSbx(root);
const sandboxes = await openSandboxes(root, { ...process.env, ...claudeModel.env, ...sbx.env });
const claude = new ClaudeHarness({
  env: claudeModel.env,
  sandboxes: sandboxes.admin,
  tools: { name: TOOLS_SERVER, url: tools.url, key: tools.key },
});
const daemon = await startDaemon({
  tools,
  harness: new Harnesses(harness, [claude], (line) => console.error(line)),
  providers: providers.store,
  sandboxes,
  home: join(root, "home"),
  port: Number(process.env["CYCLE_DAEMON_PORT"] ?? 0),
  uiDir: new URL("../../../desktop/dist/renderer", import.meta.url).pathname,
});
// Something for the Connector to show: a server that answers with one tool.
await harness.putMcpServer({
  name: "demo",
  transport: {
    kind: "stdio",
    command: process.execPath,
    args: [join(import.meta.dir, "mcp-server.ts")],
    env: { DEMO_SUFFIX: "" },
  },
});
// The scripted model speaks the Responses API, so its address also works as a custom provider's.
console.log(
  JSON.stringify({ type: "listening", pageUrl: daemon.pageUrl, project, modelUrl: model.url }),
);
console.error(`\nCycle demo is at ${daemon.pageUrl}\nProject: ${project}\n`);

const stop = async () => {
  await daemon.stop();
  providers.stop();
  tools.stop();
  model.stop();
  claudeModel.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
