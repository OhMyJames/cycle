// Where each agent's own binary is found when the daemon is built, by the harness's id (src/harnesses.ts). A harness
// that names a `binary` has an entry here; build.ts copies what it returns beside the daemon, under that name.

import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { nativeBinary } from "../../../harness/codex/src/binary.ts";

const root = new URL("..", import.meta.url).pathname;

export const BINARY_SOURCES: Record<string, () => Promise<string>> = {
  codex: async () => nativeBinary(),
  // The SDK's platform package holds the Claude Code binary. Find it where the SDK is installed.
  claude: async () => {
    const sdkPackage = Bun.resolveSync(
      "@anthropic-ai/claude-agent-sdk/package.json",
      join(root, "../../harness/claude"),
    );
    const platformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    const platformDir = dirname(
      Bun.resolveSync(`${platformPackage}/package.json`, dirname(sdkPackage)),
    );
    const binary = (await readdir(platformDir)).find((f) => f === "claude" || f === "claude.exe");
    if (binary === undefined) throw new Error(`no Claude binary in ${platformDir}`);
    return join(platformDir, binary);
  },
};
