// What a shell command plainly does, read from the command, for a row the agent gave no description: `rg foo src` is a
// search for 'foo' in src, `cat a.ts` reads a.ts, `ls src` lists src. Only a command every part of which searches, reads
// or lists, all the same way, and writes nothing, is named; any other is quoted as it is. The rules are old-cycle's
// (`acp/command-label.ts`): substitution, a write to a file, `sed` without `-n` or with `-i`, and a `find` that acts are
// never read as harmless; `cd`, `echo` and the like say nothing; `head`, `wc` and the like after a pipe only trim.

export type CommandLabel = { kind: "search" | "read" | "list"; detail: string };

/** A word of the command, and whether it was quoted: a quoted `|` or `>` is a word, not an operator. */
type Word = { text: string; quoted: boolean };
/** One program and its words, and what joined it to the one before (`|`, `&&`, `;`, or nothing for the first). */
type Part = { words: string[]; after: string };

const SEPARATORS = ["&&", "||", "|", ";", "&", "\n"];

/** Command substitution or process substitution: a command inside the command, which is not read. */
const NESTED = /\$\(|`|<\(|>\(/;

/** The command's parts, and whether it writes to a file. Nothing when it cannot be read safely. */
const partsOf = (command: string): { parts: Part[]; writes: boolean } | undefined => {
  const parts: Part[] = [{ words: [], after: "" }];
  let writes = false;
  let word: Word | undefined;
  /** A redirection whose target is the next word. */
  let redirect: string | undefined;
  const end = () => {
    if (word === undefined) return;
    const { text, quoted } = word;
    word = undefined;
    if (redirect !== undefined) {
      if (redirect !== "<" && text !== "/dev/null") writes = true;
      redirect = undefined;
      return;
    }
    const at = quoted ? null : /^(\d*|&)(>>?|<)(&?)(.*)$/.exec(text);
    if (at !== null) {
      const [, , operator = "", dup = "", target = ""] = at;
      // `2>&1` sends one stream to another: nothing written.
      if (dup !== "") return;
      if (target === "") redirect = operator;
      else if (operator !== "<" && target !== "/dev/null") writes = true;
      return;
    }
    parts.at(-1)?.words.push(text);
  };
  const add = (text: string, quoted = false) => {
    word = { text: (word?.text ?? "") + text, quoted: (word?.quoted ?? false) || quoted };
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    const separator = SEPARATORS.find((s) => command.startsWith(s, i));
    // `&` in `2>&1` or `&>` is a redirection's.
    const redirection =
      separator === "&" && /[<>]/.test(`${command[i - 1] ?? ""}${command[i + 1] ?? ""}`);
    if (separator !== undefined && !redirection) {
      end();
      parts.push({ words: [], after: separator });
      i += separator.length - 1;
    } else if (char === " " || char === "\t") end();
    else if (char === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return undefined;
      add(command.slice(i + 1, close), true);
      i = close;
    } else if (char === '"') {
      let text = "";
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++)
        text += command[j] === "\\" ? (command[++j] ?? "") : command[j];
      if (j >= command.length) return undefined;
      add(text, true);
      i = j;
    } else if (char === "\\") add(command[++i] ?? "");
    else add(char);
  }
  end();
  return {
    parts: parts.filter((part) => part.words.length > 0),
    writes: writes || redirect !== undefined,
  };
};

const name = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;

/** A few of them, then how many more. */
const some = (items: string[]): string => {
  const unique = [...new Set(items)];
  return unique.length > 3
    ? `${unique.slice(0, 3).join(", ")} +${unique.length - 3}`
    : unique.join(", ");
};

/** Flags whose value is the next word, so it is no path or pattern. */
const TAKES_VALUE: Record<string, string[]> = {
  search: [
    "-g",
    "--glob",
    "-t",
    "--type",
    "-T",
    "--type-not",
    "-m",
    "--max-count",
    "-A",
    "-B",
    "-C",
    "--context",
    "-M",
    "--max-columns",
    "-j",
    "--threads",
    "--sort",
    "--sortr",
    "--include",
    "--exclude",
    "--exclude-dir",
  ],
  read: ["-n", "-c"],
  list: ["-L", "-I", "-P"],
};

/** The words that are not flags (nor flags' values), and the patterns given with `-e`. */
const operands = (
  args: string[],
  takesValue: string[],
): { plain: string[]; patterns: string[] } => {
  const plain: string[] = [];
  const patterns: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") {
      plain.push(...args.slice(i + 1));
      break;
    }
    if (arg === "-e" || arg === "--regexp") patterns.push(args[++i] ?? "");
    else if (arg.startsWith("--regexp=")) patterns.push(arg.slice(9));
    else if (takesValue.includes(arg)) i++;
    else if (arg === "-" || !arg.startsWith("-")) plain.push(arg);
  }
  return { plain, patterns };
};

const SEARCHES = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack"]);
const READS = new Set(["cat", "head", "tail", "sed", "nl", "less", "bat"]);
const LISTS = new Set(["ls", "tree", "find"]);
/** Say nothing of what the command does, wherever they are. */
const QUIET = new Set(["cd", "echo", "printf", "true", ":", "pwd"]);
/** After a pipe, only trim what they are handed. */
const TRIMS = new Set(["head", "tail", "sort", "uniq", "wc", "cut", "nl", "cat", "tr", "less"]);
/** A `find` with one of these deletes, runs or writes. */
const FIND_ACTS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);

const labelOf = (words: string[]): CommandLabel | undefined => {
  const [program = "", ...args] = words;
  const tool = name(program);
  if (SEARCHES.has(tool)) {
    const { plain, patterns } = operands(args, TAKES_VALUE.search ?? []);
    const pattern = patterns[0] ?? plain.shift();
    if (pattern === undefined) return undefined;
    return {
      kind: "search",
      detail: plain.length > 0 ? `'${pattern}' in ${some(plain)}` : `'${pattern}'`,
    };
  }
  if (READS.has(tool)) {
    // Only `sed -n` prints without changing anything; `-i` edits even then.
    if (
      tool === "sed" &&
      (!args.includes("-n") || args.some((a) => /^(--in-place|-[^-]*i)/.test(a)))
    )
      return undefined;
    const { plain } = operands(
      args,
      tool === "head" || tool === "tail" ? (TAKES_VALUE.read ?? []) : [],
    );
    // `sed` takes its script first, unless `-e` gave it.
    const files = tool === "sed" && !args.includes("-e") ? plain.slice(1) : plain;
    return files.length === 0 ? undefined : { kind: "read", detail: some(files.map(name)) };
  }
  if (LISTS.has(tool)) {
    if (tool === "find") {
      if (args.some((a) => FIND_ACTS.has(a))) return undefined;
      // Its paths come before its first test.
      const first = args.findIndex((a) => /^[-(!]/.test(a));
      const paths = first === -1 ? args : args.slice(0, first);
      return { kind: "list", detail: paths.length > 0 ? some(paths) : "." };
    }
    const { plain } = operands(args, tool === "tree" ? (TAKES_VALUE.list ?? []) : []);
    return { kind: "list", detail: plain.length > 0 ? some(plain) : "." };
  }
  return undefined;
};

const read = (command: string): CommandLabel | undefined => {
  if (NESTED.test(command)) return undefined;
  const parsed = partsOf(command);
  if (parsed === undefined || parsed.writes) return undefined;
  const labels: CommandLabel[] = [];
  for (const { words, after } of parsed.parts) {
    const tool = name(words[0] ?? "");
    if (QUIET.has(tool) || (after === "|" && TRIMS.has(tool))) continue;
    const label = labelOf(words);
    if (label === undefined) return undefined;
    labels.push(label);
  }
  const [first] = labels;
  if (first === undefined || labels.some((label) => label.kind !== first.kind)) return undefined;
  return labels.length === 1
    ? first
    : { kind: first.kind, detail: labels.map((l) => l.detail).join(", ") };
};

/** Rows ask on every render: each command is read once. */
const known = new Map<string, CommandLabel | null>();

/** What a command plainly does, when every part of it searches, reads or lists, the same way, and writes nothing. */
export const commandLabel = (command: string): CommandLabel | undefined => {
  const seen = known.get(command);
  if (seen !== undefined) return seen ?? undefined;
  const label = read(command);
  if (known.size >= 500) known.clear();
  known.set(command, label ?? null);
  return label;
};
