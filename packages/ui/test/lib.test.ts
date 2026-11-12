import { expect, test } from "bun:test";
import { parseDiff } from "../src/lib/diff.ts";
import {
  compactNumber,
  dayBucket,
  duration,
  fuzzyScore,
  tailPath,
  tildePath,
} from "../src/lib/format.ts";
import { endsInOpenFence, fileReference, parseMarkdown } from "../src/lib/markdown-parse.ts";

const REPLY = `# Title

Some *text* with \`code\` and a [link](https://example.com).

- one
- two
  - nested

\`\`\`ts
const a = 1;

const b = 2;
\`\`\`

| a | b |
| - | - |
| 1 | 2 |

1. first
2. second

> quoted
> more

Last paragraph.
`;

test("parsing a reply as it streams gives the same blocks as parsing it whole", () => {
  for (const size of [1, 7, 23]) {
    let parsed = parseMarkdown(null, "");
    for (let end = size; end < REPLY.length + size; end += size) {
      parsed = parseMarkdown(parsed, REPLY.slice(0, end));
    }
    const whole = parseMarkdown(null, REPLY);
    expect(parsed.blocks.map((block) => [block.type, block.raw])).toEqual(
      whole.blocks.map((block) => [block.type, block.raw]),
    );
  }
});

test("blocks before the last keep their identity when text is appended", () => {
  const first = parseMarkdown(null, "One.\n\nTwo.\n\nThr");
  const second = parseMarkdown(first, "One.\n\nTwo.\n\nThree, longer.");
  expect(second.blocks[0]).toBe(first.blocks[0]);
  expect(second.blocks[2]).toBe(first.blocks[2]);
  expect(second.blocks.at(-1)).not.toBe(first.blocks.at(-1));
  expect(second.blocks.at(-1)?.raw).toBe("Three, longer.");
  // Text that is not a continuation is parsed afresh.
  expect(parseMarkdown(second, "Other.").blocks.map((block) => block.raw)).toEqual(["Other."]);
});

test("a fence is open until its closing line arrives", () => {
  const open = parseMarkdown(null, "```ts\nconst a = 1;\n").blocks.at(-1);
  const closed = parseMarkdown(null, "```ts\nconst a = 1;\n```\n").blocks.at(-1);
  expect(open && endsInOpenFence(open)).toBe(true);
  expect(closed && endsInOpenFence(closed)).toBe(false);
});

test.each([
  ["src/app.ts:12", { path: "src/app.ts", line: 12 }],
  ["./a/b.test.tsx", { path: "./a/b.test.tsx", line: null }],
  ["packages/ui/src/x.css:3:9", { path: "packages/ui/src/x.css", line: 3 }],
  ["README.md", null],
  ["npm run build", null],
  ["1.2/3.4", null],
])("inline code %p names the file %j", (text, expected) => {
  expect(fileReference(text)).toEqual(expected);
});

test("a patch is read into numbered lines per file", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -3,3 +3,4 @@ header",
    " keep",
    "-gone",
    "+new",
    "+more",
    " tail",
    "diff --git a/b.txt b/b.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/b.txt",
    "@@ -0,0 +1 @@",
    "+hello",
  ].join("\n");
  const [first, second] = parseDiff(patch);
  expect(first).toMatchObject({ path: "src/a.ts", additions: 2, deletions: 1 });
  expect(first?.lines.slice(1).map((line) => [line.type, line.oldLine, line.newLine])).toEqual([
    ["context", 3, 3],
    ["del", 4, null],
    ["add", null, 4],
    ["add", null, 5],
    ["context", 5, 6],
  ]);
  expect(second).toMatchObject({ path: "b.txt", additions: 1, deletions: 0 });
});

test("an agent's bare hunk is one file named by the caller", () => {
  const [file] = parseDiff("@@ -1 +1 @@\n-a\n+b\n", "x/y.ts");
  expect(file).toMatchObject({ path: "x/y.ts", additions: 1, deletions: 1 });
  expect(parseDiff("+only\n+added\n", "new.ts")[0]).toMatchObject({ additions: 2, deletions: 0 });
});

test("numbers, times and paths are written short", () => {
  expect([999, 1500, 25_000, 1_250_000].map(compactNumber)).toEqual([
    "999",
    "1.5k",
    "25k",
    "1.25M",
  ]);
  expect([450, 4200, 125_000, 3_720_000].map(duration)).toEqual(["450ms", "4s", "2m 5s", "1h 2m"]);
  expect(tildePath("/home/me/code/x", "/home/me")).toBe("~/code/x");
  expect(tildePath("/home/meow/x", "/home/me")).toBe("/home/meow/x");
  expect(tailPath("/a/very/long/path/to/some/project", 20)).toBe("…/to/some/project");
  const now = new Date(2026, 5, 10, 15).getTime();
  expect(dayBucket(now - 3_600_000, now)).toBe("Today");
  expect(dayBucket(now - 20 * 3_600_000, now)).toBe("Yesterday");
  expect(dayBucket(now - 3 * 86_400_000, now)).toBe("This week");
  expect(dayBucket(now - 30 * 86_400_000, now)).toBe("Earlier");
});

test("a fuzzy match needs every character in order, and prefers a direct hit", () => {
  expect(fuzzyScore("Fix the login form", "login")).toBeGreaterThan(
    fuzzyScore("Fix the login form", "fxlg"),
  );
  expect(fuzzyScore("Fix the login form", "fxlg")).toBeGreaterThan(0);
  expect(fuzzyScore("Fix the login form", "zzz")).toBe(0);
});
