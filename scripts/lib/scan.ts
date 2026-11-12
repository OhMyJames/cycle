/**
 * A small scanner for TypeScript source: it tells code from comments, strings, template text and
 * regular expressions, which is all the gate's rules need. It is not a parser. It guesses where a
 * regular expression starts from what comes before the slash, and reads JSX text as code.
 */

export type Comment = { type: "Line" | "Block"; value: string; start: number; end: number };

export type Scan = {
  /** The code, with comments and the contents of strings, templates and regexes blanked out. */
  masked: string;
  comments: Comment[];
  /** The text of each quoted string, by the offset of its opening quote. */
  strings: Map<number, string>;
};

/** Words after which a slash starts a regular expression instead of dividing. */
const BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

const PUNCTUATION_BEFORE_REGEX = "(,=:[!&|?{};+-*%~^";
const WORD = /[\w$]+/y;

export function scanSource(code: string): Scan {
  const out = code.split("");
  const comments: Comment[] = [];
  const strings = new Map<number, string>();
  /** One entry per open `${`, counting the braces opened inside it. */
  const substitutions: number[] = [];
  let at = 0;
  let previous = "";
  let beforePrevious = "";
  let lastWord = "";

  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (out[index] !== "\n") out[index] = " ";
    }
  };

  const sawValue = (): void => {
    beforePrevious = previous;
    previous = "a";
    lastWord = "";
  };

  /** Reads template text from `at` to the closing backtick or the next `${`. */
  const readTemplate = (): void => {
    const from = at;
    while (at < code.length) {
      const char = code[at];
      if (char === "\\") {
        at += 2;
      } else if (char === "`") {
        blank(from, at);
        at += 1;
        sawValue();
        return;
      } else if (char === "$" && code[at + 1] === "{") {
        blank(from, at);
        at += 2;
        substitutions.push(0);
        previous = "{";
        lastWord = "";
        return;
      } else {
        at += 1;
      }
    }
    blank(from, at);
  };

  const readString = (quote: string): void => {
    const from = at;
    at += 1;
    while (at < code.length && code[at] !== quote && code[at] !== "\n") {
      at += code[at] === "\\" ? 2 : 1;
    }
    strings.set(from, code.slice(from + 1, at));
    blank(from + 1, at);
    if (code[at] === quote) at += 1;
    sawValue();
  };

  /** Whether a regular expression was read. If not, the slash was a division. */
  const readRegex = (): boolean => {
    let index = at + 1;
    let inClass = false;
    while (index < code.length) {
      const char = code[index];
      if (char === "\n") return false;
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "[") inClass = true;
      else if (char === "]") inClass = false;
      else if (char === "/" && !inClass) {
        blank(at + 1, index);
        at = index + 1;
        sawValue();
        return true;
      }
      index += 1;
    }
    return false;
  };

  const regexMayStart = (): boolean =>
    previous === "" ||
    PUNCTUATION_BEFORE_REGEX.includes(previous) ||
    (previous === ">" && beforePrevious === "=") ||
    BEFORE_REGEX.has(lastWord);

  while (at < code.length) {
    const char = code[at] ?? "";
    const next = code[at + 1];

    if (char === "/" && next === "/") {
      const newline = code.indexOf("\n", at);
      const end = newline === -1 ? code.length : newline;
      comments.push({ type: "Line", value: code.slice(at + 2, end), start: at, end });
      blank(at, end);
      at = end;
    } else if (char === "/" && next === "*") {
      const close = code.indexOf("*/", at + 2);
      const end = close === -1 ? code.length : close + 2;
      const value = code.slice(at + 2, close === -1 ? code.length : close);
      comments.push({ type: "Block", value, start: at, end });
      blank(at, end);
      at = end;
    } else if (char === '"' || char === "'") {
      readString(char);
    } else if (char === "`") {
      at += 1;
      readTemplate();
    } else if (char === "/" && regexMayStart() && readRegex()) {
      // Read.
    } else if (/\s/.test(char)) {
      at += 1;
    } else if (/[\w$]/.test(char)) {
      WORD.lastIndex = at;
      const word = WORD.exec(code)?.[0] ?? char;
      at += word.length;
      sawValue();
      lastWord = word;
    } else {
      at += 1;
      const depth = substitutions.at(-1);
      if (char === "{" && depth !== undefined) {
        substitutions[substitutions.length - 1] = depth + 1;
      } else if (char === "}" && depth !== undefined) {
        if (depth === 0) {
          substitutions.pop();
          readTemplate();
          continue;
        }
        substitutions[substitutions.length - 1] = depth - 1;
      }
      beforePrevious = previous;
      previous = char;
      lastWord = "";
    }
  }

  return { masked: out.join(""), comments, strings };
}
