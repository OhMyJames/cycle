import { marked } from "marked";

/** The fields of a marked token this page reads. */
export interface MdToken {
  type: string;
  raw: string;
  text?: string;
  tokens?: MdToken[];
  items?: MdToken[];
  depth?: number;
  lang?: string;
  href?: string;
  title?: string | null;
  ordered?: boolean;
  start?: number | "";
  task?: boolean;
  checked?: boolean;
  header?: { tokens: MdToken[] }[];
  rows?: { tokens: MdToken[] }[][];
  align?: (string | null)[];
}

export interface ParsedMarkdown {
  text: string;
  blocks: MdToken[];
}

function lex(text: string): MdToken[] {
  return marked.lexer(text, { gfm: true }) as MdToken[];
}

/**
 * Parses markdown into blocks. When `text` is the previous text with more
 * appended, as a streamed reply is, only the last block is parsed again:
 * blocks before it cannot change, and keep their identity so their views
 * need not redraw. A long reply therefore costs the same per chunk as a
 * short one.
 */
export function parseMarkdown(previous: ParsedMarkdown | null, text: string): ParsedMarkdown {
  if (previous && previous.blocks.length > 1 && text.startsWith(previous.text)) {
    let keep = previous.blocks.length - 1;
    while (keep > 0 && previous.blocks[keep]?.type === "space") keep--;
    const head = previous.blocks.slice(0, keep);
    let offset = 0;
    for (const block of head) offset += block.raw.length;
    return { text, blocks: [...head, ...lex(text.slice(offset))] };
  }
  return { text, blocks: lex(text) };
}

/** Whether a code fence at the end of the text has not been closed yet. */
export function endsInOpenFence(block: MdToken): boolean {
  if (block.type !== "code") return false;
  const fence = /^\s*(`{3,}|~{3,})/.exec(block.raw)?.[1];
  if (!fence) return false;
  const body = block.raw.trimEnd();
  return body.length <= fence.length || !body.endsWith(fence);
}

const FILE_REF = /^([\w@.~/-]*[\w-]\.[A-Za-z0-9]{1,8})(?::(\d+))?(?::\d+)?$/;

/** Reads inline code such as `src/app.ts:12` as a file and a line. */
export function fileReference(text: string): { path: string; line: number | null } | null {
  const match = FILE_REF.exec(text.trim());
  // A version or a ratio such as 1.2/3.4 has a number where a file has an extension.
  if (!match?.[1] || !match[1].includes("/") || /\.\d+$/.test(match[1])) return null;
  return { path: match[1], line: match[2] ? Number(match[2]) : null };
}
