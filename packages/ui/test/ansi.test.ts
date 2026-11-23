import { expect, test } from "bun:test";
import { ansiLines, parseAnsi, stripAnsi } from "../src/ansi.ts";

test("colours, bold and dim are read into runs; a reset ends them", () => {
  expect(parseAnsi("\x1b[32mok\x1b[0m then \x1b[1;2;91mloud\x1b[22m still red\x1b[m")).toEqual([
    { text: "ok", style: { fg: { named: 2 } } },
    { text: " then ", style: {} },
    { text: "loud", style: { bold: true, dim: true, fg: { named: 9 } } },
    { text: " still red", style: { fg: { named: 9 } } },
  ]);
  expect(parseAnsi("\x1b[38;5;196mA\x1b[48;2;1;2;3mB\x1b[38;5;3mC")).toEqual([
    { text: "A", style: { fg: { rgb: "#ff0000" } } },
    { text: "B", style: { fg: { rgb: "#ff0000" }, bg: { rgb: "#010203" } } },
    { text: "C", style: { fg: { named: 3 }, bg: { rgb: "#010203" } } },
  ]);
});

test("every other control sequence is dropped, not drawn", () => {
  const text = "a\x1b[2K\x1b[1A\x1b]0;title\x07b\x1b]8;;https://x\x1b\\c\x1b(Bd\x1b[?25l";
  expect(stripAnsi(text)).toBe("abcd");
  expect(parseAnsi(text)).toEqual([{ text: "abcd", style: {} }]);
  expect(stripAnsi("plain\ntext")).toBe("plain\ntext");
});

test("lines keep their colours across a break, and a carriage return starts its line again", () => {
  expect(ansiLines(parseAnsi("\x1b[31mone\ntwo\x1b[0m\nthree"))).toEqual([
    [{ text: "one", style: { fg: { named: 1 } } }],
    [{ text: "two", style: { fg: { named: 1 } } }],
    [{ text: "three", style: {} }],
  ]);
  expect(ansiLines(parseAnsi("10%\r\x1b[32m100%\x1b[0m\r\ndone"))).toEqual([
    [{ text: "100%", style: { fg: { named: 2 } } }],
    [{ text: "done", style: {} }],
  ]);
});
