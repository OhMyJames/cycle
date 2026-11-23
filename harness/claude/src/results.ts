// What a finished tool call says, for the tools whose result the SDK also gives as structured data (`tool_use_result`):
// an edit as a `diff` of this one call, a read with the lines it read, a search with how much it found. In ACP's own
// fields where ACP has one (`diff` content, `locations`), and the counts in `_meta["cycle/toolResult"]`
// (docs/protocol.md §9 "工具调用的结果"), which a client that does not know it ignores. The structured data itself never
// goes on: it holds whole files (`originalFile`, `content`, `base64`). docs/conversation-content.md has the table.

type Json = Record<string, unknown>;

/** The `_meta` key of a finished call's counts. `@cycle/protocol`'s `META.toolResult`; the adapter stays self-contained. */
export const TOOL_RESULT_META = "cycle/toolResult";

/** What `_meta["cycle/toolResult"]` holds: one of these, all numbers and flags, never contents. */
export type ToolResultMeta =
  | { edit: { additions: number; deletions: number; created?: true; staged?: true } }
  | { read: { startLine: number; numLines: number; totalLines?: number } }
  | { search: { files: number; matches?: number; lines?: number; more?: true } }
  | {
      run: { interrupted?: true; timedOutMs?: number; background?: true; exitCode?: number };
    }
  | { fetch: { status: number; bytes?: number } };

/** On a text content item: which stream of a command it is, when a command's output and errors are told apart. */
export const STREAM_META = "cycle/stream";

/** ACP v2 tool call content, as far as this file makes it. */
export type Content =
  | {
      type: "content";
      content:
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
        | { type: "resource_link"; uri: string; name: string };
      _meta?: Record<string, unknown>;
    }
  | {
      type: "diff";
      changes: { operation: "add" | "modify"; path: string }[];
      patch?: { format: "git_patch"; text: string } | null;
    };

export type Result = {
  content: Content[];
  /** Absent when ACP's own fields say it all (a search's results are links). */
  meta?: ToolResultMeta;
  locations?: { path: string; line?: number }[];
};

type Hunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

const hunksOf = (value: unknown): Hunk[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const hunks: Hunk[] = [];
  for (const hunk of value) {
    if (!isObject(hunk) || !Array.isArray(hunk.lines)) return undefined;
    const [oldStart, oldLines, newStart, newLines] = [
      num(hunk.oldStart),
      num(hunk.oldLines),
      num(hunk.newStart),
      num(hunk.newLines),
    ];
    if (
      oldStart === undefined ||
      oldLines === undefined ||
      newStart === undefined ||
      newLines === undefined
    )
      return undefined;
    hunks.push({ oldStart, oldLines, newStart, newLines, lines: hunk.lines.map(String) });
  }
  return hunks;
};

/** A patch bigger than this is not sent: the counts and the path still are. A file written whole can be any size. */
export const MAX_PATCH = 100_000;

const header = (path: string, created: boolean): string => {
  const at = path.startsWith("/") ? path : `/${path}`;
  return [`diff --git a${at} b${at}`, created ? "--- /dev/null" : `--- a${at}`, `+++ b${at}`].join(
    "\n",
  );
};

/** The patch of hunks, in git's form. */
const patchOf = (path: string, hunks: Hunk[], created: boolean): string => {
  const parts = [header(path, created)];
  for (const hunk of hunks) {
    parts.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    parts.push(...hunk.lines);
  }
  return `${parts.join("\n")}\n`;
};

const count = (hunks: Hunk[], sign: string): number =>
  hunks.reduce((n, hunk) => n + hunk.lines.filter((line) => line.startsWith(sign)).length, 0);

/** The lines of a text, without the empty one after its last newline. */
const linesOf = (text: string): string[] => {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** How many lines a text has, without splitting it: a file written whole can be any size. */
const lineCount = (text: string): number => {
  if (text === "") return 0;
  let n = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) n++;
  return text.endsWith("\n") ? n : n + 1;
};

const flags = (out: Json, created: boolean) => ({
  ...(created ? { created: true as const } : {}),
  // Held for the machine's owner to review, not written: the file is as it was.
  ...(out.staged === true ? { staged: true as const } : {}),
});

