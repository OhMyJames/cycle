// What the loop answers when an agent asks permission, with no one watching (CYC-318).
//
// Three answers. `allow`: the request is plainly inside the work (read the worktree, edit it, run the checks).
// `deny`: never, for this role. `ask`: anything else is left unanswered, so the session waits in `requires_action`
// and a person answers it in the desktop app. An unrecognized request is `ask`, never `allow`.
//
// The research roles (CYC-447) only read, and never wait for a person: what they may not do is `deny`. The planning
// node's roles (CYC-322: `triage`, `shape`, `shape_qa`) follow exactly the same rules.

import { posix } from "node:path";
import type { PermissionAnswer } from "@cycle/client";

export type Role =
  | "dev"
  | "qa"
  | "review"
  | "research"
  | "research_qa"
  | "triage"
  | "shape"
  | "shape_qa"
  | "graph_planner";
export type Decision = { decision: "allow" | "deny" | "ask"; reason: string };

type ToolCall = { kind?: unknown; rawInput?: unknown; locations?: unknown };

const toolCallOf = (request: Record<string, unknown>): ToolCall | undefined => {
  const subject = request.subject as { toolCall?: unknown } | undefined;
  const call = subject?.toolCall ?? request.toolCall;
  return typeof call === "object" && call !== null ? (call as ToolCall) : undefined;
};

const PATH_KEY = /path|file|dir|target|cwd/i;

/** Every path a tool call names, resolved against the worktree. */
const pathsOf = (call: ToolCall, worktree: string): string[] => {
  const found: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value !== "") found.push(value);
  };
  if (Array.isArray(call.locations)) {
    for (const location of call.locations) add((location as { path?: unknown })?.path);
  }
  const input = call.rawInput;
  if (typeof input === "object" && input !== null) {
    for (const [key, value] of Object.entries(input)) {
      if (PATH_KEY.test(key)) {
        if (Array.isArray(value)) value.forEach(add);
        else add(value);
      }
    }
  }
  return found.map((p) => (p.startsWith("/") ? posix.normalize(p) : posix.join(worktree, p)));
};

const inside = (worktree: string, path: string): boolean =>
  path === worktree || path.startsWith(`${worktree}/`);

const touchesGit = (worktree: string, path: string): boolean =>
  posix
    .relative(worktree, path)
    .split("/")
    .some((part) => part === ".git");

/**
 * A command as a list of simple commands, or undefined when it uses shell syntax this policy does not read: command
 * substitution, redirection, variables, background jobs, an unbalanced quote. `&&`, `||`, `;` and `|` only join
 * simple commands.
 */
export const splitCommand = (command: string): string[][] | undefined => {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else word += c;
      continue;
    }
    if (c === "\n" || c === "`") return undefined;
    if (c === "$" || c === "<" || c === ">") {
      if (quote === undefined || c === "$") return undefined;
    }
    if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === "\\") {
        i++;
        word += command[i] ?? "";
      } else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\") {
      i++;
      word += command[i] ?? "";
      inWord = true;
    } else if (c === " " || c === "\t") endWord();
    else if (c === ";") endSegment();
    else if (c === "|") {
      if (command[i + 1] === "|") i++;
      endSegment();
    } else if (c === "&") {
      if (command[i + 1] !== "&") return undefined;
      i++;
      endSegment();
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote !== undefined) return undefined;
  endSegment();
  return segments;
};

const READ_ONLY = ["ls", "cat", "head", "tail", "wc", "rg", "grep", "pwd", "echo"];
const GIT_READ = ["status", "diff", "log", "show", "rev-parse", "ls-files"];
/** What a research session may run besides `READ_ONLY` and `GIT_READ`. */
const RESEARCH_READ = ["du", "find", "stat", "file"];

type CommandShape = {
  argv: readonly string[];
  rest: "none" | "paths" | ((args: string[], worktree: string | undefined) => boolean);
};

const safeWorktreePath = (arg: string, worktree: string | undefined): boolean => {
  if (arg === "" || arg.startsWith("-") || arg.startsWith("~") || /[{}]/.test(arg)) return false;
  if (arg.split("/").includes("..")) return false;
  if (worktree === undefined) return !arg.startsWith("/") && !arg.split("/").includes(".git");
  const resolved = arg.startsWith("/") ? posix.normalize(arg) : posix.join(worktree, arg);
  return inside(worktree, resolved) && !touchesGit(worktree, resolved);
};

