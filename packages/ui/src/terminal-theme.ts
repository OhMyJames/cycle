// The colours a terminal draws in (CYCL-98). Its ground, text, cursor and selection are Cycle's tokens, read from the
// page so that they follow the theme. The sixteen ANSI colours are what programs in the shell ask for: content, like a
// code block's, so they are a published palette and not tokens. GitHub's, as the default code theme is (code-theme.ts),
// in its light and its dark form.

/** The sixteen colours, in xterm's names. */
export type AnsiPalette = {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
};

/** GitHub Light's terminal colours. */
export const ANSI_LIGHT: AnsiPalette = {
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#4d2d00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

/** GitHub Dark's terminal colours. */
export const ANSI_DARK: AnsiPalette = {
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#ffffff",
};

/** What the page's tokens come to for a terminal: resolved colours, since a canvas cannot read `light-dark()`. */
export type TerminalGround = {
  background: string;
  foreground: string;
  cursor: string;
  selection: string;
  dark: boolean;
};

/** The whole theme xterm takes. */
export const terminalTheme = (ground: TerminalGround) => ({
  ...(ground.dark ? ANSI_DARK : ANSI_LIGHT),
  background: ground.background,
  foreground: ground.foreground,
  cursor: ground.cursor,
  cursorAccent: ground.background,
  selectionBackground: ground.selection,
});

/** Whether a colour as the page computes it (`rgb(…)` or `rgba(…)`) is a dark one. */
export const isDark = (color: string): boolean => {
  const parts = color
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  if (parts === undefined || parts.length < 3) return false;
  const [r = 0, g = 0, b = 0] = parts;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
};
