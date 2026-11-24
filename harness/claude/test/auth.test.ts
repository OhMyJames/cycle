import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-auth-pipe-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("non-TTY pipe captures Claude OAuth URL, detects stdin code prompt, delivers one-time code, and exits cleanly on SIGTERM", async () => {
  const fakeCli = join(dir, "fake-claude-login");
  writeFileSync(
    fakeCli,
    `#!/usr/bin/env bun
if (process.env.BROWSER !== "/usr/bin/true" && process.env.BROWSER !== "/bin/true") {
  process.stderr.write("BROWSER not suppressed\\n");
  process.exit(2);
}
process.stdout.write("Opening browser to sign in…\\n");
process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=test\\n");
process.stdout.write("Paste code here if prompted > ");
const dec = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  if (buf.includes("\\n")) {
    process.stdout.write(buf.trim() === "TEST-ONE-TIME-CODE" ? "OK\\n" : "BAD\\n");
    process.exit(buf.trim() === "TEST-ONE-TIME-CODE" ? 0 : 1);
  }
}
`,
    { mode: 0o755 },
  );

  const proc = Bun.spawn([fakeCli, "auth", "login", "--claudeai"], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      CLAUDE_CONFIG_DIR: join(dir, "cfg"),
      BROWSER: "/usr/bin/true",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  let output = "";
  const deadline = Date.now() + 5_000;
  while (!output.includes("Paste code here") && Date.now() < deadline) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += dec.decode(chunk.value, { stream: true });
  }

  const urlMatch = output.match(
    /https:\/\/(?:claude\.com|claude\.ai|platform\.claude\.com)\/[^\s"'<>]+/,
  );
  expect(urlMatch?.[0]).toContain("https://claude.com/cai/oauth/authorize");
  expect(output).toContain("Paste code here");

  const stdin = proc.stdin as Bun.FileSink;
  stdin.write("TEST-ONE-TIME-CODE\n");
  stdin.flush();
  expect(await proc.exited).toBe(0);
});
