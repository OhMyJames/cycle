// The owner's rule for CI: every job is planned for a 2-core, 4 GB machine and finishes in about 2 minutes, setup
// included. A job that would not is split (the browser tests in three, the integration suites in two), not given more time.
// 2 minutes is what a job is designed to take; 5 is the line it is killed at (the owner's call), the rest being the
// runners' own spread and queue.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { shard, testFiles } from "../packages/ui/test/shard.ts";
import { groups } from "./integration-suites.ts";

const root = new URL("..", import.meta.url).pathname;
const MAX_MINUTES = 5;

type Job = {
  "timeout-minutes"?: number;
  uses?: string;
  strategy?: { matrix?: Record<string, string[]> };
  needs?: string | string[];
};
const workflow = (name: string): { jobs: Record<string, Job> } =>
  Bun.YAML.parse(readFileSync(`${root}.github/workflows/${name}`, "utf8")) as {
    jobs: Record<string, Job>;
  };

describe("CI's jobs stay inside the budget", () => {
  // The jobs that build and sign the apps run on macOS runners for as long as the build takes: the budget is for the
  // jobs that test.
  for (const file of ["ci.yml", "daemon-linux.yml"]) {
    test(`${file}: every job has a timeout of at most ${MAX_MINUTES} minutes`, () => {
      for (const [name, job] of Object.entries(workflow(file).jobs)) {
        const minutes = job["timeout-minutes"];
        expect(minutes, `${file} ${name}`).toBeDefined();
        expect(minutes ?? Infinity, `${file} ${name}`).toBeLessThanOrEqual(
          file === "daemon-linux.yml" ? 15 : MAX_MINUTES,
        );
      }
    });
  }
  test("ci.yml has the jobs the main ruleset asks for", () => {
    expect(Object.keys(workflow("ci.yml").jobs)).toEqual(
      expect.arrayContaining(["check", "browser", "integration"]),
    );
  });
});

describe("the browser tests are split without overlap", () => {
  const parts = workflow("ci.yml").jobs["browser-part"]?.strategy?.matrix?.part ?? [];
  test("the matrix in ci.yml is a full set of n/N", () => {
    const count = parts.length;
    expect(count).toBeGreaterThan(1);
    expect(parts).toEqual(Array.from({ length: count }, (_, i) => `${i + 1}/${count}`));
  });
  test("each test file is in exactly one part, and a part is never empty", () => {
    const all = parts.flatMap((p) => shard(p));
    expect(all.sort()).toEqual(
      testFiles()
        .map((f) => `test/browser/${f}`)
        .sort(),
    );
    for (const p of parts) expect(shard(p).length).toBeGreaterThan(0);
  });
  test("a part that is not n/N is refused", () => {
    expect(() => shard("4/3")).toThrow();
    expect(() => shard("x")).toThrow();
  });
});

describe("the integration suites are split to the groups CI runs", () => {
  test("the matrix in ci.yml is the list of groups", () => {
    expect(workflow("ci.yml").jobs["integration-part"]?.strategy?.matrix?.group).toEqual(groups);
  });
});
