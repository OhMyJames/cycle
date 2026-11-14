/**
 * Puts a stand-in for Docker's `sbx` (`fake-sbx.sh`) under a folder of the caller's, so a session
 * can be asked into a sandbox with no Docker and no virtual machine. Everything on this side of
 * `sbx` is real, and so is the Claude Code it starts.
 */
import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

export interface FakeSbx {
  /** Where the stand-in keeps its sandboxes: `names`, `execs`, and a home for each. */
  state: string;
  /** What to add to the environment `sbx` is looked for and run in. */
  env: Record<string, string>;
}

export function installFakeSbx(root: string): FakeSbx {
  const state = join(root, "sbx");
  // What is on the sandbox's PATH: the usual tools, and a Claude Code of its own.
  const inside = join(root, "sbx-inside");
  const outside = join(root, "sbx-bin");
  mkdirSync(inside, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const sdk = Bun.resolveSync(
    "@anthropic-ai/claude-agent-sdk",
    join(import.meta.dir, "../../../../harness/claude"),
  );
  const binary = Bun.resolveSync(
    `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    dirname(sdk),
  );
  symlinkSync(join(dirname(binary), "claude"), join(inside, "claude"));
  symlinkSync(join(import.meta.dir, "fake-sbx.sh"), join(outside, "sbx"));
  return {
    state,
    env: {
      PATH: `${outside}:${process.env["PATH"] ?? ""}`,
      SBX_FAKE_STATE: state,
      SBX_FAKE_PATH: `${inside}:/usr/bin:/bin`,
    },
  };
}
