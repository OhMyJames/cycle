import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agy-auth-pipe-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("non-TTY pipe captures agy Google OAuth URL, delivers one-time code on stdin, and suppresses host browser", async () => {
  const fakeAgy = join(dir, "fake-agy-login");
  writeFileSync(
    fakeAgy,
    `#!/usr/bin/env bun
if (process.env.BROWSER !== "/usr/bin/true" && process.env.BROWSER !== "/bin/true") {
  process.stderr.write("BROWSER not suppressed\\n");
  process.exit(2);
}
process.stdout.write("Open this link in a browser to log in with Google:\\n\\n");
process.stdout.write("  https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=abc\\n\\n");
process.stdout.write("Then paste the authorization code, or the full URL of the page you land on, and press Enter:\\n");
const dec = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  if (buf.includes("\\n")) {
    process.exit(buf.trim() === "AGY-ONE-TIME-CODE" ? 0 : 1);
  }
}
`,
    { mode: 0o755 },
  );

  const proc = Bun.spawn([fakeAgy, "acp", "--login"], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
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
  while (!output.includes("paste the authorization code") && Date.now() < deadline) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += dec.decode(chunk.value, { stream: true });
  }

  const urlMatch = output.match(/https:\/\/accounts\.google\.com\/[^\s"'<>]+/);
  expect(urlMatch?.[0]).toContain("https://accounts.google.com/o/oauth2/auth");

  const stdin = proc.stdin as Bun.FileSink;
  stdin.write("AGY-ONE-TIME-CODE\n");
  stdin.flush();
  expect(await proc.exited).toBe(0);
});

test("hard red line: harness/agy and daemon agy setup never read, parse, or touch agy OAuth token files", () => {
  const repoRoot = join(import.meta.dir, "../../..");
  const srcFiles: string[] = [];
  const collect = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (entry.name.endsWith(".ts")) srcFiles.push(full);
    }
  };
  collect(join(repoRoot, "harness/agy/src"));
  srcFiles.push(join(repoRoot, "apps/daemon/src/agent-setup.ts"));
  srcFiles.push(join(repoRoot, "apps/daemon/src/agy-agent.ts"));

  const forbiddenTokenFilePatterns = [
    /oauth_creds\.json/i,
    /google_accounts\.json/i,
    /application_default_credentials\.json/i,
    /\.gemini\/oauth/i,
    /\.antigravity.*token/i,
  ];

  for (const file of srcFiles) {
    const content = readFileSync(file, "utf8");
    for (const pattern of forbiddenTokenFilePatterns) {
      expect(content).not.toMatch(pattern);
    }
  }
});