const gitAddRest = (args: string[], worktree: string | undefined): boolean => {
  if (args.length === 0) return false;
  let afterDash = false;
  let sawTarget = false;
  for (const arg of args) {
    if (!afterDash && arg === "--") {
      afterDash = true;
      continue;
    }
    if (!afterDash && (arg === "-A" || arg === "--all" || arg === "-u" || arg === "--update")) {
      sawTarget = true;
      continue;
    }
    if (!safeWorktreePath(arg, worktree)) return false;
    sawTarget = true;
  }
  return sawTarget;
};

const gitCommitRest = (args: string[], worktree: string | undefined): boolean => {
  if (args.length === 0) return false;
  let i = 0;
  let sawMessage = false;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "-m") {
      const msg = args[i + 1];
      if (msg === undefined) return false;
      sawMessage = true;
      i += 2;
      continue;
    }
    if (arg === "-F") {
      const file = args[i + 1];
      if (file === undefined || !safeWorktreePath(file, worktree)) return false;
      sawMessage = true;
      i += 2;
      continue;
    }
    return false;
  }
  return sawMessage;
};

const bunTestRest = (args: string[], worktree: string | undefined): boolean => {
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "-t") {
      const pattern = args[i + 1];
      if (pattern === undefined || pattern === "") return false;
      i += 2;
      continue;
    }
    if (!arg.startsWith("./") || !safeWorktreePath(arg, worktree)) return false;
    i += 1;
  }
  return true;
};

/** Exact shapes dev may run without asking (CYC-472): no arbitrary extra flags or trailing arguments. */
const DEV_ALLOW: readonly CommandShape[] = [
  { argv: ["bun", "run", "check"], rest: "none" },
  { argv: ["bun", "run", "format"], rest: "none" },
  { argv: ["bun", "run", "lint"], rest: "none" },
  { argv: ["bun", "run", "typecheck"], rest: "none" },
  { argv: ["bun", "run", "test:browser"], rest: "none" },
  {
    argv: ["bun", "run", "test:integration"],
    rest: (args) =>
      args.length === 0 ||
      (args.length === 1 && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(args[0] as string)),
  },
  { argv: ["bun", "test"], rest: bunTestRest },
  {
    argv: ["bun", "install"],
    rest: (args) => args.length === 0 || (args.length === 1 && args[0] === "--frozen-lockfile"),
  },
  { argv: ["git", "add"], rest: gitAddRest },
  { argv: ["git", "commit"], rest: gitCommitRest },
  { argv: ["git", "branch", "--show-current"], rest: "none" },
];

const matchesShape = (
  words: string[],
  shape: CommandShape,
  worktree: string | undefined,
): boolean => {
  if (words.length < shape.argv.length) return false;
  if (!shape.argv.every((word, index) => words[index] === word)) return false;
  const rest = words.slice(shape.argv.length);
  if (shape.rest === "none") return rest.length === 0;
  if (shape.rest === "paths")
    return rest.length > 0 && rest.every((arg) => safeWorktreePath(arg, worktree));
  return shape.rest(rest, worktree);
};

/** The roles under the research rules: read the worktree and the read roots, nothing else, never ask. */
const RESEARCH_RULES: ReadonlySet<Role> = new Set([
  "research",
  "research_qa",
  "triage",
  "shape",
  "shape_qa",
  "graph_planner",
]);
const isResearch = (role: Role): boolean => RESEARCH_RULES.has(role);

const simpleAllowed = (words: string[], role: Role, worktree?: string): boolean => {
  const [program, sub] = words;
  if (program === undefined) return false;
  if (READ_ONLY.includes(program)) return true;
  if (isResearch(role) && RESEARCH_READ.includes(program)) return true;
  if (program === "git" && sub !== undefined && GIT_READ.includes(sub)) return true;
  return role === "dev" && DEV_ALLOW.some((shape) => matchesShape(words, shape, worktree));
};

