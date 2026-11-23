import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HARNESSES } from "../apps/daemon/src/harnesses.ts";
import { AGENT_BINS } from "../apps/desktop/src/main/layout.ts";

// The app carries what the daemon's build makes. The two are separate programs that share no module, so the lists are
// written twice; this is what holds them together when an agent is added (apps/daemon/src/harness.ts).
test("the app packages, and checks for, exactly the agents' binaries the daemon ships", () => {
  const shipped = HARNESSES.flatMap((h) => (h.binary !== undefined ? [`bin/${h.binary}`] : []));
  expect([...AGENT_BINS].sort() as string[]).toEqual(shipped.sort());
});

test("the installer installs, and refuses to go on without, the daemon and exactly those binaries", () => {
  const script = readFileSync(
    new URL("../apps/daemon/scripts/install.sh", import.meta.url),
    "utf8",
  );
  const files = /^for file in (.+); do$/m.exec(script)?.[1]?.split(" ");
  expect(files).toEqual(["cycle", ...HARNESSES.flatMap((h) => (h.binary ? [h.binary] : []))]);
});
