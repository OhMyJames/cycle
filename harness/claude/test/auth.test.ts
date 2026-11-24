// The daemon's own Claude sign-in driver (apps/daemon/src/agent-setup.ts) against a fake `claude auth login --claudeai`
// that prints what the real one prints in a non-TTY pipe: the URL the driver must find, the paste prompt, and the
// one-time code read from stdin.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_AUTH_URL_RE,
  extractAuthUrl,
  startCliCodeAuth,
} from "../../../apps/daemon/src/agent-setup.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "claude-auth-pipe-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const AUTHORIZE =
  "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=test";

const fakeClaude = (seen: string): string => {
  const path = join(dir, "fake-claude-login");
  writeFileSync(
    path,
    `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
if (process.env.BROWSER !== "/usr/bin/true" && process.env.BROWSER !== "/bin/true") {
  process.stderr.write("BROWSER not suppressed\\n");
  process.exit(2);
}
writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write("Opening browser to sign in…\\n");
// Streamed in two pieces: the driver must not take a half-printed URL.
process.stdout.write("If the browser didn't open, visit: ${AUTHORIZE.slice(0, 40)}");
await Bun.sleep(20);
process.stdout.write("${AUTHORIZE.slice(40)}\\n");
process.stdout.write("Paste code here if prompted > ");
const dec = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  if (buf.includes("\\n")) {
    const ok = buf.trim() === "TEST-ONE-TIME-CODE";
    process.stdout.write(ok ? "Login successful\\n" : "OAuth error: invalid_grant\\n");
    process.exit(ok ? 0 : 1);
  }
}
`,
    { mode: 0o755 },
  );
  return path;
};

const env = () => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: dir,
  CLAUDE_CONFIG_DIR: join(dir, "cfg"),
});

test("the production URL pattern finds Claude's authorize URL, ANSI-wrapped or not, and only once it is complete", () => {
  expect(extractAuthUrl(`visit: \x1b[4m${AUTHORIZE}\x1b[0m\n`, CLAUDE_AUTH_URL_RE)).toBe(AUTHORIZE);
  expect(extractAuthUrl(`visit: ${AUTHORIZE.slice(0, 40)}`, CLAUDE_AUTH_URL_RE)).toBeUndefined();
  expect(
    extractAuthUrl("visit: https://evil.example/claude.com/x\n", CLAUDE_AUTH_URL_RE),
  ).toBeUndefined();
});

test("startCliCodeAuth drives a non-TTY Claude login: host browser suppressed, URL captured, code delivered on stdin", async () => {
  const seen = join(dir, "argv.json");
  const flow = await startCliCodeAuth({
    command: [fakeClaude(seen), "auth", "login", "--claudeai"],
    env: env(),
    urlPattern: CLAUDE_AUTH_URL_RE,
    startTimeoutMs: 5_000,
    submitTimeoutMs: 5_000,
  });
  expect(flow.authorizationUrl).toBe(AUTHORIZE);
  expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual(["auth", "login", "--claudeai"]);
  expect(await flow.submit?.("TEST-ONE-TIME-CODE")).toEqual({ ok: true });
  expect(await flow.completed).toEqual({ ok: true });
}, 10_000);

test("startCliCodeAuth reports a rejected Claude code as invalid_code", async () => {
  const flow = await startCliCodeAuth({
    command: [fakeClaude(join(dir, "argv.json")), "auth", "login", "--claudeai"],
    env: env(),
    urlPattern: CLAUDE_AUTH_URL_RE,
    startTimeoutMs: 5_000,
    submitTimeoutMs: 5_000,
  });
  expect(await flow.submit?.("WRONG")).toEqual({ ok: false, reason: "invalid_code" });
}, 10_000);