/** Options of the read-only programs that run another program or write a file. */
const DANGEROUS_FLAG =
  /^--?(pre|pre-glob|hostname-bin|output|ext-diff|textconv|exec|open-files-in-pager|O)(=|$)/;

const reaches = (word: string, worktree: string): boolean => {
  if (word.startsWith("~")) return true;
  if (word.startsWith("/")) return !inside(worktree, posix.normalize(word));
  return word.split("/").includes("..");
};

/**
 * A word that names a place must stay in the worktree; so must the value of `--opt=value`. Brace expansion is refused:
 * it can put a path behind a word that starts with `{`.
 */
const wanders = (word: string, worktree: string): boolean => {
  if (/[{}]/.test(word) || DANGEROUS_FLAG.test(word)) return true;
  return word.split("=").some((part) => reaches(part, worktree));
};

const commandOf = (call: ToolCall): string | undefined => {
  const input = call.rawInput;
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["command", "CommandLine", "cmd"]) {
    const value = record[key];
    if (typeof value === "string") return value;
    if (Array.isArray(value) && value.every((part) => typeof part === "string"))
      return (value as string[]).join(" ");
  }
  return undefined;
};

/**
 * A file a research session may not read, wherever it is: secrets by name, and a `.git` directory's config (a remote's
 * address can hold a token). Matched without case: the file systems it runs on mostly ignore it.
 */
const SECRET_NAME =
  /^(\.env.*|.*\.pem|.*\.key|id_.*|\.netrc|\.npmrc|auto-loop\.json|loop\.json|credentials.*|.*\.secret.*)$/i;

const secretIn = (path: string): boolean => {
  const parts = path.split("/");
  return parts.some(
    (part, index) =>
      SECRET_NAME.test(part) ||
      (/^config(\..*)?$/i.test(part) && parts.slice(0, index).includes(".git")),
  );
};

/** An absolute path inside the worktree or a read root, with no part of it on the secret list. */
const readable = (path: string, worktree: string, readRoots: string[]): boolean =>
  [worktree, ...readRoots].some((root) => inside(root, path)) && !secretIn(path);

/** `find` primaries that run a program, delete, or write a file. */
const FIND_WRITES = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);
/**
 * A grep that walks a directory reads every file under it, ignored or not: a read root's `.env` would be read under the
 * name of the root. Combined short options with `r` or `R` count (`-rn`).
 */
const grepRecurses = (words: string[]): boolean =>
  words.some(
    (word, index) =>
      /^-[^-]*[rR]/.test(word) ||
      /^--(recursive|dereference-recursive|directories=recurse)$/.test(word) ||
      ((word === "-d" || word === "--directories") && words[index + 1] === "recurse"),
  );
/** rg honours ignore files and skips hidden ones unless told otherwise (`-u`, `-.`, `-L` alone or combined). */
const rgUnignores = (words: string[]): boolean =>
  words.some(
    (word) => /^-[^-]*[u.L]/.test(word) || /^--(no-ignore|hidden|follow|unrestricted)/.test(word),
  );
/** `file -C` compiles a magic file: it writes. */
const FILE_WRITES = /^(-C|--compile|-[A-Za-z]*C[A-Za-z]*)$/;

/** Whether the command has a `*`, `?` or `[` the shell would expand: it can name a file no word spells out. */
const globs = (command: string): boolean => {
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string;
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      else if (quote === '"' && c === "\\") i++;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "\\") i++;
    else if (c === "*" || c === "?" || c === "[") return true;
  }
  return false;
};

/**
 * A word of a research command that names, or may name, a place it may not read. As in `wanders`, but the place may be
 * any read root, and no part may be on the secret list; the parts of `--opt=value` and `rev:path` count on their own.
 * Every word is taken as a path: a search for `credentials` is refused with the file of that name.
 */
const strays = (word: string, worktree: string, readRoots: string[]): boolean => {
  if (/[{}]/.test(word) || DANGEROUS_FLAG.test(word)) return true;
  return word
    .split(/[=:]/)
    .filter((part) => part !== "")
    .some((part) => {
      if (part.startsWith("~")) return true;
      const path = part.startsWith("/") ? posix.normalize(part) : posix.join(worktree, part);
      return !readable(path, worktree, readRoots);
    });
};

