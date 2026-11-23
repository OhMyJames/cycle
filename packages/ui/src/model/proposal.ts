// What a permission request asks to do, read from the tool call it carries, so the person sees it before they answer:
// the change an edit would make, the command a shell call would run, or else what the call was given. A request comes
// before the call runs, so there is no result yet: an edit's change is worked out here from its input, under the names
// Claude's file tools use (`file_path`, `old_string`/`new_string`, `edits`, `content`). A tool that names them otherwise
// shows its input, which is still all it asks.
import type { DiffLine } from "./facts.ts";

export type Proposal =
  | {
      kind: "edit";
      path: string;
      /** A whole file written: what was there is not known, so every line reads as added. */
      whole: boolean;
      /** Every occurrence of the text is replaced (`replace_all`), not only the one drawn. */
      everywhere: boolean;
      lines: DiffLine[];
      additions: number;
      deletions: number;
    }
  | {
      kind: "command";
      command: string;
      description?: string;
      /** What else the call was given (a timeout, a flag that leaves the sandbox): it is part of what is allowed. */
      rest?: Record<string, unknown>;
    }
  | { kind: "input"; input: unknown };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Lines of unchanged text kept around a change, as a patch keeps them. */
const CONTEXT = 3;
/** Past this many line pairs, the change is not worked out line by line: it is drawn as all removed, then all added. */
const MAX_CELLS = 1_000_000;

type Op = { kind: "add" | "del" | "context"; text: string };

/** A text's lines. Its last line break is dropped only when `trim`: otherwise "x\n" and "x" differ by a line, as they do. */
const splitLines = (text: string, trim: boolean): string[] =>
  text === "" ? [] : (trim ? text.replace(/\n$/, "") : text).split("\n");

/** The lines of `before` and `after` as removed, added and kept, by their longest common run of lines. */
const operations = (before: string[], after: string[]): Op[] => {
  // The lines the two share at their start and end are kept as they are, and only what lies between is compared.
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  const a = before.slice(head, before.length - tail);
  const b = after.slice(head, after.length - tail);
  const middle: Op[] = [];
  if (a.length * b.length > MAX_CELLS) {
    for (const text of a) middle.push({ kind: "del", text });
    for (const text of b) middle.push({ kind: "add", text });
  } else {
    // lengths[i][j]: the longest common run of a[i..] and b[j..], one row at a time.
    const width = b.length + 1;
    const lengths = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        lengths[i * width + j] =
          a[i] === b[j]
            ? (lengths[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(lengths[(i + 1) * width + j] ?? 0, lengths[i * width + j + 1] ?? 0);
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        middle.push({ kind: "context", text: a[i] ?? "" });
        i++;
        j++;
      } else if (
        i < a.length &&
        (j === b.length || (lengths[(i + 1) * width + j] ?? 0) >= (lengths[i * width + j + 1] ?? 0))
      ) {
        // On a tie the removed line goes first: removed lines read before the added ones that take their place.
        middle.push({ kind: "del", text: a[i] ?? "" });
        i++;
      } else {
        middle.push({ kind: "add", text: b[j] ?? "" });
        j++;
      }
    }
  }
  return [
    ...before.slice(0, head).map((text): Op => ({ kind: "context", text })),
    ...middle,
    ...before.slice(before.length - tail).map((text): Op => ({ kind: "context", text })),
  ];
};

/**
 * A change as lines to draw: what changed, with a few unchanged lines around each part; a gap between parts is a hunk
 * mark. The lines carry no numbers: an edit names text, not where in the file it is.
 */
export const lineDiff = (before: string, after: string): DiffLine[] => {
  // A last line break both have, or that a new text has, is not a line of its own.
  const trim = before === "" || before.endsWith("\n") === after.endsWith("\n");
  const ops = operations(splitLines(before, trim), splitLines(after, trim));
  const near = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, at) => {
    if (op.kind === "context") return;
    for (let k = Math.max(0, at - CONTEXT); k <= Math.min(ops.length - 1, at + CONTEXT); k++)
      near[k] = true;
  });
  const lines: DiffLine[] = [];
  let skipped = false;
  ops.forEach((op, at) => {
    if (!near[at]) {
      skipped = true;
      return;
    }
    if (skipped && lines.length > 0) lines.push({ kind: "hunk", text: "", id: `h${lines.length}` });
    skipped = false;
    lines.push({ kind: op.kind, text: op.text, id: `${op.kind[0]}${lines.length}` });
  });
  return lines;
};

const edited = (
  path: string,
  whole: boolean,
  everywhere: boolean,
  lines: DiffLine[],
): Proposal => ({
  kind: "edit",
  path,
  whole,
  everywhere,
  lines,
  additions: lines.filter((line) => line.kind === "add").length,
  deletions: lines.filter((line) => line.kind === "del").length,
});

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** What a tool call in a permission request asks to do. Nothing, when it has no input to show. */
export const proposalOf = (call: { rawInput?: unknown }): Proposal | undefined => {
  const input = call.rawInput;
  if (!isObject(input)) return input === undefined ? undefined : { kind: "input", input };
  const command = text(input.command);
  if (command !== undefined && command !== "") {
    const description = text(input.description)?.trim();
    const rest = Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== "command" && key !== "description"),
    );
    return {
      kind: "command",
      command,
      ...(description ? { description } : {}),
      ...(Object.keys(rest).length > 0 ? { rest } : {}),
    };
  }
  const path = text(input.file_path);
  if (path !== undefined) {
    const [before, after] = [text(input.old_string), text(input.new_string)];
    if (before !== undefined && after !== undefined)
      return edited(path, false, input.replace_all === true, lineDiff(before, after));
    if (Array.isArray(input.edits)) {
      const everywhere = input.edits.some((edit) => isObject(edit) && edit.replace_all === true);
      const parts = input.edits.flatMap((edit) => {
        if (!isObject(edit)) return [];
        const [from, to] = [text(edit.old_string), text(edit.new_string)];
        return from !== undefined && to !== undefined ? [lineDiff(from, to)] : [];
      });
      if (parts.length > 0) {
        const lines = parts.flatMap((part, at) =>
          at === 0 ? part : [{ kind: "hunk" as const, text: "", id: "" }, ...part],
        );
        return edited(
          path,
          false,
          everywhere,
          lines.map((line, at) => ({ ...line, id: `${line.kind[0]}${at}` })),
        );
      }
    }
    const content = text(input.content);
    if (content !== undefined) return edited(path, true, false, lineDiff("", content));
  }
  return Object.keys(input).length > 0 ? { kind: "input", input } : undefined;
};
