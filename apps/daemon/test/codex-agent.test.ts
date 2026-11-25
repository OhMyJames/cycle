import { expect, test } from "bun:test";
import { codexEnv, codexHarness } from "../src/codex-agent.ts";
import { ConfigSchema } from "../src/config.ts";

test("Codex passes host HOME, isolates CODEX_HOME, and never inherits host keys or ~/.codex", () => {
  const config = ConfigSchema.parse({}).codex;
  const env = codexEnv(config, "/data", {
    PATH: "/bin",
    HOME: "/Users/someone",
    OPENAI_API_KEY: "host-secret",
    CODEX_HOME: "/Users/someone/.codex",
  });
  expect(env).toEqual({ PATH: "/bin", CODEX_HOME: "/data/codex", HOME: "/Users/someone" });

  // When no host HOME (or empty HOME) is inherited, HOME falls back to CODEX_HOME.
  const withoutHome = codexEnv(config, "/data", { PATH: "/bin" });
  expect(withoutHome).toEqual({ PATH: "/bin", CODEX_HOME: "/data/codex", HOME: "/data/codex" });
  const withEmptyHome = codexEnv(config, "/data", { PATH: "/bin", HOME: "" });
  expect(withEmptyHome).toEqual({ PATH: "/bin", CODEX_HOME: "/data/codex", HOME: "/data/codex" });
});

test("the daemon offers Codex's steering and attachments, and signs in with file-kept credentials", () => {
  const definition = codexHarness.definition({
    config: ConfigSchema.parse({}),
    dataDir: "/data",
    inherited: { PATH: "/bin", HOME: "/Users/someone" },
    self: ["cycle"],
  });
  expect(definition.steer).toBe(true);
  expect(definition.promptCapabilities).toEqual({ image: {}, embeddedContext: {} });
  expect(codexHarness.cli?.login).toEqual(["login"]);
  // A fresh data directory has no CODEX_HOME yet, and Codex will not sign in to one that is not there.
  expect(codexHarness.cli?.directories).toEqual(["CODEX_HOME"]);
  expect(codexHarness.cli?.args).toEqual([
    "-c",
    'cli_auth_credentials_store="file"',
    "-c",
    'mcp_oauth_credentials_store="file"',
  ]);
  expect(
    codexHarness.storageDir?.({
      config: ConfigSchema.parse({}),
      dataDir: "/data",
      inherited: { PATH: "/bin", HOME: "/Users/someone" },
    }),
  ).toBe("/data/codex");
});