const researchCommand = (
  command: string | undefined,
  worktree: string,
  readRoots: string[],
): Decision => {
  const deny = (reason: string): Decision => ({ decision: "deny", reason });
  if (command === undefined) return deny("a command that could not be read");
  const segments = splitCommand(command);
  if (segments === undefined || segments.length === 0 || globs(command))
    return deny("a command with shell syntax the policy does not read");
  for (const words of segments) {
    if (!simpleAllowed(words, "research")) return deny("a command outside the allowlist");
    const [program] = words;
    if (program === "find" && words.some((word) => FIND_WRITES.has(word)))
      return deny("a find that runs a program, deletes or writes");
    if (program === "file" && words.some((word) => FILE_WRITES.test(word)))
      return deny("a file that writes");
    if (program === "grep" && grepRecurses(words))
      return deny("a recursive grep, which reads ignored files");
    if (program === "rg" && rgUnignores(words))
      return deny("an rg that reads ignored or hidden files");
    if (words.slice(1).some((word) => strays(word, worktree, readRoots)))
      return deny("a command that reaches outside the read roots or names a secret");
  }
  return { decision: "allow", reason: "an allowlisted command" };
};

/**
 * The research and planning roles: read the worktree and the read roots, run read-only commands; refuse the rest
 * outright.
 */
const decideResearch = (
  request: Record<string, unknown>,
  worktree: string,
  readRoots: string[],
): Decision => {
  const call = toolCallOf(request);
  if (call === undefined) return { decision: "deny", reason: "no tool call in the request" };
  const kind = typeof call.kind === "string" ? call.kind : "other";
  switch (kind) {
    case "think":
      return { decision: "allow", reason: "thinking" };
    case "read":
    case "search": {
      const paths = pathsOf(call, worktree);
      // A request that names no path (a web search, a URI) is not shown to be inside the read roots.
      if (paths.length > 0 && paths.every((path) => readable(path, worktree, readRoots)))
        return { decision: "allow", reason: `${kind} in the read roots` };
      return { decision: "deny", reason: `${kind} outside the read roots or of a secret` };
    }
    case "edit":
    case "delete":
    case "move":
      return { decision: "deny", reason: "Research is read-only" };
    case "execute":
      return researchCommand(commandOf(call), worktree, readRoots);
    default:
      return { decision: "deny", reason: `a ${kind} request` };
  }
};

export const decide = (
  request: Record<string, unknown>,
  context: { role: Role; worktree: string; readRoots?: string[] },
): Decision => {
  const { role, worktree } = context;
  if (isResearch(role)) {
    const roots = (context.readRoots ?? []).map((root) =>
      posix.normalize(root).replace(/(.)\/+$/, "$1"),
    );
    return decideResearch(request, worktree, roots);
  }
  const call = toolCallOf(request);
  if (call === undefined) return { decision: "ask", reason: "no tool call in the request" };
  const kind = typeof call.kind === "string" ? call.kind : "other";
  const readOnlyRole = role === "qa" || role === "review";
  const other = (reason: string): Decision =>
    readOnlyRole ? { decision: "deny", reason } : { decision: "ask", reason };

  switch (kind) {
    case "think":
      return { decision: "allow", reason: "thinking" };
    case "read":
    case "search": {
      const paths = pathsOf(call, worktree);
      // A request whose target could not be read is not shown to be inside the worktree.
      if (paths.length > 0 && paths.every((path) => inside(worktree, path)))
        return { decision: "allow", reason: `${kind} in the worktree` };
      return other(`${kind} outside the worktree`);
    }
    case "edit":
    case "delete":
    case "move": {
      if (readOnlyRole)
        return {
          decision: "deny",
          reason: `${role === "review" ? "Review" : "QA"} is read-only`,
        };
      const paths = pathsOf(call, worktree);
      if (paths.length === 0) return { decision: "ask", reason: "an edit that names no file" };
      if (!paths.every((path) => inside(worktree, path) && !touchesGit(worktree, path)))
        return { decision: "ask", reason: "an edit outside the worktree or in .git" };
      return { decision: "allow", reason: "edit in the worktree" };
    }
    case "execute": {
      const command = commandOf(call);
      if (command === undefined) return other("a command that could not be read");
      const segments = splitCommand(command);
      if (segments === undefined || segments.length === 0 || globs(command))
        return other("a command with shell syntax the policy does not read");
      for (const words of segments) {
        if (!simpleAllowed(words, role, worktree)) return other("a command outside the allowlist");
        if (words.some((word) => wanders(word, worktree)))
          return other("a command that reaches outside the worktree");
      }
      return { decision: "allow", reason: "an allowlisted command" };
    }
    default:
      return other(`a ${kind} request`);
  }
};