/** A change to a file that has hunks to show. With none (nothing changed, or the SDK's diff gave up) there is no diff. */
const changed = (path: string, hunks: Hunk[], out: Json): Result | undefined => {
  // Held for review with no diff to show: the file is unchanged, and that is what the line must say.
  if (hunks.length === 0 && out.staged === true) {
    return {
      content: [{ type: "diff", changes: [{ operation: "modify", path }], patch: null }],
      meta: { edit: { additions: 0, deletions: 0, staged: true } },
      locations: [{ path }],
    };
  }
  if (hunks.length === 0) return undefined;
  const text = patchOf(path, hunks, false);
  return {
    content: [
      {
        type: "diff",
        changes: [{ operation: "modify", path }],
        patch: text.length <= MAX_PATCH ? { format: "git_patch", text } : null,
      },
    ],
    meta: {
      edit: { additions: count(hunks, "+"), deletions: count(hunks, "-"), ...flags(out, false) },
    },
    locations: [{ path, line: Math.max(1, hunks[0]?.newStart ?? 1) }],
  };
};

const edit = (out: Json): Result | undefined => {
  const hunks = hunksOf(out.structuredPatch);
  if (typeof out.filePath !== "string" || hunks === undefined) return undefined;
  return changed(out.filePath, hunks, out);
};

const write = (out: Json): Result | undefined => {
  if (typeof out.filePath !== "string") return undefined;
  if (out.type === "update") {
    const hunks = hunksOf(out.structuredPatch);
    return hunks === undefined ? undefined : changed(out.filePath, hunks, out);
  }
  if (out.type !== "create" || typeof out.content !== "string") return undefined;
  const path = out.filePath;
  // A file too large to send is counted, never split or copied.
  const small = out.content.length <= MAX_PATCH;
  const lines = small ? linesOf(out.content) : undefined;
  const additions = lines?.length ?? lineCount(out.content);
  const text =
    lines !== undefined && lines.length > 0
      ? patchOf(
          path,
          [
            {
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: lines.length,
              lines: lines.map((l) => `+${l}`),
            },
          ],
          true,
        )
      : undefined;
  return {
    content: [
      {
        type: "diff",
        changes: [{ operation: "add", path }],
        patch:
          text !== undefined && text.length <= MAX_PATCH ? { format: "git_patch", text } : null,
      },
    ],
    meta: { edit: { additions, deletions: 0, ...flags(out, true) } },
    locations: [{ path }],
  };
};

/** One cell's source before and after, as one hunk: a cell has no line numbers in the file worth giving. */
const notebook = (out: Json): Result | undefined => {
  if (typeof out.notebook_path !== "string" || out.error !== undefined) return undefined;
  const mode = out.edit_mode;
  // A replace that does not say what was there cannot be drawn as one: it would read as an insert.
  if (mode !== "insert" && mode !== "delete" && typeof out.old_source !== "string")
    return undefined;
  const before =
    mode === "insert" ? [] : linesOf(typeof out.old_source === "string" ? out.old_source : "");
  const after =
    mode === "delete" ? [] : linesOf(typeof out.new_source === "string" ? out.new_source : "");
  if (before.length === 0 && after.length === 0) return undefined;
  const hunk: Hunk = {
    // An empty side starts at 0, as git writes it.
    oldStart: before.length > 0 ? 1 : 0,
    oldLines: before.length,
    newStart: after.length > 0 ? 1 : 0,
    newLines: after.length,
    lines: [...before.map((l) => `-${l}`), ...after.map((l) => `+${l}`)],
  };
  const result = changed(out.notebook_path, [hunk], out);
  return result === undefined ? undefined : { ...result, locations: [{ path: out.notebook_path }] };
};

const read = (out: Json, text: Content[]): Result | undefined => {
  const file = out.file;
  if (out.type !== "text" || !isObject(file)) return undefined;
  const [startLine, numLines, totalLines] = [
    num(file.startLine),
    num(file.numLines),
    num(file.totalLines),
  ];
  if (typeof file.filePath !== "string" || startLine === undefined || numLines === undefined)
    return undefined;
  return {
    content: text,
    meta: {
      read: {
        startLine: Math.max(1, startLine),
        numLines,
        ...(totalLines !== undefined ? { totalLines } : {}),
      },
    },
    locations: [{ path: file.filePath, line: Math.max(1, startLine) }],
  };
};

const more = (yes: boolean) => (yes ? { more: true as const } : {});

/**
 * Glob: the total when it is exact, else what it found and "more". `totalMatches` is a floor when `countIsComplete` is
 * false; without it, `truncated` says there were more than the 100 given.
 */
const glob = (out: Json, text: Content[]): Result | undefined => {
  const found = num(out.numFiles);
  if (found === undefined) return undefined;
  const total = num(out.totalMatches);
  const floor = out.countIsComplete === false || out.timedOut === true;
  const files = total ?? found;
  return {
    content: text,
    meta: { search: { files, ...more(floor || (total === undefined && out.truncated === true)) } },
  };
};

