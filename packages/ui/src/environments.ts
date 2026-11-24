// Environments as the page edits them (docs/desktop.md "环境"): variables written as a `.env` file, and the checks an
// environment must pass before it is kept or sent. The page may not import `@cycle/protocol`, so the daemon's rules
// (`VARIABLE_NAME`, `RESERVED_VARIABLES`, `ENVIRONMENT_MAX_BYTES`) are copied here, and a test holds the two together.
import type { Environment, EnvironmentProblem, EnvironmentScripts } from "./api.ts";

/** A name a shell can export. The daemon's `VARIABLE_NAME`. */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The names an environment may not set: the daemon's (`RESERVED_VARIABLES` of `@cycle/protocol`). */
export const RESERVED_VARIABLES: readonly string[] = [
  "PATH",
  "HOME",
  "SHELL",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TERM",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
];

export const isReservedVariable = (name: string): boolean =>
  RESERVED_VARIABLES.includes(name) || name.startsWith("CYCLE_");

/** How much an environment may hold, as its JSON is long. The daemon's `ENVIRONMENT_MAX_BYTES`. */
export const ENVIRONMENT_MAX_BYTES = 64 * 1024;

export const SCRIPT_SYSTEMS = ["default", "macos", "linux", "windows"] as const;
export type ScriptSystem = (typeof SCRIPT_SYSTEMS)[number];

/** What is wrong with one line of the variables, by its number (from 1). */
export type VariableLineProblem =
  | { line: number; problem: "no_equals" }
  | { line: number; problem: "unclosed_quote" }
  | { line: number; problem: "invalid_name"; name: string }
  | { line: number; problem: "reserved"; name: string }
  | { line: number; problem: "duplicate"; name: string; first: number };