const KINDS = new Set([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);
const PROGRAM = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,39}$/;
const SUBCOMMAND = /^[A-Za-z][A-Za-z0-9_.:-]{0,39}$/;

/** The kind of tool a request is for, as one of a fixed set of words ("other" for anything else). */
export const kindOf = (request: Record<string, unknown>): string => {
  const kind = toolCallOf(request)?.kind;
  return typeof kind === "string" && KINDS.has(kind) ? kind : "other";
};

/** Programs whose second word is a subcommand, not an argument: for anything else only the program is recorded. */
const SUBCOMMAND_PROGRAMS = new Set([
  "git",
  "bun",
  "bunx",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "gh",
  "cargo",
  "docker",
  "kubectl",
  "go",
  "uv",
  "pip",
  "brew",
  "systemctl",
]);

/**
 * The first two words of the command that made a request ask or deny ("git mv", "bunx biome"), or undefined when the
 * request is not a command, uses shell syntax this policy does not read, or has no readable program. Never more: the
 * arguments can hold paths and credentials. The second word is kept only for programs that have subcommands. In a
 * compound command it is the first simple command the policy did not allow.
 */
export const commandPrefix = (request: Record<string, unknown>, role: Role): string | undefined => {
  const call = toolCallOf(request);
  if (call === undefined || call.kind !== "execute") return undefined;
  const command = commandOf(call);
  if (command === undefined) return undefined;
  const segments = splitCommand(command);
  if (segments === undefined || segments.length === 0) return undefined;
  const chosen = segments.find((words) => !simpleAllowed(words, role)) ?? segments[0];
  const words = [...(chosen ?? [])];
  while (words[0] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  const [program, sub] = words;
  if (program === undefined || !PROGRAM.test(program)) return undefined;
  return sub !== undefined && SUBCOMMAND_PROGRAMS.has(program) && SUBCOMMAND.test(sub)
    ? `${program} ${sub}`
    : program;
};

type Option = { optionId?: unknown; kind?: unknown };

/** Whether a person's selection in the app allowed or refused the request; undefined for a cancel or anything else. */
export const answeredAs = (
  request: Record<string, unknown>,
  outcome: unknown,
): "allow" | "deny" | undefined => {
  // The daemon may hand the ACP outcome bare or wrapped in `{outcome}`.
  let shape = outcome as { outcome?: unknown; optionId?: unknown } | undefined;
  if (typeof shape?.outcome === "object" && shape.outcome !== null)
    shape = shape.outcome as typeof shape;
  if (shape?.outcome !== "selected") return undefined;
  const options = Array.isArray(request.options) ? (request.options as Option[]) : [];
  const kind = options.find((o) => o.optionId === shape.optionId)?.kind;
  if (typeof kind !== "string") return undefined;
  if (kind.startsWith("allow")) return "allow";
  if (kind.startsWith("reject")) return "deny";
  return undefined;
};

/** The answer for a decision, or undefined when it cannot be given (`ask`, or no matching option). */
export const answerFor = (
  request: Record<string, unknown>,
  verdict: Decision,
): PermissionAnswer | undefined => {
  if (verdict.decision === "ask") return undefined;
  const options = Array.isArray(request.options) ? (request.options as Option[]) : [];
  const wanted = verdict.decision === "allow" ? "allow_once" : "reject_once";
  const option = options.find((candidate) => candidate.kind === wanted);
  if (option !== undefined && typeof option.optionId === "string")
    return { outcome: "selected", optionId: option.optionId };
  // Nothing to select: refusing is cancelling. An allow that has no option is left to a person.
  return verdict.decision === "deny" ? { outcome: "cancelled" } : undefined;
};
