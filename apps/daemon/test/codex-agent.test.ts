import { expect, test } from "bun:test";
import { codexEnv, codexHarness } from "../src/codex-agent.ts";
import { ConfigSchema } from "../src/config.ts";

test("Codex gets only the allowlist and its own home, never the host's keys or ~/.codex", () => {
  const config = ConfigSchema.parse({}).codex;
  const env = codexEnv(config, "/data", {
    PATH: "/bin",
    HOME: "/Users/someone",
    OPENAI_API_KEY: "host-secret",
    CODEX_HOME: "/Users/someone/.codex",
  });
  expect(env).toEqual({ PATH: "/bin", CODEX_HOME: "/data/codex", HOME: "/data/codex" });
});

test("the daemon offers Codex's steering and attachments, and signs in with a file-kept login", () => {
  const definition = codexHarness.definition({
    config: ConfigSchema.parse({}),
    dataDir: "/data",
    inherited: { PATH: "/bin" },
    self: ["cycle"],
  });
  expect(definition.steer).toBe(true);
  expect(definition.promptCapabilities).toEqual({ image: {}, embeddedContext: {} });
  expect(codexHarness.cli?.login).toEqual(["login"]);
  // A fresh data directory has no CODEX_HOME yet, and Codex will not sign in to one that is not there.
  expect(codexHarness.cli?.directories).toEqual(["CODEX_HOME"]);
  expect(codexHarness.cli?.args).toEqual(["-c", 'cli_auth_credentials_store="file"']);
});
