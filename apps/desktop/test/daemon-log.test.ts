import { expect, test } from "bun:test";
import { DaemonLog, type LogFile } from "../src/daemon-log.ts";

/** A log file in memory, with the one before it. */
function memory(held = "") {
  const state = { text: held, previous: null as string | null };
  const file: LogFile = {
    size: () => state.text.length,
    append: (text) => {
      state.text += text;
    },
    rotate: () => {
      state.previous = state.text;
      state.text = "";
    },
  };
  return { state, file };
}
const at = (iso: string) => () => new Date(iso);

test("each line is stamped, a line split across chunks is one, and a start is marked", () => {
  const { state, file } = memory();
  const log = new DaemonLog(file, at("2026-11-16T10:00:00.000Z"));
  log.start();
  log.write("one\ntw");
  log.write("o\nthree");
  expect(state.text).toBe(
    "2026-11-16T10:00:00.000Z daemon starting\n2026-11-16T10:00:00.000Z one\n2026-11-16T10:00:00.000Z two\n",
  );
  log.end();
  expect(state.text.endsWith("Z three\n")).toBe(true);
});

test("what an earlier start wrote is kept, and the file never grows past its limit by more than a line", () => {
  const earlier = "2026-11-15T09:00:00.000Z earlier start\n";
  const { state, file } = memory(earlier);
  const log = new DaemonLog(file, at("2026-11-16T10:00:00.000Z"), 200);
  log.start();
  expect(state.text.startsWith(earlier)).toBe(true);
  for (let index = 0; index < 20; index++) log.write(`line ${index}\n`);
  // The older part was kept as the previous log, and what is written now fits.
  expect(state.previous).not.toBeNull();
  expect(state.previous).toMatch(/^2026-11-16T10:00:00.000Z line \d+\n/);
  expect(state.text.length).toBeLessThanOrEqual(200);
  expect(state.text.endsWith("line 19\n")).toBe(true);
});

test("the size is counted in bytes, a line with no end is not held for ever, and a disk that fails loses a line only", () => {
  const { state, file } = memory();
  const log = new DaemonLog(file, at("2026-11-16T10:00:00.000Z"), 120);
  log.write("é".repeat(40) + "\n");
  log.write("é".repeat(40) + "\n");
  // Two lines of 80 bytes each do not fit in 120: the first was kept as the previous log.
  expect(state.previous).not.toBeNull();
  const quiet = memory();
  const flood = new DaemonLog(quiet.file, at("2026-11-16T10:00:00.000Z"));
  flood.write("x".repeat(20_000));
  expect(quiet.state.text.length).toBeGreaterThan(20_000);
  const broken = new DaemonLog(
    {
      size: () => {
        throw new Error("gone");
      },
      append: () => {
        throw new Error("disk full");
      },
      rotate: () => {
        throw new Error("denied");
      },
    },
    at("2026-11-16T10:00:00.000Z"),
  );
  expect(() => {
    broken.start();
    broken.write("a line\n");
    broken.end();
  }).not.toThrow();
});

test("a log opened already over its limit rotates before its first line", () => {
  const { state, file } = memory("x".repeat(500));
  const log = new DaemonLog(file, at("2026-11-16T10:00:00.000Z"), 200);
  log.start();
  expect(state.previous).toBe("x".repeat(500));
  expect(state.text).toBe("2026-11-16T10:00:00.000Z daemon starting\n");
});
