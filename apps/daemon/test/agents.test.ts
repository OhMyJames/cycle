import { expect, test } from "bun:test";
import { CLAUDE_EFFORT_LEVELS, CLAUDE_PERMISSION_MODES } from "@cycle/harness-claude";
import { META } from "@cycle/protocol";
import {
  CLAUDE_CONFIG_SCHEMA,
  claudeEnv,
  claudeHarness,
  locateClaudeBinary,
} from "../src/claude-agent.ts";

import { ConfigSchema } from "../src/config.ts";

test("the default Claude environment keeps host login tokens out, passes host HOME, and isolates CLAUDE_CONFIG_DIR", () => {
  const env = claudeEnv(ConfigSchema.parse({}).claude, "/isolated/cycle", {
    PATH: "/bin",
    HOME: "/host-home",
    CLAUDE_CONFIG_DIR: "/host-config",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-canary",
    ANTHROPIC_API_KEY: "api-canary",
    SSO_TOKEN: "sso-canary",
  });
  expect(env).toEqual({
    PATH: "/bin",
    HOME: "/host-home",
    CLAUDE_CONFIG_DIR: "/isolated/cycle/claude",
  });

  // When no host HOME (or empty HOME) is inherited, HOME falls back to CLAUDE_CONFIG_DIR.
  const withoutHome = claudeEnv(ConfigSchema.parse({}).claude, "/isolated/cycle", {
    PATH: "/bin",
  });
  expect(withoutHome).toEqual({
    PATH: "/bin",
    HOME: "/isolated/cycle/claude",
    CLAUDE_CONFIG_DIR: "/isolated/cycle/claude",
  });
  const withEmptyHome = claudeEnv(ConfigSchema.parse({}).claude, "/isolated/cycle", {
    PATH: "/bin",
    HOME: "",
  });
  expect(withEmptyHome).toEqual({
    PATH: "/bin",
    HOME: "/isolated/cycle/claude",
    CLAUDE_CONFIG_DIR: "/isolated/cycle/claude",
  });

  expect(claudeHarness.cli?.directories).toEqual(["CLAUDE_CONFIG_DIR"]);
  const located = locateClaudeBinary();
  if (located.source === "builtin") {
    expect(claudeHarness.cli?.executable()).toBe(located.path);
  }
  expect(
    claudeHarness.storageDir?.({
      config: ConfigSchema.parse({}),
      dataDir: "/isolated/cycle",
      inherited: { PATH: "/bin", HOME: "/host-home" },
    }),
  ).toBe("/isolated/cycle/claude");
});

test("Claude's settings list every mode and effort level the adapter takes, and leave the model open", () => {
  const { mode, model, effort } = CLAUDE_CONFIG_SCHEMA.properties;
  // The daemon refuses a default that is not listed: a mode left out here could not be saved.
  expect(mode.oneOf.map((entry) => entry.const)).toEqual(
    CLAUDE_PERMISSION_MODES.map((m) => m.value),
  );
  expect(effort.oneOf.map((entry) => entry.const)).toEqual(
    CLAUDE_EFFORT_LEVELS.map((e) => e.value),
  );
  // The model is any name Claude knows, not only the ones offered.
  expect((model as { _meta?: Record<string, unknown> })._meta?.[META.open]).toBe(true);
});

test("sub-agents' progress summaries are on unless the configuration turns them off (CYCL-49)", () => {
  expect(ConfigSchema.parse({}).claude.progressSummaries).toBe(true);
  expect(ConfigSchema.parse({ claude: {} }).claude.progressSummaries).toBe(true);
  expect(
    ConfigSchema.parse({ claude: { progressSummaries: false } }).claude.progressSummaries,
  ).toBe(false);
});
