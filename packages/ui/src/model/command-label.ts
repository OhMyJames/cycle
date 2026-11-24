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
    // `&` in `&>` belongs to the redirection (`>&`, `>|` and `2>&1` are taken whole below).
    const inRedirection = separator === "&" && command[i + 1] === ">";
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
  ls: [
    "-I",
    "--ignore",
    "-w",
    "--width",
    "--hide",
    "-T",
    "--tabsize",
    "--format",
    "--sort",
    "--time",
    "--time-style",
    "--block-size",
    "--quoting-style",
    "--indicator-style",
    "--color",
  ],
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

/**
 * A flag given: a short one alone, with its value joined, or bundled with others (`-o`, `-ofile`, `-uo`), or a long one
 * alone or with its value (`--output`, `--output=file`).
 */
const given = (args: readonly string[], short: string | undefined, long: string): boolean =>
  args.some(
    (a) =>
      a === long ||
      a.startsWith(`${long}=`) ||
      (short !== undefined && /^-[A-Za-z]/.test(a) && a.slice(1).includes(short)),
  );

const SEARCHES = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack"]);
const READS = new Set(["cat", "head", "tail", "sed", "nl", "bat"]);
const LISTS = new Set(["ls", "tree", "find"]);
/** Say nothing of what the command does, wherever they are. */
const QUIET = new Set(["echo", "printf", "true", ":", "pwd"]);
/** After a pipe, only trim what they are handed: unless told to write (`sort -o`, `uniq in out`). */
const TRIMS = new Set(["head", "tail", "sort", "uniq", "wc", "cut", "nl", "cat", "tr"]);
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
/** A `sed -n` script that only prints lines: `p`, `5p`, `1,40p`, `$p`; `/re/p` is not one (it could hide `w`). */
const PRINT_ONLY = /^\s*(?:(?:\d+|\$)\s*(?:,\s*(?:\d+|\$)\s*)?)?p\s*$/;

/** A part after a pipe that only trims what it is handed. */
const trims = (words: readonly string[]): boolean => {
  const [program = "", ...args] = words;
  if (!TRIMS.has(program)) return false;
  if (program === "sort" && given(args, "o", "--output")) return false;
  if (program === "uniq" && operands(args).plain.length > 1) return false;
  return true;
};

/** One part's label, before parts are put together: what it searched for, or the files or places it read or listed. */
type Found = { kind: CommandLabel["kind"]; items: string[] };

const foundOf = (words: readonly string[]): Found | undefined => {
  const [program = "", ...args] = words;
  if (SEARCHES.has(program)) {
    // `rg --files` lists the files it would search.
    if (program === "rg" && args.includes("--files")) {
      const { plain } = operands(args, TAKES_VALUE.rg);
      return { kind: "list", items: plain.length > 0 ? plain : ["."] };
    }
    // Patterns from a file are not said; `--pre` runs a program on every file.
    if (given(args, "f", "--file") || given(args, undefined, "--pre")) return undefined;
    const { plain, patterns } = operands(args, TAKES_VALUE[program === "rg" ? "rg" : "grep"]);
    const pattern = patterns[0] ?? plain.shift();
    if (pattern === undefined) return undefined;
    return {
      kind: "search",
      items: [plain.length > 0 ? `'${pattern}' in ${some(plain)}` : `'${pattern}'`],
    };
  }
  if (READS.has(program)) {
    let files: string[];
    if (program === "sed") {
      // Only a plain print, with `-n`, changes nothing: `-i` edits, `w` writes, `e` runs, a script file is not read.
      if (
        !given(args, "n", "--quiet") ||
        given(args, "i", "--in-place") ||
        given(args, "f", "--file")
      )
        return undefined;
      const { plain, patterns } = operands(args);
      const scripts = patterns.length > 0 ? patterns : plain.slice(0, 1);
      if (
        scripts.length === 0 ||
        !scripts.every((s) => s.split(";").every((c) => PRINT_ONLY.test(c)))
      )
        return undefined;
      files = patterns.length > 0 ? plain : plain.slice(1);
    } else files = operands(args, TAKES_VALUE[program]).plain;
    return files.length === 0 ? undefined : { kind: "read", items: files };
  }
  if (LISTS.has(program)) {
    let paths: string[];
    if (program === "find") {
      if (args.some((a) => FIND_ACTS.has(a))) return undefined;
      // Its own options first (`-L`, `-D tree`), then its paths, up to its first test.
      let at = 0;
      while (at < args.length && /^-([HLP]|O\d*|D)$/.test(args[at] as string))
        at += args[at] === "-D" ? 2 : 1;
      const rest = args.slice(at);
      const first = rest.findIndex((a) => /^[-(!]/.test(a));
      paths = first === -1 ? rest : rest.slice(0, first);
    } else {
      // `tree -o` writes what it lists to a file.
      if (program === "tree" && given(args, "o", "--output")) return undefined;
      paths = operands(args, TAKES_VALUE[program]).plain;
    }
    return { kind: "list", items: paths.length > 0 ? paths : ["."] };
  }
  return undefined;
};

const SHELLS = new Set([
  "sh",
  "bash",
  "zsh",
  "/bin/sh",
  "/bin/bash",
  "/bin/zsh",
  "/usr/bin/bash",
  "/usr/bin/zsh",
]);
const SHELL_C_FLAGS = new Set(["-c", "-lc", "-cl"]);

/** Unwrap a single `/bin/zsh -lc "..."` shell wrapper (as Codex emits) when there is no redirection or pipeline around it. */
const unwrapShell = (command: string): string => {
  const parsed = partsOf(command);
  if (parsed === undefined || parsed.writes || parsed.parts.length !== 1) return command;
  const words = parsed.parts[0]?.words ?? [];
  if (
    words.length === 3 &&
    SHELLS.has(words[0] ?? "") &&
    SHELL_C_FLAGS.has(words[1] ?? "") &&
    (words[2] ?? "").trim() !== ""
  )
    return words[2] as string;
  return command;
};

const read = (command: string): CommandLabel | undefined => {
  const effective = unwrapShell(command);
  if (NESTED.test(effective)) return undefined;
  const parsed = partsOf(effective);
  if (parsed === undefined || parsed.writes) return undefined;
  const found: Found[] = [];
  for (const { words, after } of parsed.parts) {
    const program = words[0] ?? "";
    // A program named by a path (`./ls`, `scripts/cat`) is the project's own, whatever it is called.
    if (program.includes("/")) return undefined;
    // `cd` somewhere: what follows is read from there, which the label would not say.
    if (program === "cd") {
      if (words.length > 1) return undefined;
      continue;
    }
    if (QUIET.has(program) || (after === "|" && trims(words))) continue;
    const part = foundOf(words);
    if (part === undefined) return undefined;
    found.push(part);
  }
  const [first] = found;
  if (first === undefined || found.some((part) => part.kind !== first.kind)) return undefined;
  const items = [...new Set(found.flatMap((part) => part.items))];
  const shown = first.kind === "read" ? [...new Set(items.map(name))] : items;
  return { kind: first.kind, detail: some(shown), count: items.length };
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
