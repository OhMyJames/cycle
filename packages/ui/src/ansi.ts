// What a command printed, with the colours it asked for: its SGR codes (`ESC[…m`) read into styled runs, every other
// control sequence (cursor moves, clears, titles, links) dropped. Pure, so every rule is tested without a page. The rule
// is old-cycle's (`elements/terminal-block.tsx`, `parseAnsi`): colour, bold and dim are kept; anything that moves the
// cursor is not drawn, since an output is shown as text, not replayed as a terminal.

import { ANSI_DARK, ANSI_LIGHT, type AnsiPalette } from "./terminal-theme.ts";

/** One of the 16 colours a terminal names, by its number (0-7, then 8-15 for the bright ones), or one it gave. */
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

/**
 * CSI (`ESC[` … its final byte), OSC (`ESC]` … BEL or `ESC\`), any other escape (`ESC(B`, `ESC7`), and the one-byte
 * CSI. A CSI's parameters are the first group, its final byte the second.
 */
const SEQUENCE = () =>
  new RegExp(
    `${ESC}\\[([0-?]*)[ -/]*([@-~])|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?|${ESC}[ -/]*[0-~]?|${CSI8}([0-?]*)[ -/]*([@-~])`,
    "g",
  );

const hex = (value: number): string => value.toString(16).padStart(2, "0");

/** A colour of the 256: the 16 named ones, a 6×6×6 cube, then 24 greys. */
const indexed = (index: number | undefined): AnsiColor | undefined => {
  if (index === undefined || !Number.isInteger(index) || index < 0 || index > 255) return undefined;
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

const truecolor = (r?: number, g?: number, b?: number): AnsiColor | undefined =>
  [r, g, b].every((v) => v !== undefined && Number.isInteger(v) && v >= 0 && v <= 255)
    ? { rgb: `#${hex(r as number)}${hex(g as number)}${hex(b as number)}` }
    : undefined;

/** `38:5:n` or `38:2:[space]:r:g:b`, the colon form: the numbers after the 38 or 48. */
const colonColor = (sub: number[]): AnsiColor | undefined => {
  if (sub[0] === 5) return indexed(sub[1]);
  if (sub[0] !== 2) return undefined;
  // With a colour space id (`2:id:r:g:b`, which may be empty) or without one (`2:r:g:b`).
  const rgb = sub.length >= 5 ? sub.slice(2, 5) : sub.slice(1, 4);
  return truecolor(...rgb);
};

const number = (part: string): number => (part === "" ? 0 : Number(part));

const apply = (style: AnsiStyle, parameters: string): AnsiStyle => {
  // `;` parts its codes; `:` parts a code's own sub-parameters (`4:3`, `38:2::r:g:b`), which belong to that code alone.
  const groups = (parameters === "" ? "0" : parameters).split(";");
  let next: AnsiStyle = { ...style };
  for (let i = 0; i < groups.length; i++) {
    const [head = "", ...rest] = (groups[i] as string).split(":");
    const code = number(head);
    const sub = rest.map(number);
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) {
      if (sub[0] === 0) delete next.underline;
      else next.underline = true;
    } else if (code === 22) {
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
      let color: AnsiColor | undefined;
      if (rest.length > 0) color = colonColor(sub);
      else {
        // `38;5;n` and `38;2;r;g;b`: the numbers that follow are the colour's, not codes of their own.
        const kind = number(groups[i + 1] ?? "");
        const after = groups.slice(i + 2, i + (kind === 5 ? 3 : 5)).map(number);
        color = kind === 5 ? indexed(after[0]) : kind === 2 ? truecolor(...after) : undefined;
        i += kind === 5 ? 2 : kind === 2 ? 4 : 0;
      }
      if (color !== undefined) next[code === 38 ? "fg" : "bg"] = color;
    }
  }
  return next;
};

/** Whether a sequence is a style: a CSI that ends in `m`, without a private marker (`ESC[>4;2m` sets keys, not a style). */
const isStyle = (match: RegExpExecArray): string | undefined => {
  const parameters = match[1] ?? match[3];
  const final = match[2] ?? match[4];
  return final === "m" && parameters !== undefined && !/^[<=>?]/.test(parameters)
    ? parameters
    : undefined;
};

/** The runs of `text` from `start`, beginning in `style`. */
const runsFrom = (text: string, start: number, initial: AnsiStyle): AnsiRun[] => {
  const runs: AnsiRun[] = [];
  let style = initial;
  let at = start;
  const push = (words: string) => {
    if (words === "") return;
    const last = runs.at(-1);
    if (last !== undefined && last.style === style) last.text += words;
    else runs.push({ text: words, style });
  };
  const sequence = SEQUENCE();
  sequence.lastIndex = start;
  for (let match = sequence.exec(text); match !== null; match = sequence.exec(text)) {
    push(text.slice(at, match.index));
    at = match.index + match[0].length;
    const parameters = isStyle(match);
    if (parameters !== undefined) style = apply(style, parameters);
  }
  push(text.slice(at));
  return runs;
};