const unescapeDouble = (text: string): string =>
  text.replace(/\\([\\"nrt])/g, (_, c: string) =>
    c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c,
  );

/**
 * Reads variables written as a `.env` file: one `NAME=value` a line, `#` starts a comment line, `export ` before a name
 * is allowed. A value may be quoted: `"…"` takes `\n`, `\t`, `\"` and `\\`; `'…'` is taken as it is. An unquoted value
 * is trimmed, and a ` #` in it starts a comment. What is wrong is said by line, and nothing on a wrong line is taken.
 */
export const parseVariables = (
  text: string,
): { variables: { name: string; value: string }[]; problems: VariableLineProblem[] } => {
  const variables: { name: string; value: string }[] = [];
  const problems: VariableLineProblem[] = [];
  const seen = new Map<string, number>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return;
    const body = trimmed.replace(/^export\s+/, "");
    const equals = body.indexOf("=");
    if (equals === -1) {
      problems.push({ line, problem: "no_equals" });
      return;
    }
    const name = body.slice(0, equals).trim();
    let rest = body.slice(equals + 1).trim();
    let value: string;
    const quote = rest[0];
    if (quote === '"' || quote === "'") {
      // The closing quote: the first one not escaped (single quotes take no escapes).
      let end = -1;
      for (let i = 1; i < rest.length; i++) {
        if (quote === '"' && rest[i] === "\\") {
          i++;
          continue;
        }
        if (rest[i] === quote) {
          end = i;
          break;
        }
      }
      const after = end === -1 ? "" : rest.slice(end + 1).trim();
      if (end === -1 || (after !== "" && !after.startsWith("#"))) {
        problems.push({ line, problem: "unclosed_quote" });
        return;
      }
      const inner = rest.slice(1, end);
      value = quote === '"' ? unescapeDouble(inner) : inner;
    } else {
      const comment = rest.search(/\s#/);
      if (comment !== -1) rest = rest.slice(0, comment).trimEnd();
      value = rest;
    }
    if (!VARIABLE_NAME.test(name)) {
      problems.push({ line, problem: "invalid_name", name });
      return;
    }
    if (isReservedVariable(name)) {
      problems.push({ line, problem: "reserved", name });
      return;
    }
    const first = seen.get(name);
    if (first !== undefined) {
      problems.push({ line, problem: "duplicate", name, first });
      return;
    }
    seen.set(name, line);
    variables.push({ name, value });
  });
  return { variables, problems };
};

/** Variables as a `.env` file that reads back as the same: a value is quoted when it would not be taken as it is. */
export const formatVariables = (variables: readonly { name: string; value: string }[]): string =>
  variables
    .map(({ name, value }) => {
      const safe =
        value === value.trim() &&
        !/^["']/.test(value) &&
        !/\s#/.test(value) &&
        !/[\n\r]/.test(value);
      if (safe) return `${name}=${value}`;
      const escaped = value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\t/g, "\\t");
      return `${name}="${escaped}"`;
    })
    .join("\n");

/** The scripts with their empty systems left out; undefined when none has a command. */
export const scriptsOrNone = (
  scripts: EnvironmentScripts | undefined,
): EnvironmentScripts | undefined => {
  if (scripts === undefined) return undefined;
  const kept: EnvironmentScripts = {};
  for (const system of SCRIPT_SYSTEMS) {
    const text = scripts[system];
    if (text !== undefined && text.trim() !== "") kept[system] = text;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
};

/** What a session is sent of an environment: the same, without empty scripts. */
export const environmentSnapshot = (environment: Environment): Environment => {
  const setup = scriptsOrNone(environment.setup);
  const cleanup = scriptsOrNone(environment.cleanup);
  return {
    id: environment.id,
    name: environment.name,
    variables: environment.variables.map(({ name, value }) => ({ name, value })),
    actions: environment.actions.map(({ id, name, icon, command }) => ({
      id,
      name,
      ...(icon !== undefined ? { icon } : {}),
      command: scriptsOrNone(command) ?? {},
    })),
    ...(setup !== undefined ? { setup } : {}),
    ...(cleanup !== undefined ? { cleanup } : {}),
  };
};

/** The first thing wrong with an environment, in the order the editor shows its fields; undefined when it can be kept. */
export const environmentProblem = (environment: Environment): EnvironmentProblem | undefined => {
  if (environment.name.trim() === "") return { problem: "name_missing" };
  const seen = new Set<string>();
  for (const { name, value } of environment.variables) {
    if (!VARIABLE_NAME.test(name) || value.includes("\0"))
      return { problem: "invalid_variable", name };
    if (isReservedVariable(name)) return { problem: "reserved_variable", name };
    if (seen.has(name)) return { problem: "duplicate_variable", name };
    seen.add(name);
  }
  for (const action of environment.actions) {
    if (action.name.trim() === "") return { problem: "action_name_missing" };
    if (scriptsOrNone(action.command) === undefined)
      return { problem: "action_command_missing", action: action.name };
  }
  const bytes = new TextEncoder().encode(JSON.stringify(environmentSnapshot(environment))).length;
  if (bytes > ENVIRONMENT_MAX_BYTES) return { problem: "too_large", limit: ENVIRONMENT_MAX_BYTES };
  return undefined;
};

/** A new id, for an environment or an action. Unique among those given. */
export const newEnvironmentId = (
  prefix: string,
  taken: ReadonlySet<string> = new Set(),
): string => {
  for (;;) {
    const id = `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
    if (!taken.has(id)) return id;
  }
};

/**
 * The icons an action may have, by the id kept in its `icon` (docs/desktop.md "环境"). The one place that lists them: the
 * editor offers these, and the title bar draws them. `terminal` is the default.
 */
export const ACTION_ICONS = [
  "terminal",
  "play",
  "test",
  "build",
  "database",
  "server",
  "refresh",
  "clean",
] as const;
export type ActionIcon = (typeof ACTION_ICONS)[number];

/** The icon an action is drawn with: its own when this version knows it, else the terminal. */
export const actionIconOf = (icon: string | undefined): ActionIcon =>
  ACTION_ICONS.find((known) => known === icon) ?? "terminal";
