import { expect, test } from "bun:test";
import { CodexHarness } from "../src/index.ts";

// Codex runs one process for every session, on this machine: a session asked into an environment
// is refused whichever word asks, before anything starts.

test("a session asked into an environment is refused, by either word", async () => {
  // No codex exists at this path: were the refusal gone, nothing would start and no home be read.
  const harness = new CodexHarness({ bin: "/nonexistent/codex" });
  const refusal = "Codex sessions do not run in a sandbox yet.";
  await expect(harness.createSession({ cwd: "/p", environment: "standard" })).rejects.toThrow(
    refusal,
  );
  await expect(harness.createSession({ cwd: "/p", sandboxed: "standard" })).rejects.toThrow(
    refusal,
  );
});
