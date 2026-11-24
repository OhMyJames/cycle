// Each agy frontend writes a log of its own, and old ones are cleared away (CYC-297).
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logFileFor, pruneLogs } from "../src/logs.ts";

test("the log name carries the adapter's pid", () => {
  expect(logFileFor("/d/logs/agy-acp.log", 42)).toBe("/d/logs/agy-acp.42.log");
});

test("old logs and those past the count are removed; the current run's and others' are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "agy-logs-"));
  try {
    const base = join(dir, "agy-acp.log");
    const now = Date.now();
    const make = (name: string, ageMs: number) => {
      writeFileSync(join(dir, name), "x");
      const t = new Date(now - ageMs);
      utimesSync(join(dir, name), t, t);
    };
    make("agy-acp.1.log", 1000);
    make("agy-acp.1.log.77", 1000);
    make("agy-acp.2.log", 2000);
    make("agy-acp.3.log", 3000);
    make("agy-acp.4.log", 30 * 24 * 3600 * 1000);
    make("agy-acp.log", 40 * 24 * 3600 * 1000);
    make("daemon.log", 40 * 24 * 3600 * 1000);
    const current = join(dir, "agy-acp.9.log");
    writeFileSync(current, "x");
    // keep 3 counts the current one: of the fresh ones, two newest stay.
    pruneLogs(base, { current, keep: 3, now });
    expect(readdirSync(dir).sort()).toEqual([
      "agy-acp.1.log",
      "agy-acp.1.log.77",
      "agy-acp.9.log",
      "daemon.log",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