/** Grep: files, and matches or lines as its mode counts them. A limit or a timeout means there may be more. */
const grep = (out: Json, text: Content[]): Result | undefined => {
  const files = num(out.numFiles);
  if (files === undefined) return undefined;
  const [matches, lines] = [num(out.numMatches), num(out.numLines)];
  return {
    content: text,
    meta: {
      search: {
        files,
        ...(out.mode === "count" && matches !== undefined ? { matches } : {}),
        ...(out.mode === "content" && lines !== undefined ? { lines } : {}),
        ...more(out.timedOut === true || num(out.appliedLimit) !== undefined),
      },
    },
  };
};

/**
 * What a command printed as errors, without the note Claude Code adds after it when the command left the folder it
 * runs in ("Shell cwd was reset to /path"): that is Claude Code's own, said to the model, not what the command printed.
 */
const ownErrors = (stderr: string): string =>
  stderr.replace(/(?:^|\n)Shell cwd was reset to [^\n]*\n?$/, "").replace(/^\n+|\s+$/g, "");

/**
 * A command: what it printed and what it printed as errors, apart (the model sees them together), and how it ended
 * when that was not simply running to the end. A command whose output was an image is left as it came.
 */
const bash = (out: Json, text: Content[], failed: boolean): Result | undefined => {
  if (typeof out.stdout !== "string" || typeof out.stderr !== "string" || out.isImage === true)
    return undefined;
  // The output was too large and was saved to a file: what was kept of it is in the text the model saw, not here.
  if (out.persistedOutputPath !== undefined) return undefined;
  // What the exit code means ("Files differ") is only in the text the model saw: that text is what is shown.
  if (typeof out.returnCodeInterpretation === "string" && out.returnCodeInterpretation !== "")
    return undefined;
  // A command that failed says its exit code only in that text ("Exit code 2"): it is kept as a count.
  const said = text.find((c) => c.type === "content" && c.content.type === "text");
  const code =
    failed && said?.type === "content" && said.content.type === "text"
      ? /^Exit code (\d+)/.exec(said.content.text)?.[1]
      : undefined;
  // Nothing printed: the text the model saw may still say something ("No matches found", where a background
  // command's output goes), and that is what is shown.
  const stderr = ownErrors(out.stderr);
  const quiet = out.stdout === "" && stderr === "";
  const content: Content[] = quiet
    ? text
    : [{ type: "content", content: { type: "text", text: out.stdout } }];
  if (stderr !== "") {
    content.push({
      type: "content",
      content: { type: "text", text: stderr },
      _meta: { [STREAM_META]: "stderr" },
    });
  }
  const timedOutMs = num(out.timedOutAfterMs);
  const background = typeof out.backgroundTaskId === "string" || out.backgroundedByUser === true;
  return {
    content,
    meta: {
      run: {
        ...(out.interrupted === true ? { interrupted: true as const } : {}),
        ...(timedOutMs !== undefined ? { timedOutMs: Math.round(timedOutMs) } : {}),
        ...(background || timedOutMs !== undefined ? { background: true as const } : {}),
        ...(code !== undefined ? { exitCode: Number(code) } : {}),
      },
    },
  };
};

/** A command that failed, from its text alone: "Exit code 2" and what it printed. */
const failedCommand = (text: Content[]): Result | undefined => {
  const said = text.find((c) => c.type === "content" && c.content.type === "text");
  const code =
    said?.type === "content" && said.content.type === "text"
      ? /^Exit code (\d+)/.exec(said.content.text)?.[1]
      : undefined;
  return code === undefined
    ? undefined
    : { content: text, meta: { run: { exitCode: Number(code) } } };
};

/** A page fetched: what the model was told of it (the text), and the HTTP status and size. */
const webFetch = (out: Json, text: Content[]): Result | undefined => {
  const status = num(out.code);
  if (status === undefined || status < 100 || status > 599) return undefined;
  const bytes = num(out.bytes);
  return {
    content: text,
    meta: {
      fetch: {
        status: Math.round(status),
        ...(bytes !== undefined ? { bytes: Math.round(bytes) } : {}),
      },
    },
  };
};

/**
 * A web search: each hit as an ACP `resource_link` (its title and address, never the page), and the model's own notes
 * between them as text, in the order they came. The SDK's text for the model repeats all of it as JSON: not sent.
 */
const webSearch = (out: Json): Result | undefined => {
  if (!Array.isArray(out.results)) return undefined;
  const content: Content[] = [];
  // Several searches can find the same page: it is listed once.
  const seen = new Set<string>();
  for (const result of out.results) {
    if (typeof result === "string") {
      if (result.trim() !== "")
        content.push({ type: "content", content: { type: "text", text: result } });
    } else if (isObject(result) && Array.isArray(result.content)) {
      for (const hit of result.content) {
        if (!isObject(hit) || typeof hit.url !== "string" || seen.has(hit.url)) continue;
        seen.add(hit.url);
        const name = titleOfHit(hit.title) ?? hit.url;
        content.push({ type: "content", content: { type: "resource_link", uri: hit.url, name } });
      }
    }
  }
  return content.length > 0 ? { content } : undefined;
};

