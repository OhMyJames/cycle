// What a shell command plainly does, read from the command, for a row the agent gave no description: `rg foo src` is a
// search for 'foo' in src, `cat a.ts` reads a.ts, `ls src` lists src. Only a command every part of which searches, reads
// or lists, all the same way, and that writes and runs nothing else, is named; any other is quoted as it is. When in
// doubt it is quoted: a reassuring verb over a command that writes would hide the one thing to see. The rules are
// old-cycle's (`acp/command-label.ts`): substitution, a write to a file, `sed` that is not a plain print, and a `find`
// that acts are never read as harmless; `echo` and the like say nothing; `head`, `wc` and the like after a pipe only
// trim.

/** What a command did, the words for what it acted on, and how many things it acted on (files read, searches). */
export type CommandLabel = { kind: "search" | "read" | "list"; detail: string; count: number };

/** One program and its words, and what joined it to the one before (`|`, `&&`, `;`, or nothing for the first). */
type Part = { words: string[]; after: string };

const SEPARATORS = ["&&", "||", "|", ";", "&", "\n"];

/** Command or process substitution, or a here-document: a command inside the command, or text that is not read. */
const NESTED = /\$\(|`|<\(|>\(|<</;

/** The command's parts, and whether it writes to a file. Nothing when it cannot be read. */
const partsOf = (command: string): { parts: Part[]; writes: boolean } | undefined => {
  const parts: Part[] = [{ words: [], after: "" }];
  let writes = false;
  let text = "";
  let has = false;
  /** A redirection waiting for its target: the next word. */
  let redirect: string | undefined;
  const end = () => {
    if (!has) return;
    const word = text;
    text = "";
    has = false;
    if (redirect !== undefined) {
      if (redirect !== "<" && word !== "/dev/null") writes = true;
      redirect = undefined;
    } else parts.at(-1)?.words.push(word);
  };
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string;
    // A line continued: the two characters are nothing.
    if (char === "\\" && command[i + 1] === "\n") {
      i++;
      continue;
    }
    // A comment, to the end of its line.
    if (char === "#" && !has) {
      const line = command.indexOf("\n", i);
      if (line === -1) break;
      i = line - 1;
      continue;
    }
    const separator = SEPARATORS.find((s) => command.startsWith(s, i));
    // `&` in `2>&1` or `&>` belongs to a redirection; `|` in `>|` too.
    const inRedirection =
      (separator === "&" && /[<>]/.test(`${command[i - 1] ?? ""}${command[i + 1] ?? ""}`)) ||
      (separator === "|" && command[i - 1] === ">");
    if (separator !== undefined && !inRedirection) {
      end();
      // A redirection with no target is not a command to read.
      if (redirect !== undefined) return undefined;
      parts.push({ words: [], after: separator });
      i += separator.length - 1;
    } else if (char === ">" || char === "<") {
      // The stream it is of (`2>`, `&>`) is part of it, not a word.
      if (has && /^(\d+|&)$/.test(text)) {
        text = "";
        has = false;
      } else end();
      let operator = char;
      if (char === ">" && command[i + 1] === ">") {
        operator = ">>";
        i++;
      } else if (char === ">" && command[i + 1] === "|") i++;
      if (command[i + 1] === "&") {
        i++;
        // `>&2`, `2>&1`, `>&-`: one stream sent to another, or closed. Nothing written.
        const stream = /^(\d+|-)/.exec(command.slice(i + 1));
        if (stream !== null) {
          i += stream[0].length;
          continue;
        }
        // `>&file` writes the file.
      }
      redirect = operator;
    } else if (char === " " || char === "\t") end();
    else if (char === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return undefined;
      text += command.slice(i + 1, close);
      has = true;
      i = close;
    } else if (char === '"') {
      let j = i + 1;
      for (; j < command.length && command[j] !== '"'; j++)
        text += command[j] === "\\" ? (command[++j] ?? "") : command[j];
      if (j >= command.length) return undefined;
      has = true;
      i = j;
    } else if (char === "\\") {
      text += command[++i] ?? "";
      has = true;
    } else {
      text += char;
      has = true;
    }
  }
  end();
  if (redirect !== undefined) return undefined;
  return { parts: parts.filter((part) => part.words.length > 0), writes };
};

const name = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;

/** A few of them, then how many more. */
const some = (items: string[]): string => {
  const unique = [...new Set(items)];
  return unique.length > 3
    ? `${unique.slice(0, 3).join(", ")} +${unique.length - 3}`
    : unique.join(", ");
};

/** Each program's flags whose value is the next word, so it is no path or pattern. */
const TAKES_VALUE: Record<string, readonly string[]> = {
  rg: [
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
    "-r",
    "--replace",
    "-E",
    "--encoding",
    "--iglob",
    "--max-depth",
    "-d",
    "--max-filesize",
    "--colors",
    "--color",
    "--context-separator",
    "--field-match-separator",
    "--path-separator",
    "--type-add",
    "--ignore-file",
    "--engine",
  ],
  grep: [
    "-m",
    "--max-count",
    "-A",
    "-B",
    "-C",
    "--include",
    "--exclude",
    "--exclude-dir",
    "-d",
    "--directories",
    "-D",
    "--devices",
    "--label",
    "--color",
    "--colour",
  ],
  head: ["-n", "-c"],
  tail: ["-n", "-c"],
  tree: ["-L", "-I", "-P", "--filelimit", "--charset", "--sort"],
};

/** The words that are not flags (nor flags' values), and the patterns given with `-e`. */
const operands = (
  args: readonly string[],
  takesValue: readonly string[] = [],
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
    else if (arg.startsWith("--regexp=")) patterns.push(arg.slice("--regexp=".length));
    else if (takesValue.includes(arg)) i++;
    else if (arg === "-" || !arg.startsWith("-")) plain.push(arg);
  }
  return { plain, patterns };
};

/** A flag given, alone or with its value joined (`-o`, `-ofile`, `--output`, `--output=file`). */
const given = (args: readonly string[], short: string | undefined, long: string): boolean =>
  args.some(
    (a) =>
      a === long ||
      a.startsWith(`${long}=`) ||
      (short !== undefined && (a === short || (a.startsWith(short) && !a.startsWith("--")))),
  );

const SEARCHES = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack"]);
const READS = new Set(["cat", "head", "tail", "sed", "nl", "less", "bat"]);
const LISTS = new Set(["ls", "tree", "find"]);
/** Say nothing of what the command does, wherever they are. */
const QUIET = new Set(["echo", "printf", "true", ":", "pwd"]);
/** After a pipe, only trim what they are handed: unless told to write (`sort -o`, `uniq in out`). */
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
/** `find`'s own options, before its paths. */
const FIND_FIRST = /^-([HLP]|D|O\d*)$/;
/** A `sed -n` script that only prints lines: `p`, `5p`, `1,40p`, `$p`, `/re/p` is not one (it could hide `w`). */
const PRINT_ONLY = /^\s*(?:(?:\d+|\$)\s*(?:,\s*(?:\d+|\$)\s*)?)?p\s*$/;

/** A part after a pipe that only trims what it is handed. */
const trims = (words: readonly string[]): boolean => {
  const [program = "", ...args] = words;
  const tool = name(program);
  if (!TRIMS.has(tool)) return false;
  if (tool === "sort" && given(args, "-o", "--output")) return false;
  if (tool === "uniq" && operands(args).plain.length > 1) return false;
  return true;
};

const labelOf = (words: readonly string[]): CommandLabel | undefined => {
  const [program = "", ...args] = words;
  const tool = name(program);
  if (SEARCHES.has(tool)) {
    // Patterns from a file are not said; `--pre` runs a program on every file.
    if (given(args, "-f", "--file") || given(args, undefined, "--pre")) return undefined;
    const { plain, patterns } = operands(args, TAKES_VALUE[tool === "rg" ? "rg" : "grep"]);
    const pattern = patterns[0] ?? plain.shift();
    if (pattern === undefined) return undefined;
    const detail = plain.length > 0 ? `'${pattern}' in ${some(plain)}` : `'${pattern}'`;
    return { kind: "search", detail, count: 1 };
  }
  if (READS.has(tool)) {
    let files: string[];
    if (tool === "sed") {
      // Only a plain print, with `-n`, changes nothing: `-i` edits, `w` writes, `e` runs, a script file is not read.
      if (
        !args.includes("-n") ||
        args.some(
          (a) => /^-[^-]*[if]/.test(a) || a.startsWith("--in-place") || a.startsWith("--file"),
        )
      )
        return undefined;
      const { plain, patterns } = operands(args.filter((a) => a !== "-n"));
      const scripts = patterns.length > 0 ? patterns : plain.slice(0, 1);
      if (
        scripts.length === 0 ||
        !scripts.every((s) => s.split(";").every((c) => PRINT_ONLY.test(c)))
      )
        return undefined;
      files = patterns.length > 0 ? plain : plain.slice(1);
    } else files = operands(args, TAKES_VALUE[tool]).plain;
    return files.length === 0
      ? undefined
      : { kind: "read", detail: some(files.map(name)), count: new Set(files).size };
  }
  if (LISTS.has(tool)) {
    let paths: string[];
    if (tool === "find") {
      if (args.some((a) => FIND_ACTS.has(a))) return undefined;
      const options = args.findIndex((a) => !FIND_FIRST.test(a));
      const rest = options === -1 ? [] : args.slice(options);
      // Its paths come before its first test.
      const first = rest.findIndex((a) => /^[-(!]/.test(a));
      paths = first === -1 ? rest : rest.slice(0, first);
    } else {
      // `tree -o` writes what it lists to a file.
      if (tool === "tree" && given(args, "-o", "--output")) return undefined;
      paths = operands(args, TAKES_VALUE[tool]).plain;
    }
    return paths.length > 0
      ? { kind: "list", detail: some(paths), count: new Set(paths).size }
      : { kind: "list", detail: ".", count: 1 };
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
    // `cd` somewhere: what follows is read from there, which the label would not say.
    if (tool === "cd") {
      if (words.length > 1) return undefined;
      continue;
    }
    if (QUIET.has(tool) || (after === "|" && trims(words))) continue;
    const label = labelOf(words);
    if (label === undefined) return undefined;
    labels.push(label);
  }
  const [first] = labels;
  if (first === undefined || labels.some((label) => label.kind !== first.kind)) return undefined;
  if (labels.length === 1) return first;
  return {
    kind: first.kind,
    detail: labels.map((label) => label.detail).join(", "),
    count: labels.reduce((sum, label) => sum + label.count, 0),
  };
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
