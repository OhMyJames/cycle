// The daemon's own agy sign-in driver (apps/daemon/src/agent-setup.ts) against a fake `agy acp --login` that prints what
// the real one prints in a non-TTY pipe, and the red line that Cycle never touches agy's token files.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGY_AUTH_URL_RE,
  extractAuthUrl,
  startCliCodeAuth,
} from "../../../apps/daemon/src/agent-setup.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agy-auth-pipe-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const AUTHORIZE =
  "https://accounts.google.com/o/oauth2/auth?response_type=code&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=abc";

test("the production URL pattern finds only Google's authorize URL", () => {
  expect(extractAuthUrl(`  ${AUTHORIZE}\n\n`, AGY_AUTH_URL_RE)).toBe(AUTHORIZE);
  expect(
    extractAuthUrl("https://accounts.google.com.evil.example/x\n", AGY_AUTH_URL_RE),
  ).toBeUndefined();
});

test("startCliCodeAuth drives agy acp --login: host browser suppressed, URL captured, code delivered on stdin", async () => {
  const seen = join(dir, "argv.json");
  const fakeAgy = join(dir, "fake-agy-login");
  writeFileSync(
    fakeAgy,
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
if (process.env.BROWSER !== "/usr/bin/true" && process.env.BROWSER !== "/bin/true") {
  process.stderr.write("BROWSER not suppressed\\n");
  process.exit(2);
}
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), home: process.env.HOME }));
process.stdout.write("Open this link in a browser to log in with Google:\\n\\n");
process.stdout.write("  ${AUTHORIZE}\\n\\n");
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

  const flow = await startCliCodeAuth({
    command: [fakeAgy, "acp", "--login", "--disable-telemetry"],
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir },
    urlPattern: AGY_AUTH_URL_RE,
    startTimeoutMs: 5_000,
    submitTimeoutMs: 5_000,
  });
  expect(flow.authorizationUrl).toBe(AUTHORIZE);
  expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual({
    argv: ["acp", "--login", "--disable-telemetry"],
    home: dir,
  });
  expect(await flow.submit?.("AGY-ONE-TIME-CODE")).toEqual({ ok: true });
  expect(await flow.completed).toEqual({ ok: true });
}, 10_000);

test("hard red line: harness/agy and the daemon never name agy's OAuth token files outside tests", () => {
  const repoRoot = join(import.meta.dir, "../../..");
  const srcFiles: string[] = [];
  const collect = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (entry.name.endsWith(".ts")) srcFiles.push(full);
    }
  };
  // Every source file that could reach them: the adapter, and all of the daemon (setup, auth, the agy agent, ...).
  collect(join(repoRoot, "harness/agy/src"));
  collect(join(repoRoot, "apps/daemon/src"));
  expect(srcFiles).toContain(join(repoRoot, "apps/daemon/src/agent-setup.ts"));
  expect(srcFiles).toContain(join(repoRoot, "apps/daemon/src/agy-agent.ts"));

  const forbiddenTokenFilePatterns = [
    /oauth_creds\.json/i,
    /google_accounts\.json/i,
    /application_default_credentials\.json/i,
    /\.gemini\/oauth/i,
    /antigravity-oauth-token/i,
    /acp-auth-state\.json/i,
    /\.antigravity.*token/i,
  ];

  for (const file of srcFiles) {
    const content = readFileSync(file, "utf8");
    for (const pattern of forbiddenTokenFilePatterns) {
      expect({ file, matches: pattern.test(content) }).toEqual({ file, matches: false });
    }
  }
});
