import { describe, expect, test } from "bun:test";
import {
  outputSize,
  parseCrop,
  parseFormat,
  parseMaxWidth,
  parseShootOptions,
  shotFile,
} from "../gallery/shoot-options.ts";

describe("shoot options", () => {
  test("defaults: both themes, at 1200x800 only", () => {
    const o = parseShootOptions([]);
    expect(o).toMatchObject({
      out: undefined,
      themes: ["light", "dark"],
      sizes: ["1200x800"],
      platform: "",
      crop: undefined,
      format: "png",
      maxWidth: undefined,
      names: [],
    });
  });
  test("names are what no flag takes", () => {
    const o = parseShootOptions(["--format", "webp", "a", "--all", "--crop", ".x", "b"]);
    expect(o.names).toEqual(["a", "b"]);
    expect(o.all).toBe(true);
  });
  test("crop takes a selector or a rect", () => {
    expect(parseCrop("[data-slot=sidebar]")).toEqual({
      kind: "selector",
      selector: "[data-slot=sidebar]",
    });
    expect(parseCrop("#main")).toEqual({ kind: "selector", selector: "#main" });
    expect(parseCrop("10,20,300,200")).toEqual({
      kind: "rect",
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });
    for (const bad of ["", "1,2,3", "1,2,0,5", "-1,2,3,4", "1,2,3,4,5", "1,,3,4"])
      expect(() => parseCrop(bad)).toThrow();
  });
  test("format takes png and webp", () => {
    expect(parseFormat("png")).toBe("png");
    expect(parseFormat("webp")).toBe("webp");
    expect(() => parseFormat("jpg")).toThrow();
  });
  test("max-width takes a positive integer", () => {
    expect(parseMaxWidth("960")).toBe(960);
    for (const bad of ["0", "-5", "1.5", "abc", "", "09"])
      expect(() => parseMaxWidth(bad)).toThrow();
  });
  test("a flag without a value is an error", () => {
    expect(() => parseShootOptions(["--format"])).toThrow();
    expect(() => parseShootOptions(["--max-width", "--all"])).toThrow();
    expect(() => parseShootOptions(["--themes", "blue"])).toThrow();
  });
  test("unknown flags and --name=value are errors", () => {
    expect(() => parseShootOptions(["--crop=.x"])).toThrow();
    expect(() => parseShootOptions(["--nope"])).toThrow();
  });
  test("file extension follows the format", () => {
    expect(shotFile("a", "dark", "1200x800", "png")).toBe("a.dark.1200x800.png");
    expect(shotFile("a", "dark", "1200x800", "webp")).toBe("a.dark.1200x800.webp");
  });
  test("a cropped or narrowed shot has its own name", () => {
    expect(shotFile("a", "dark", "1200x800", "webp", true)).toBe("a.dark.1200x800.crop.webp");
  });
  test("output width is capped and keeps proportion", () => {
    const s = outputSize(1200, 2, 960);
    expect(s.width).toBe(960);
    expect(s.scale).toBeCloseTo(0.4);
    expect(Math.round(1200 * 2 * s.scale)).toBeLessThanOrEqual(960);
    expect(Math.round(800 * 2 * s.scale)).toBe(640);
  });
  test("no cap, or a roomy one, leaves the size alone", () => {
    expect(outputSize(1200, 2, undefined)).toEqual({ scale: 1, width: 2400 });
    expect(outputSize(400, 2, 960)).toEqual({ scale: 1, width: 800 });
  });
});
