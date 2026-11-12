/**
 * Runs Cycle against a scripted stand-in for the model, in a throwaway
 * project, so the whole app can be tried (and driven by tests) with no
 * account and no network. Everything but the model is real: codex
 * app-server, its tools, the daemon and the page.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexHarness } from "@cycle/harness-codex";
import { startDaemon } from "../../src/index.ts";
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
  content?: { text?: string }[];
}

/** The latest prompt, and how many tool results have come back since it. */
function progress(body: unknown): { prompt: string; outputs: number } {
  const input = (body as { input?: InputItem[] }).input ?? [];
  let prompt = "";
  let outputs = 0;
  for (const item of input) {
    if (item.type === "message" && item.role === "user") {
      const text = item.content?.map((part) => part.text ?? "").join("") ?? "";
      if (text.startsWith("<")) continue;
      prompt = text;
      outputs = 0;
    } else if (item.type === "function_call_output") outputs++;
  }
  return { prompt, outputs };
}

function chunks(text: string): string[] {
  return text.match(/[\s\S]{1,12}/g) ?? [];
}

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

const daemon = await startDaemon({
  harness: new CodexHarness({
    config: model.codexConfig,
    env: { CODEX_HOME: join(root, "codex") },
  }),
  home: join(root, "home"),
  port: Number(process.env["CYCLE_DAEMON_PORT"] ?? 0),
  uiDir: new URL("../../../desktop/dist/renderer", import.meta.url).pathname,
});
console.log(JSON.stringify({ type: "listening", pageUrl: daemon.pageUrl, project }));
console.error(`\nCycle demo is at ${daemon.pageUrl}\nProject: ${project}\n`);

const stop = async () => {
  await daemon.stop();
  model.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
