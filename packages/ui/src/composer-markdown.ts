// The composer's text is Markdown, and its editor holds a document (docs: .agents/notes/2026-11-18-composer-text-is-markdown.md).
// These are the two ways across, and the rules that keep what the person typed from changing on the way.
//
// Lexical reads and writes Markdown with rules of its own that would change the text: it escapes `_` (`my_file.py` becomes
// `my\_file.py`), reads `__init__` as bold, drops the backslash of `foo\.bar` and decodes `&#42;`. A prompt goes to an agent
// as it was typed, so those three characters are swapped for stand-ins while Lexical reads or writes, and swapped back.
// Underscores therefore never format. `*`, backticks and the rest do, and read back the same.
import { CodeNode } from "@lexical/code";
import { ListItemNode, ListNode } from "@lexical/list";
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  TRANSFORMERS,
  type Transformer,
} from "@lexical/markdown";
import { HeadingNode, QuoteNode } from "@lexical/rich-text";
import { $nodesOfType, createEditor, type LexicalEditor, TextNode } from "lexical";
import { mentionText, wordAt } from "./draft.ts";
import { $createMentionNode, MentionNode } from "./react/mention-node.tsx";

/** What the document is made of. No links: a link is typed as text, and sent as text. */
export const NODES = [HeadingNode, QuoteNode, ListNode, ListItemNode, CodeNode, MentionNode];

/** What the editor needs of a mention that the draft holds: the `@path` it reads back as a block. */
export type MentionRef = { readonly path: string; readonly kind: "file" | "folder" | "session" };

/** Lexical's own set, less the `_` forms of emphasis and less links. */
export const TRANSFORMERS_FOR_COMPOSER: Transformer[] = TRANSFORMERS.filter((t) => {
  if (t.type === "text-format") return !t.tag.includes("_");
  if (t.type === "text-match") return t.dependencies.every((d) => d.getType() !== "link");
  return true;
});

// Characters of the private-use area, which text does not hold in practice, stand in for the ones Lexical changes.
const char = (code: number): string => String.fromCharCode(code);
const SWAPPED = ["\\", "&", "_", "*", "`", "~"] as const;
const STAND_IN = new Map<string, string>(SWAPPED.map((c, i) => [c, char(0xe000 + i)]));
const BACK = new Map<string, string>(SWAPPED.map((c, i) => [char(0xe000 + i), c]));
/** Goes before a character of that range that was already in the text, so that it is not taken for a stand-in. */
const ESCAPE = char(0xe000 + SWAPPED.length);
const RANGE = `${char(0xe000)}-${ESCAPE}`;
const CLASS = (chars: readonly string[]): string => chars.map((c) => `\\${c}`).join("");
/** Reading, Lexical must still see the characters of formatting. It does not change `*`, backticks and `~` on the way in. */
const IN = new RegExp(`[${CLASS(SWAPPED.slice(0, 3))}${RANGE}]`, "g");
/** Writing, the text of a text node is text, whatever it holds: formatting is what the node's flags say, never its characters. */
const OUT = new RegExp(`[${CLASS(SWAPPED)}${RANGE}]`, "g");
const DECODE = new RegExp(
  `${ESCAPE}([${RANGE}])|[${char(0xe000)}-${char(0xe000 + SWAPPED.length - 1)}]`,
  "g",
);

const swap = (pattern: RegExp) => (text: string) =>
  text.replace(pattern, (c) => STAND_IN.get(c) ?? ESCAPE + c);

/** The text as Lexical may read it. `decode(encode(text))` is `text`, whatever it holds. */
export const encode = swap(IN);
/** The text of a text node as Lexical may write it. */
export const encodeText = swap(OUT);

export const decode = (text: string): string =>
  text.replace(DECODE, (m, escaped?: string) => escaped ?? BACK.get(m) ?? m);

/** Replaces what the document holds with a Markdown text. Call it inside `editor.update`. */
export const $setMarkdown = (text: string, mentions: readonly MentionRef[] = []): void => {
  $convertFromMarkdownString(encode(text), TRANSFORMERS_FOR_COMPOSER, undefined, true);
  // What the person sees, and what Lexical edits from here on, is the real text.
  for (const node of $nodesOfType(TextNode)) {
    const real = decode(node.getTextContent());
    if (real !== node.getTextContent()) node.setTextContent(real);
  }
  if (mentions.length > 0) $blockMentions(mentions);
};

/** The `@path` the draft knows as a mention, wherever the text says it as a whole word, becomes a block. */
const $blockMentions = (mentions: readonly MentionRef[]): void => {
  // The longest first, so that a title that starts another does not take part of it.
  const words = mentions
    .map((m) => ({
      m,
      said: mentionText({ path: m.path, kind: m.kind === "folder" ? "folder" : "file" }),
    }))
    .sort((a, b) => b.said.length - a.said.length);
  for (const node of $nodesOfType(TextNode)) {
    if (node.getType() !== "text") continue;
    const text = node.getTextContent();
    const found: { at: number; end: number; m: MentionRef }[] = [];
    let from = 0;
    while (from < text.length) {
      let best: { at: number; end: number; m: MentionRef } | undefined;
      for (const w of words) {
        const at = wordAt(text, w.said, from);
        if (at !== -1 && (best === undefined || at < best.at))
          best = { at, end: at + w.said.length, m: w.m };
      }
      if (best === undefined) break;
      found.push(best);
      from = best.end;
    }
    if (found.length === 0) continue;
    const cuts = [...new Set(found.flatMap((f) => [f.at, f.end]))].filter(
      (c) => c > 0 && c < text.length,
    );
    const pieces = cuts.length === 0 ? [node] : node.splitText(...cuts);
    let offset = 0;
    for (const piece of pieces) {
      const size = piece.getTextContentSize();
      const hit = found.find((f) => f.at === offset && f.end === offset + size);
      if (hit !== undefined) piece.replace($createMentionNode(hit.m.path, hit.m.kind));
      offset += size;
    }
  }
};

type Json = { type?: unknown; text?: unknown; children?: unknown };

/** The serialized document with the text of every text node swapped for its stand-ins. */
const encodeState = (node: Json): Json => {
  const copy: Json = { ...node };
  if (typeof copy.text === "string") copy.text = encodeText(copy.text);
  if (Array.isArray(copy.children))
    copy.children = copy.children.map((c) => encodeState(c as Json));
  return copy;
};

let scratch: LexicalEditor | undefined;

/** The editor's document as Markdown, with line breaks kept as they are, one block to a line. */
export const markdownOf = (editor: LexicalEditor): string => {
  scratch ??= createEditor({
    namespace: "composer-export",
    nodes: NODES,
    onError: (error) => {
      throw error;
    },
  });
  const json = editor.getEditorState().toJSON() as unknown as { root: Json };
  scratch.setEditorState(scratch.parseEditorState({ root: encodeState(json.root) } as never), {
    tag: "history-merge",
  });
  return decode(
    scratch.read(() => $convertToMarkdownString(TRANSFORMERS_FOR_COMPOSER, undefined, true)),
  );
};

/** Puts a Markdown text into an editor, as one step that is not part of what undo takes back. */
export const setMarkdown = (
  editor: LexicalEditor,
  text: string,
  mentions: readonly MentionRef[] = [],
): void => {
  editor.update(
    () => {
      $setMarkdown(text, mentions);
    },
    { discrete: true, tag: "history-merge" },
  );
};
