// What the loop answers when an agent asks permission, with no one watching (CYC-318).
//
// Three answers. `allow`: the request is plainly inside the work (read the worktree, edit it, run the checks).
// `deny`: never, for this role. `ask`: anything else is left unanswered, so the session waits in `requires_action`
// and a person answers it in the desktop app. An unrecognized request is `ask`, never `allow`.

import { posix } from "node:path";
import type { PermissionAnswer } from "@cycle/client";

export type Role = "dev" | "qa";
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
const DEV_RUN = [
  ["bun", "run", "check"],
  ["bun", "run", "format"],
  ["bun", "run", "lint"],
  ["bun", "run", "typecheck"],
  ["bun", "run", "test:browser"],
  ["bun", "run", "test:integration"],
  ["bun", "test"],
  ["bun", "install"],
  ["git", "add"],
  ["git", "commit"],
  ["git", "branch", "--show-current"],
];

const startsWith = (words: string[], prefix: string[]): boolean =>
  prefix.every((word, index) => words[index] === word);

const simpleAllowed = (words: string[], role: Role): boolean => {
  const [program, sub] = words;
  if (program === undefined) return false;
  if (READ_ONLY.includes(program)) return true;
  if (program === "git" && sub !== undefined && GIT_READ.includes(sub)) return true;
  return role === "dev" && DEV_RUN.some((prefix) => startsWith(words, prefix));
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

export const decide = (
  request: Record<string, unknown>,
  context: { role: Role; worktree: string },
): Decision => {
  const { role, worktree } = context;
  const call = toolCallOf(request);
  if (call === undefined) return { decision: "ask", reason: "no tool call in the request" };
  const kind = typeof call.kind === "string" ? call.kind : "other";
  const readOnlyRole = role === "qa";
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
      if (readOnlyRole) return { decision: "deny", reason: "QA is read-only" };
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
      if (segments === undefined || segments.length === 0)
        return other("a command with shell syntax the policy does not read");
      for (const words of segments) {
        if (!simpleAllowed(words, role)) return other("a command outside the allowlist");
        if (words.some((word) => wanders(word, worktree)))
          return other("a command that reaches outside the worktree");
      }
      return { decision: "allow", reason: "an allowlisted command" };
    }
    default:
      return other(`a ${kind} request`);
  }
};

type Option = { optionId?: unknown; kind?: unknown };

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
