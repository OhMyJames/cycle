// What a finished file tool call amounts to, for its line: the edit it made, the lines it read, how much a search found.
// Read from ACP's own fields (a `diff` in the content) and Cycle's `_meta["cycle/toolResult"]` (docs/protocol.md §9),
// never from a tool's name or an agent's own output. Each is optional: a call from an older log, or from another agent, has none of them,
// and its line stays as it was.
import type { Block, ToolItem } from "./conversation.ts";

/** A line of a diff to draw, with its number: in the new file, or for a removed line in the old one. */
export type DiffLine = {
  kind: "add" | "del" | "context" | "hunk";
  text: string;
  line?: number;
  /** Unique in its diff, for a list's key: the same text can be on two lines. */
  id: string;
};

export type ToolFacts = {
  /** The change this call made: its own lines, not the file's whole history. */
  edit?: {
    created: boolean;
    additions: number;
    deletions: number;
    /** The patch as lines to draw; absent when the agent sent only the counts (a very large file). */
    lines?: DiffLine[];
    /** Held for review instead of written: the file is as it was. */
    staged: boolean;
  };
  /** A read of part of a file: its first line, how many, and of how many. */
  read?: { start: number; count: number; total?: number };
  /** A search: files found, and matches or lines where it counted them. */
  search?: { files: number; matches?: number; lines?: number; more: boolean };
  /** A page fetched: its HTTP status and size. */
  fetch?: { status: number; bytes?: number };
  /** Addresses a call gave back (a web search's hits): a title and an address each, never a page. */
  links: { key: string; uri: string; name: string }[];
  /** How a command ended, when the agent said (docs/protocol.md §9 `run`). */
  run?: {
    interrupted: boolean;
    timedOutMs?: number;
    background: boolean;
    exitCode?: number;
    durationMs?: number;
  };
  /** Pictures in the result (a Read of an image, an MCP screenshot), each with a key for its list. */
  images: { key: string; block: Block }[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** The lines of a git patch to draw: the hunks, without the file headers above the first. */
export const diffLines = (patch: string): DiffLine[] => {
  const lines: DiffLine[] = [];
  let inHunk = false;
  let before = 0;
  let after = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      inHunk = true;
      before = Number(hunk[1]);
      after = Number(hunk[2]);
      lines.push({ kind: "hunk", text: line, id: `h${lines.length}` });
      continue;
    }
    if (!inHunk) continue;
    const at = lines.length;
    if (line.startsWith("+")) {
      lines.push({ kind: "add", text: line.slice(1), line: after, id: `a${at}` });
      after++;
    } else if (line.startsWith("-")) {
      lines.push({ kind: "del", text: line.slice(1), line: before, id: `d${at}` });
      before++;
    } else if (line.startsWith(" ")) {
      lines.push({ kind: "context", text: line.slice(1), line: after, id: `c${at}` });
      before++;
      after++;
    }
  }
  return lines;
};

/** One part of the call's `_meta["cycle/toolResult"]` (docs/protocol.md §9), when it is there and an object. */
const resultPart = (
  tool: ToolItem,
  part: "edit" | "read" | "search" | "run" | "fetch",
): Record<string, unknown> => {
  const result = tool.result;
  return isObject(result) && isObject(result[part]) ? result[part] : {};
};

/** An edit: ACP's `diff` content, with its counts from the result or, without them, from its patch. */
const editOf = (tool: ToolItem): ToolFacts["edit"] => {
  const diff = tool.content.find((block) => block.type === "diff");
  if (diff === undefined) return undefined;
  const changes = Array.isArray(diff.changes) ? diff.changes : [];
  const said = resultPart(tool, "edit");
  const created =
    said.created === true ||
    changes.some((change) => isObject(change) && change.operation === "add");
  const patch =
    isObject(diff.patch) && typeof diff.patch.text === "string" ? diff.patch.text : undefined;
  const lines = patch !== undefined ? diffLines(patch) : undefined;
  const additions = num(said.additions) ?? lines?.filter((l) => l.kind === "add").length;
  const deletions = num(said.deletions) ?? lines?.filter((l) => l.kind === "del").length;
  if (additions === undefined || deletions === undefined) return undefined;
  return {
    created,
    additions,
    deletions,
    ...(lines !== undefined ? { lines } : {}),
    staged: said.staged === true,
  };
};

