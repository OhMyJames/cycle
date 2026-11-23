import { expect, test } from "bun:test";
import { CODEX_NOTIFICATION_METHODS, CODEX_VERSION } from "../src/protocol.ts";

test("the harness pins one Codex app-server baseline and an explicit notification allowlist", () => {
  expect(CODEX_VERSION).toBe("0.171.0");
  expect(CODEX_NOTIFICATION_METHODS).toContain("thread/tokenUsage/updated");
  expect(CODEX_NOTIFICATION_METHODS).toContain("turn/plan/updated");
  expect(CODEX_NOTIFICATION_METHODS).not.toContain("unknown/notification");
});
