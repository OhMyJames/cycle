import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { META, type RuntimeProperty } from "@cycle/protocol";
import {
  AgentSettings,
  AgentSettingsConflictError,
  AgentSettingsCorruptError,
  AgentSettingsValidationError,
} from "../src/agent-settings.ts";
import { tempDir } from "./support.ts";

let dir: string;
let dispose: () => Promise<void>;

beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});

afterEach(async () => {
  await dispose();
});

const CLAUDE_SCHEMA: Record<string, RuntimeProperty> = {
  warmStart: {
    type: "boolean",
    title: "Warm start",
    default: true,
    _meta: { [META.applyScope]: "immediate" },
  },
  maxWarm: {
    type: "integer",
    title: "Max warm",
    minimum: 1,
    maximum: 10,
    default: 3,
    _meta: {
      [META.applyScope]: "immediate",
      [META.enabledWhen]: { key: "warmStart", equals: true },
    },
  },
  progressSummaries: {
    type: "boolean",
    title: "Progress summaries",
    default: true,
    _meta: { [META.applyScope]: "next_idle_restart" },
  },
};

const AGY_SCHEMA: Record<string, RuntimeProperty> = {
  sandbox: {
    type: "boolean",
    title: "Sandbox",
    default: false,
    _meta: { [META.applyScope]: "next_idle_restart", [META.danger]: true },
  },
  telemetry: {
    type: "boolean",
    title: "Telemetry",
    default: true,
    _meta: { [META.applyScope]: "next_idle_restart" },
  },
};

test("merges precedence agent-settings.json > config.json > schema default, supports null unset, and writes 0600", async () => {
  const path = join(dir, "agent-settings.json");
  const settings = await AgentSettings.load(path);
  expect(settings.fileError()).toBeUndefined();
  expect(settings.revisionOf("claude")).toBe(0);

  const defaults = { warmStart: true, maxWarm: 3, progressSummaries: true };
  const fromConfig = { warmStart: true, maxWarm: 5, progressSummaries: false };

  // Before any override: config.json wins over schema default.
  expect(settings.effective("claude", defaults, fromConfig)).toEqual({
    values: { warmStart: true, maxWarm: 5, progressSummaries: false },
    overrides: [],
    revision: 0,
  });

  // Patch warmStart and progressSummaries -> overrides win over config.json.
  const first = await settings.patch(
    "claude",
    { warmStart: false, progressSummaries: true },
    0,
    CLAUDE_SCHEMA,
  );
  expect(first).toEqual({
    overrides: { warmStart: false, progressSummaries: true },
    revision: 1,
  });
  expect(settings.effective("claude", defaults, fromConfig)).toEqual({
    values: { warmStart: false, maxWarm: 5, progressSummaries: true },
    overrides: ["progressSummaries", "warmStart"],
    revision: 1,
  });

  // File exists with mode 0600.
  const st = await stat(path);
  expect(st.mode & 0o777).toBe(0o600);

  // Explicit null unsets override and restores inheritance from config.json.
  const second = await settings.patch("claude", { progressSummaries: null }, 1, CLAUDE_SCHEMA);
  expect(second).toEqual({
    overrides: { warmStart: false },
    revision: 2,
  });
  expect(settings.effective("claude", defaults, fromConfig)).toEqual({
    values: { warmStart: false, maxWarm: 5, progressSummaries: false },
    overrides: ["warmStart"],
    revision: 2,
  });

  // Reloading from disk preserves revision and overrides.
  const reloaded = await AgentSettings.load(path);
  expect(reloaded.revisionOf("claude")).toBe(2);
  expect(reloaded.overridesOf("claude")).toEqual({ warmStart: false });
});

test("per-agent revisions allow concurrent edits to different agents and reject stale same-agent edits", async () => {
  const path = join(dir, "agent-settings.json");
  const settings = await AgentSettings.load(path);

  // Client A edits claude while Client B edits agy concurrently at revision 0 -> both succeed.
  const [claudeRes, agyRes] = await Promise.all([
    settings.patch("claude", { warmStart: false }, 0, CLAUDE_SCHEMA),
    settings.patch("agy", { telemetry: false }, 0, AGY_SCHEMA),
  ]);
  expect(claudeRes.revision).toBe(1);
  expect(agyRes.revision).toBe(1);

  // Stale revision on claude fails with AgentSettingsConflictError, leaving state intact.
  await expect(settings.patch("claude", { maxWarm: 2 }, 0, CLAUDE_SCHEMA)).rejects.toBeInstanceOf(
    AgentSettingsConflictError,
  );
  expect(settings.revisionOf("claude")).toBe(1);
  expect(settings.overridesOf("claude")).toEqual({ warmStart: false });

  // Schema validation rejects unknown field, wrong type, and out-of-range integer.
  await expect(
    settings.patch("claude", { unknownKey: true }, 1, CLAUDE_SCHEMA),
  ).rejects.toBeInstanceOf(AgentSettingsValidationError);
  await expect(settings.patch("claude", { maxWarm: 99 }, 1, CLAUDE_SCHEMA)).rejects.toBeInstanceOf(
    AgentSettingsValidationError,
  );
  await expect(
    settings.patch("claude", { warmStart: "yes" }, 1, CLAUDE_SCHEMA),
  ).rejects.toBeInstanceOf(AgentSettingsValidationError);
});

test("corrupt or unsupported-version agent-settings.json reports fileError and is never silently overwritten", async () => {
  const path = join(dir, "agent-settings.json");
  const corruptContent = "{ not valid json";
  await writeFile(path, corruptContent, "utf8");

  const settings = await AgentSettings.load(path);
  expect(settings.fileError()).toBeDefined();
  expect(settings.revisionOf("claude")).toBe(0);

  // Refuses writes and preserves exact corrupt file bytes on disk.
  await expect(
    settings.patch("claude", { warmStart: false }, 0, CLAUDE_SCHEMA),
  ).rejects.toBeInstanceOf(AgentSettingsCorruptError);
  expect(await readFile(path, "utf8")).toBe(corruptContent);

  // Unknown version also reports fileError and refuses writes.
  const futureContent = JSON.stringify({ version: 2, agents: {} });
  await writeFile(path, futureContent, "utf8");
  const future = await AgentSettings.load(path);
  expect(future.fileError()).toBeDefined();
  await expect(
    future.patch("claude", { warmStart: false }, 0, CLAUDE_SCHEMA),
  ).rejects.toBeInstanceOf(AgentSettingsCorruptError);
  expect(await readFile(path, "utf8")).toBe(futureContent);
});