/**
 * A hit's title as a line: a real search gives titles like "> ## Documentation Index" or "# Test runner" (the page's
 * markdown), so the marks at their start are not the title. None left: the address stands for it.
 */
const titleOfHit = (title: unknown): string | undefined => {
  if (typeof title !== "string") return undefined;
  const line = title
    .replace(/^[\s>#*_-]+/, "")
    .replace(/[\s#*_]+$/, "")
    .trim();
  return line === "" ? undefined : line;
};

/** A watcher started in the background: its text, and that it runs on. */
const monitor = (out: Json, text: Content[]): Result | undefined =>
  typeof out.taskId === "string"
    ? { content: text, meta: { run: { background: true } } }
    : undefined;

/**
 * A `tool_result`'s own content as ACP content: its text as one block, each image as an image. Every tool's result
 * goes through here, so a Read of a picture or an MCP tool's screenshot is no longer lost.
 */
export const contentOf = (content: unknown): Content[] => {
  if (typeof content === "string")
    return [{ type: "content", content: { type: "text", text: content } }];
  if (!Array.isArray(content)) {
    const text = content === undefined ? "" : JSON.stringify(content);
    return [{ type: "content", content: { type: "text", text } }];
  }
  const texts: string[] = [];
  const images: Content[] = [];
  for (const part of content) {
    if (!isObject(part)) continue;
    if (part.type === "image" && isObject(part.source) && part.source.type === "base64") {
      const { data, media_type: mimeType } = part.source;
      if (
        typeof data === "string" &&
        typeof mimeType === "string" &&
        mimeType.startsWith("image/")
      ) {
        images.push({ type: "content", content: { type: "image", data, mimeType } });
      }
    } else if ("text" in part) texts.push(String(part.text ?? ""));
  }
  const text: Content[] =
    texts.length > 0 || images.length === 0
      ? [{ type: "content", content: { type: "text", text: texts.join("") } }]
      : [];
  return [...text, ...images];
};

/** An image `contentOf` carries into the content: base64, of an image type. */
const carried = (part: Json): boolean =>
  part.type === "image" &&
  isObject(part.source) &&
  part.source.type === "base64" &&
  typeof part.source.data === "string" &&
  typeof part.source.media_type === "string" &&
  part.source.media_type.startsWith("image/");

/**
 * The result as `rawOutput`, only for what the content does not already hold: a result of text and images is all in
 * the content (a Read's file would be sent and logged twice), so it has none. Any other part keeps the whole result,
 * as it came, with only the carried images' bytes left out.
 */
export const rawOutputOf = (content: unknown): unknown => {
  if (!Array.isArray(content)) return undefined;
  const plain = content.every((part) => isObject(part) && (part.type === "text" || carried(part)));
  if (plain) return undefined;
  return content.map((part) =>
    isObject(part) && carried(part) && isObject(part.source)
      ? { ...part, source: { ...part.source, data: "" } }
      : part,
  );
};

/**
 * What a finished call says, from its structured result when there is one this file knows; `undefined` leaves the
 * result as it was (its text). A failed call keeps its text (the message is what matters), except where a tool's own
 * reader says otherwise: a command that failed is the one whose errors most need to be told apart.
 */
export const resultOf = (
  name: string,
  structured: unknown,
  content: unknown,
  failed = false,
): Result | undefined => {
  // A command that failed has no structured result (seen with a real model): its text says the exit code, which is
  // kept as a count; the text stays as it came.
  if (name === "Bash" && failed && !isObject(structured)) return failedCommand(contentOf(content));
  if (!isObject(structured)) return undefined;
  if (name === "Bash") return bash(structured, contentOf(content), failed);
  // A page that came back with an error status: its status is why, and the text says the rest.
  if (name === "WebFetch") return webFetch(structured, contentOf(content));
  if (failed) return undefined;
  switch (name) {
    case "Edit":
      return edit(structured);
    case "Write":
      return write(structured);
    case "NotebookEdit":
      return notebook(structured);
    case "Read":
      return read(structured, contentOf(content));
    case "Glob":
      return glob(structured, contentOf(content));
    case "Grep":
      return grep(structured, contentOf(content));
    case "Monitor":
      return monitor(structured, contentOf(content));
    case "WebFetch":
      return webFetch(structured, contentOf(content));
    case "WebSearch":
      return webSearch(structured);
    default:
      return undefined;
  }
};
