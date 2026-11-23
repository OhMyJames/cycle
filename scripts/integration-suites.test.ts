import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { markdown, outcome, parseSummary, suites } from "./integration-suites.ts";

const root = new URL("..", import.meta.url).pathname;
const ALL = suites.map((s) => s.name);

describe("the list of suites", () => {
  test("is what integration.ts runs, in order, and every suite's file exists", () => {
    expect(ALL).toEqual(["node", "adapter", "codex", "agy", "ssh", "backend", "package", "web"]);
    for (const suite of suites)
      expect(() => readFileSync(`${root}${suite.cwd}/${suite.file}`)).not.toThrow();
  });

  test("the documents count the same suites", () => {
    expect(readFileSync(`${root}AGENTS.md`, "utf8")).toContain(`串行跑 ${ALL.length} 个套件`);
    expect(readFileSync(`${root}docs/testing.md`, "utf8")).toContain(`${ALL.length} 个套件`);
  });
});

describe("the result of a suite", () => {
  const suite = suites.find((s) => s.name === "web");
  if (!suite) throw new Error("no web suite");
  const bun = (pass: number, skip: number, fail = 0) =>
    ` ${pass} pass\n ${skip} skip\n ${fail} fail\n 3 expect() calls\nRan ${pass + skip + fail} tests across 1 file.`;
  const base = { suite, code: 0, timedOut: false, strict: false };

  test("reads bun's summary: without colours, the last of two, and nothing when there is none", () => {
    expect(parseSummary(bun(4, 1, 2))).toEqual({ pass: 4, skip: 1, fail: 2 });
    expect(parseSummary("\x1b[32m 4 pass\x1b[0m\n\x1b[2m 1 skip\x1b[0m\n 0 fail")).toEqual({
      pass: 4,
      skip: 1,
      fail: 0,
    });
    expect(parseSummary(" 9 pass\nlater: a test printed this\n 2 pass\n 0 fail").pass).toBe(2);
    expect(parseSummary("nothing here")).toEqual({ pass: 0, skip: 0, fail: 0 });
  });

  test("a pass is ok", () => {
    expect(outcome({ ...base, output: bun(3, 0) })).toEqual({ status: "ok" });
  });

  test("a suite that skipped everything is skipped, with what it needed; where strict, a failure", () => {
    const loose = outcome({ ...base, output: bun(0, 1) });
    expect(loose.status).toBe("skip");
    expect(loose.reason).toContain("Playwright's Chromium");
    const strict = outcome({ ...base, strict: true, output: bun(0, 1) });
    expect(strict.status).toBe("FAIL");
    expect(strict.reason).toContain("Playwright's Chromium");
  });

  test("some skipped: ok on a person's machine, a failure where strict", () => {
    expect(outcome({ ...base, output: bun(2, 1) }).status).toBe("ok");
    expect(outcome({ ...base, strict: true, output: bun(2, 1) }).status).toBe("FAIL");
  });

  test("no test at all is a failure, even outside strict", () => {
    expect(outcome({ ...base, output: bun(0, 0) }).status).toBe("FAIL");
    expect(outcome({ ...base, output: "" }).status).toBe("FAIL");
  });

  test("a failed exit, and a time-out, are failures that say which", () => {
    expect(outcome({ ...base, code: 1, output: bun(1, 0, 1) })).toEqual({
      status: "FAIL",
      reason: "exit 1",
    });
    expect(outcome({ ...base, code: 137, timedOut: true, output: "" }).reason).toContain(
      "over its limit of 150s",
    );
  });

  test("the table has a row per suite with its result and reason", () => {
    const table = markdown([
      { name: "node", status: "ok", seconds: 2.34 },
      { name: "web", status: "skip", reason: "needs electron" },
    ]);
    expect(table).toContain("| node | ok | 2.3s |  |");
    expect(table).toContain("| web | skip |  | needs electron |");
  });
});

test("CI runs every suite, strictly, and writes the step summary", () => {
  const ci = readFileSync(`${root}.github/workflows/ci.yml`, "utf8");
  expect(ci).toContain('bun run test:integration --strict --summary "$GITHUB_STEP_SUMMARY"');
});

describe("the command line refuses what it cannot run as asked, before any suite starts", () => {
  const cli = (...args: string[]) =>
    Bun.spawnSync(["bun", `${root}scripts/integration.ts`, ...args], { cwd: root });

  test("an option it does not know, a misspelt --strict among them", () => {
    const out = cli("--strickt");
    expect(out.exitCode).toBe(2);
    expect(out.stderr.toString()).toContain("unknown option --strickt");
  });

  test("--summary with no file after it, or with an option there", () => {
    expect(cli("--summary").exitCode).toBe(2);
    expect(cli("--summary", "--strict").exitCode).toBe(2);
  });

  test("a name no suite has; and the file after --summary is not taken for a name", () => {
    expect(cli("nothing-like-it").exitCode).toBe(2);
    const out = cli("--summary", "web", "nothing-like-it");
    expect(out.exitCode).toBe(2);
    expect(out.stderr.toString()).toContain('no suite matches "nothing-like-it"');
  });
});
