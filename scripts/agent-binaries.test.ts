import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HARNESSES } from "../apps/daemon/src/harnesses.ts";
import { AGENT_BINS } from "../apps/desktop/src/main/layout.ts";

/** Each agent's binary, then the executables it runs from beside it. */
const shippedFiles = () =>
  HARNESSES.flatMap((h) => (h.binary !== undefined ? [h.binary, ...(h.companions ?? [])] : []));

// The app carries what the daemon's build makes. The two are separate programs that share no module, so the lists are
// written twice; this is what holds them together when an agent is added (apps/daemon/src/harness.ts).
test("the app packages, and checks for, exactly the agents' binaries the daemon ships", () => {
  expect([...AGENT_BINS].sort() as string[]).toEqual(
    shippedFiles()
      .map((f) => `bin/${f}`)
      .sort(),
  );
});

test("the installer installs, and refuses to go on without, the daemon and exactly those binaries", () => {
  const script = readFileSync(
    new URL("../apps/daemon/scripts/install.sh", import.meta.url),
    "utf8",
  );
  const files = /^for file in (.+); do$/m.exec(script)?.[1]?.split(" ");
  expect(files).toEqual(["cycle", ...shippedFiles()]);
});

test("companions are only declared beside a binary that ships", () => {
  for (const h of HARNESSES) if (h.companions?.length) expect(h.binary).toBeDefined();
});
