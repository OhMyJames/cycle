// Hard path floor for Loop auto-merge (CYC-481): a PR touching any of these paths must be merged by a person,
// regardless of what the LLM PR review session decided. This file itself sits inside the floor.

export const FLOOR = [
  "cloud/loop/src/supervisor/",
  "cloud/loop/src/guard/",
  "REVIEW.md",
  ".github/",
] as const;

const normalizePath = (path: string): string =>
  path.replace(/\\/g, "/").replace(/^(?:\.\/|\/)+/, "");

/** Returns the paths in `changed` that hit the auto-merge floor, in order and deduplicated. */
export const floorHits = (changed: readonly string[]): string[] => {
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const raw of changed) {
    const clean = normalizePath(raw.trim());
    if (clean === "" || seen.has(clean)) continue;
    const hit = FLOOR.some((entry) =>
      entry.endsWith("/") ? clean.startsWith(entry) : clean === entry,
    );
    if (hit) {
      seen.add(clean);
      hits.push(clean);
    }
  }
  return hits;
};