const readOf = (tool: ToolItem): ToolFacts["read"] => {
  const said = resultPart(tool, "read");
  const [start, count, total] = [num(said.startLine), num(said.numLines), num(said.totalLines)];
  if (start === undefined || count === undefined) return undefined;
  return { start: Math.max(1, start), count, ...(total !== undefined ? { total } : {}) };
};

const searchOf = (tool: ToolItem): ToolFacts["search"] => {
  const said = resultPart(tool, "search");
  const files = num(said.files);
  if (files === undefined) return undefined;
  const [matches, lines] = [num(said.matches), num(said.lines)];
  return {
    files,
    ...(matches !== undefined ? { matches } : {}),
    ...(lines !== undefined ? { lines } : {}),
    more: said.more === true,
  };
};

const runOf = (tool: ToolItem): ToolFacts["run"] => {
  const result = tool.result;
  if (!isObject(result) || !isObject(result.run)) return undefined;
  const said = result.run;
  const timedOutMs = num(said.timedOutMs);
  const exitCode = num(said.exitCode);
  const durationMs = num(said.durationMs);
  return {
    interrupted: said.interrupted === true,
    ...(timedOutMs !== undefined ? { timedOutMs } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    background: said.background === true,
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
};

/**
 * What a call printed, as text: what it printed as errors apart, when the agent told them apart (a text item whose
 * `_meta["cycle/stream"]` is "stderr", docs/protocol.md §9). Images are not text and are left to `toolFacts`.
 */
export const streamsOf = (tool: ToolItem): { out: string; err: string } => {
  let out = "";
  let err = "";
  for (const block of tool.content) {
    const inner =
      block.type === "content" && isObject(block.content) ? (block.content as Block) : block;
    if (inner.type !== "text") continue;
    const meta = isObject(block._meta) ? block._meta : {};
    if (meta["cycle/stream"] === "stderr") err += String(inner.text ?? "");
    else out += String(inner.text ?? "");
  }
  return { out, err };
};

const fetchOf = (tool: ToolItem): ToolFacts["fetch"] => {
  const said = resultPart(tool, "fetch");
  const status = num(said.status);
  if (status === undefined) return undefined;
  const bytes = num(said.bytes);
  return { status, ...(bytes !== undefined ? { bytes } : {}) };
};

/** The facts of a call. Only a completed call has them: a failed one's text is what it says. */
export const toolFacts = (tool: ToolItem): ToolFacts => {
  const images: ToolFacts["images"] = [];
  const links: ToolFacts["links"] = [];
  for (const [index, block] of tool.content.entries()) {
    const inner =
      block.type === "content" && isObject(block.content) ? (block.content as Block) : block;
    if (inner.type === "image") images.push({ key: `image-${index}`, block: inner });
    if (inner.type === "resource_link" && typeof inner.uri === "string") {
      const name = typeof inner.name === "string" && inner.name !== "" ? inner.name : inner.uri;
      links.push({ key: `link-${index}`, uri: inner.uri, name });
    }
  }
  // How a command ended, and a page's status, are said for a call that failed too: they are why.
  if (tool.status === "failed") {
    const [run, fetch] = [runOf(tool), fetchOf(tool)];
    return {
      images,
      links,
      ...(run !== undefined ? { run } : {}),
      ...(fetch !== undefined ? { fetch } : {}),
    };
  }
  if (tool.status !== "completed") return { images, links };
  const facts: ToolFacts = { images, links };
  // By what the agent sent, never by the tool's name: another agent's edit or search says the same in the same fields.
  const [edit, read, search, run] = [editOf(tool), readOf(tool), searchOf(tool), runOf(tool)];
  if (edit !== undefined) facts.edit = edit;
  if (run !== undefined) facts.run = run;
  const fetch = fetchOf(tool);
  if (fetch !== undefined) facts.fetch = fetch;
  if (read !== undefined) facts.read = read;
  if (search !== undefined) facts.search = search;
  return facts;
};
