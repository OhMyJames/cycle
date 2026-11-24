import { expect, test } from "bun:test";
import {
  ANSI_COLORS,
  ansiLines,
  ansiTail,
  contrast,
  OUTPUT_GROUND,
  parseAnsi,
  plainText,
} from "../src/ansi.ts";

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
  expect(plainText(text)).toBe("abcd");
  expect(parseAnsi(text)).toEqual([{ text: "abcd", style: {} }]);
  expect(plainText("plain\ntext")).toBe("plain\ntext");
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

test("a code's colon sub-parameters are its own; a private CSI is not a style", () => {
  expect(parseAnsi("\x1b[1;31mA\x1b[4:0mB")).toEqual([
    { text: "A", style: { bold: true, fg: { named: 1 } } },
    { text: "B", style: { bold: true, fg: { named: 1 } } },
  ]);
  expect(parseAnsi("\x1b[38:2::255:0:0mR\x1b[38:2:0:0:255mB\x1b[4:3mC")).toEqual([
    { text: "R", style: { fg: { rgb: "#ff0000" } } },
    { text: "B", style: { fg: { rgb: "#0000ff" } } },
    { text: "C", style: { fg: { rgb: "#0000ff" }, underline: true } },
  ]);
  expect(parseAnsi("\x1b[>4;2mplain")).toEqual([{ text: "plain", style: {} }]);
});

test("a line that ends in a carriage return keeps its words, whatever style came before its newline", () => {
  expect(plainText("\x1b[31mERROR: bad\r\x1b[0m\nnext")).toBe("ERROR: bad\nnext");
  expect(plainText("100% done\r")).toBe("100% done");
  expect(plainText("10%\r20%\r100%\ndone")).toBe("100%\ndone");
});

test("the tail reads only its lines, in the style they start in, and counts them all", () => {
  const text = `\x1b[32m${Array.from({ length: 100 }, (_, n) => `line ${n + 1}`).join("\n")}`;
  const { lines, total } = ansiTail(text, 40);
  expect(total).toBe(100);
  expect(lines).toHaveLength(40);
  expect(lines[0]).toEqual([{ text: "line 61", style: { fg: { named: 2 } } }]);
  expect(ansiTail("a\nb", 40)).toEqual({
    lines: [[{ text: "a", style: {} }], [{ text: "b", style: {} }]],
    total: 2,
  });
  expect(ansiTail("a\n", 1).lines).toEqual([[]]);
});

test("the 16 colours read at 4.5:1 on the output's ground in both themes", () => {
  expect(ANSI_COLORS).toHaveLength(16);
  for (const color of ANSI_COLORS) {
    const [light, dark] = /light-dark\((#[\da-f]{6}), (#[\da-f]{6})\)/.exec(color)?.slice(1) ?? [];
    expect(contrast(light as string, OUTPUT_GROUND.light)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(dark as string, OUTPUT_GROUND.dark)).toBeGreaterThanOrEqual(4.5);
  }
});

test("the output's ground is the page's", async () => {
  const css = await Bun.file(new URL("../src/styles/base.css", import.meta.url)).text();
  expect(css).toContain(
    `--cycle-surface-message: light-dark(${OUTPUT_GROUND.light}, ${OUTPUT_GROUND.dark});`,
  );
});
