import { expect, test } from "bun:test";
import { findAgyExecutable } from "../apps/daemon/src/agy-agent.ts";
import { ConfigSchema } from "../apps/daemon/src/config.ts";

// The preload (scripts/test-env.ts) is what keeps a test's daemon from starting the agy installed on this machine,
// and with it the keychain and sign-in windows. Integration runs keep the real programs on purpose.
test.skipIf(process.env.CYCLE_TEST_REAL_AGENTS === "1")(
  "a test cannot find the agy installed on this machine",
  () => {
    expect(process.env.HOME).toContain("cycle-test-home-");
    expect(findAgyExecutable(ConfigSchema.parse({}).agy, process.env)).toBeUndefined();
    expect(Bun.which("agy", { PATH: process.env.PATH ?? "" })).toBeNull();
  },
);