/** What a command printed, as runs of text in one style each, with no control sequence left in it. */
export const parseAnsi = (text: string): AnsiRun[] => runsFrom(text, 0, {});

/** The style in force where `end` is, from the styles set before it; nothing else is read into runs. */
const styleAt = (text: string, end: number): AnsiStyle => {
  let style: AnsiStyle = {};
  const sequence = SEQUENCE();
  for (
    let match = sequence.exec(text);
    match !== null && match.index < end;
    match = sequence.exec(text)
  ) {
    const parameters = isStyle(match);
    if (parameters !== undefined) style = apply(style, parameters);
  }
  return style;
};

/**
 * The runs as lines, each line's runs its own: a long output keeps its last lines, in the colours they were printed in.
 * A carriage return starts its line again, as a progress bar means it to, once something is written after it: only what
 * was written last is drawn, and a line that ends in one (or in `\r\n`, whatever style came between) keeps its words.
 */
export const ansiLines = (runs: AnsiRun[]): AnsiRun[][] => {
  const lines: AnsiRun[][] = [[]];
  let returned = false;
  for (const run of runs) {
    run.text.split("\n").forEach((part, index) => {
      if (index > 0) {
        lines.push([]);
        returned = false;
      }
      const pieces = part.split("\r");
      pieces.forEach((piece, at) => {
        if (at > 0) returned = true;
        if (piece === "") return;
        if (returned) {
          lines[lines.length - 1] = [];
          returned = false;
        }
        lines.at(-1)?.push({ text: piece, style: run.style });
      });
    });
  }
  return lines;
};

/** Lines as the text they show: what is copied. */
export const linesText = (lines: AnsiRun[][]): string =>
  lines.map((line) => line.map((run) => run.text).join("")).join("\n");

/** What a command printed, as plain text: the lines it shows, without their colours. */
export const plainText = (text: string): string => linesText(ansiLines(parseAnsi(text)));

/**
 * The last `count` lines of what a command printed, in their colours, and how many lines it has in all. Only those lines
 * are read into runs: before them, only the styles they start in, so a long log that grows is not parsed whole each time.
 */
export const ansiTail = (text: string, count: number): { lines: AnsiRun[][]; total: number } => {
  let total = 1;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) total += 1;
  // The last `count` lines start after the `count`th newline from the end; with fewer, at the start.
  let from = 0;
  let end = text.length;
  for (let found = 0; found < count; found++) {
    const at = end === 0 ? -1 : text.lastIndexOf("\n", end - 1);
    if (at === -1) {
      end = -1;
      break;
    }
    end = at;
  }
  if (end !== -1) from = end + 1;
  const lines = ansiLines(runsFrom(text, from, from === 0 ? {} : styleAt(text, from)));
  return { lines, total };
};

/** Relative luminance of `#rrggbb`. */
const luminance = (color: string): number => {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const c = Number.parseInt(color.slice(at, at + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

/** `color` moved towards `to` until it reads at 4.5:1 on `ground`. */
const readable = (color: string, ground: string, to: string): string => {
  for (let step = 0; step <= 20; step++) {
    const mixed = [1, 3, 5]
      .map((at) => {
        const [c, t] = [color, to].map((x) => Number.parseInt(x.slice(at, at + 2), 16)) as [
          number,
          number,
        ];
        return hex(Math.round(c + ((t - c) * step) / 20));
      })
      .join("");
    if (contrast(`#${mixed}`, ground) >= 4.5) return `#${mixed}`;
  }
  return to;
};

/** The ground an output is drawn on (`--cycle-surface-message`), in the light theme and the dark. */
export const OUTPUT_GROUND = { light: "#f2f2f4", dark: "#1b1b1c" };

const ORDER: (keyof AnsiPalette)[] = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
];

/**
 * The 16 colours as an output draws them: the terminal's (terminal-theme.ts), so a program looks the same in both, each
 * moved just far enough to read at 4.5:1 on the output's ground, since text in the conversation is held to that.
 */
export const ANSI_COLORS: string[] = ORDER.map(
  (name) =>
    `light-dark(${readable(ANSI_LIGHT[name], OUTPUT_GROUND.light, "#000000")}, ${readable(ANSI_DARK[name], OUTPUT_GROUND.dark, "#ffffff")})`,
);
