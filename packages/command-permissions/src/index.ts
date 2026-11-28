/** Shell programs that run other commands or are too wide to remember by their name: never remembered. */
const UNREMEMBERABLE_PROGRAMS = new Set([
  "sudo",
  "su",
  "doas",
  "env",
  "sh",
  "bash",
  "zsh",
  "fish",
  "eval",
  "exec",
  "xargs",
  "nohup",
  "time",
  "command",
  "builtin",
  "watch",
  "timeout",
  "rm",
  "dd",
  "ssh",
  "source",
  ".",
  "python",
  "python3",
  "node",
  "deno",
  "bun",
  "bunx",
  "npx",
  "perl",
  "ruby",
  "php",
  "awk",
  "find",
  "curl",
  "wget",
  "mv",
  "chmod",
  "chown",
  "kill",
  "docker",
  "osascript",
  "open",
  "tee",
]);

/**
 * The rule a shell command is remembered by: one prefix per segment of a `|` / `&&` / `||` / `;` chain (the program
 * and, when it is a plain word, its subcommand: `git status`). Undefined when it cannot be judged by segments:
 * a substitution, a redirect, a newline or a program that runs others.
 */
export const commandPrefixes = (command: string): string[] | undefined => {
  // A lone `&` (background), a group, a negation, a substitution, a redirect or a newline: not judged by segments.
  if (/[`\n\r<>(){}!\\]|\$[({]/.test(command) || /(^|[^&])&([^&]|$)/.test(command))
    return undefined;
  const prefixes: string[] = [];
  for (const segment of command.split(/&&|\|\||[|;]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    const program = words[0];
    if (program === undefined || /^\w+=/.test(program)) return undefined;
    if (UNREMEMBERABLE_PROGRAMS.has(program.split("/").pop() ?? program)) return undefined;
    // The program, the flags straight after it, and the plain word that follows: `git status`, `git -C repo`.
    // Flags are part of the prefix but the word after them is not taken (`git -C repo status` and
    // `git -C repo push` are both `git -C repo`).
    let end = 1;
    while (words[end]?.startsWith("-")) end += 1;
    if (/^[a-z][\w-]*$/i.test(words[end] ?? "")) end += 1;
    prefixes.push(words.slice(0, end).join(" "));
  }
  return prefixes.length > 0 ? prefixes : undefined;
};
