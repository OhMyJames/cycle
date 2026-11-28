// Which of the browser tests one CI job runs. `BROWSER_SHARD=2/3` is the second of three parts; without it, all of them.
//
// The parts are balanced by how many tests a file has, not by its size or by a hash of its name (what Vitest's own
// `--shard` uses): measured on 2026-11-27, the count put three parts within a second of each other (60/60/60 s of test time at four cores), the
// hash gave 60/31/20 s and the size 50/56/74 s (CI's 2-core container: 38 to 42 s a part). The packing is the same on every machine, so the parts never overlap
// and never miss a file.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dirname, "browser");

/** The test files, every one of them (what `vitest run` would pick up). */
export const testFiles = (): string[] =>
  readdirSync(DIR)
    .filter((f) => f.endsWith(".browser.tsx"))
    .sort();

const weight = (file: string) =>
  Math.max(
    1,
    (
      readFileSync(join(DIR, file), "utf8").match(
        /\b(?:test|it)(?:\.\w+)*(?:\.each\([^)]*\))?\(/g,
      ) ?? []
    ).length,
  );

/** Part `index` (1-based) of `count`, as paths relative to the package; all of them when `spec` is undefined. */
export const shard = (spec: string | undefined): string[] => {
  const all = testFiles().map((f) => `test/browser/${f}`);
  if (spec === undefined || spec === "") return all;
  const m = /^(\d+)\/(\d+)$/.exec(spec);
  const index = Number(m?.[1]);
  const count = Number(m?.[2]);
  if (m === null || index < 1 || index > count) {
    throw new Error(`BROWSER_SHARD is "n/N" with 1 <= n <= N, e.g. "2/3"; got "${spec}"`);
  }
  // Heaviest first, each into the lightest part so far (ties: the first part, the earlier name).
  const parts = Array.from({ length: count }, () => ({ load: 0, files: [] as string[] }));
  for (const file of all
    .map((f) => ({ f, w: weight(f.slice("test/browser/".length)) }))
    .sort((a, b) => b.w - a.w || (a.f < b.f ? -1 : 1))) {
    const lightest = parts.reduce((a, b) => (b.load < a.load ? b : a));
    lightest.load += file.w;
    lightest.files.push(file.f);
  }
  return parts[index - 1]?.files.sort() ?? [];
};
