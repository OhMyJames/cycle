// What a command printed, with the colours it asked for: its SGR codes (`ESC[…m`) read into styled runs, every other
// control sequence (cursor moves, clears, titles, links) dropped. Pure, so every rule is tested without a page. The rule
// is old-cycle's (`elements/terminal-block.tsx`, `parseAnsi`): colour, bold and dim are kept; anything that moves the
// cursor is not drawn, since an output is shown as text, not replayed as a terminal.

/** One of the 16 colours a terminal names, by its number (0-7, then 8-15 for the bright ones). Drawn from the theme. */
export type AnsiColor = { named: number } | { rgb: string };

export type AnsiStyle = {
  fg?: AnsiColor;
  bg?: AnsiColor;
  bold?: true;
  dim?: true;
  italic?: true;
  underline?: true;
};

/** A run of text in one style. */
export type AnsiRun = { text: string; style: AnsiStyle };

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI8 = String.fromCharCode(0x9b);

/** CSI (`ESC[` … its final byte), OSC (`ESC]` … BEL or `ESC\`), any other escape, and the one-byte CSI. */
const SEQUENCE = new RegExp(
  `${ESC}\\[([0-?]*)[ -/]*([@-~])|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?|${ESC}[ -/]*[0-~]?|${CSI8}[0-?]*[ -/]*[@-~]`,
  "g",
);

const hex = (value: number): string => value.toString(16).padStart(2, "0");

/** A colour of the 256: the 16 named ones, a 6×6×6 cube, then 24 greys. */
const indexed = (index: number): AnsiColor | undefined => {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return { named: index };
  if (index >= 232) {
    const grey = 8 + (index - 232) * 10;
    return { rgb: `#${hex(grey)}${hex(grey)}${hex(grey)}` };
  }
  const cube = index - 16;
  const level = (n: number) => (n === 0 ? 0 : 55 + n * 40);
  return {
    rgb: `#${hex(level(Math.floor(cube / 36)))}${hex(level(Math.floor(cube / 6) % 6))}${hex(level(cube % 6))}`,
  };
};

/** `38;5;n` or `38;2;r;g;b` from where `at` points (at the 5 or the 2): the colour, and how many numbers it took. */
const extended = (codes: number[], at: number): { color?: AnsiColor | undefined; used: number } => {
  if (codes[at] === 5) return { color: indexed(codes[at + 1] ?? -1), used: 2 };
  if (codes[at] === 2) {
    const [r, g, b] = [codes[at + 1], codes[at + 2], codes[at + 3]];
    const ok = [r, g, b].every((v) => v !== undefined && v >= 0 && v <= 255);
    return ok
      ? { color: { rgb: `#${hex(r as number)}${hex(g as number)}${hex(b as number)}` }, used: 4 }
      : { used: 4 };
  }
  return { used: 0 };
};

const apply = (style: AnsiStyle, parameters: string): AnsiStyle => {
  const codes =
    parameters === "" ? [0] : parameters.split(/[;:]/).map((p) => (p === "" ? 0 : Number(p)));
  let next: AnsiStyle = { ...style };
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i] as number;
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code >= 30 && code <= 37) next.fg = { named: code - 30 };
    else if (code >= 90 && code <= 97) next.fg = { named: code - 90 + 8 };
    else if (code === 39) delete next.fg;
    else if (code >= 40 && code <= 47) next.bg = { named: code - 40 };
    else if (code >= 100 && code <= 107) next.bg = { named: code - 100 + 8 };
    else if (code === 49) delete next.bg;
    else if (code === 38 || code === 48) {
      const { color, used } = extended(codes, i + 1);
      if (color !== undefined) next[code === 38 ? "fg" : "bg"] = color;
      i += used;
    }
  }
  return next;
};

/** What a command printed, as runs of text in one style each, with no control sequence left in it. */
export const parseAnsi = (text: string): AnsiRun[] => {
  const runs: AnsiRun[] = [];
  let style: AnsiStyle = {};
  let at = 0;
  const push = (words: string) => {
    if (words === "") return;
    const last = runs.at(-1);
    if (last !== undefined && last.style === style) last.text += words;
    else runs.push({ text: words, style });
  };
  for (const match of text.matchAll(SEQUENCE)) {
    push(text.slice(at, match.index));
    at = match.index + match[0].length;
    // Only a CSI that ends in `m` is a style; every other one moves or clears, and is not drawn.
    if (match[2] === "m") style = apply(style, match[1] ?? "");
  }
  push(text.slice(at));
  return runs;
};

/** What a command printed, as plain text: what is copied. */
export const stripAnsi = (text: string): string => text.replace(SEQUENCE, "");

/**
 * The runs as lines, each line's runs its own: a long output keeps its last lines, in the colours they were printed in.
 * A carriage return alone starts its line again, as a progress bar means it to: only what was written last is drawn.
 */
export const ansiLines = (runs: AnsiRun[]): AnsiRun[][] => {
  const lines: AnsiRun[][] = [[]];
  for (const run of runs) {
    run.text
      .replace(/\r\n/g, "\n")
      .split("\n")
      .forEach((part, index) => {
        if (index > 0) lines.push([]);
        const returned = part.lastIndexOf("\r");
        if (returned >= 0) lines[lines.length - 1] = [];
        const kept = part.slice(returned + 1);
        if (kept !== "") lines.at(-1)?.push({ text: kept, style: run.style });
      });
  }
  return lines;
};
