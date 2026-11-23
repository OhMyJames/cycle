import { expect, test } from "bun:test";
import { lineDiff, proposalOf } from "../src/model/index.ts";

const shape = (lines: ReturnType<typeof lineDiff>) =>
  lines.map((line) => `${{ add: "+", del: "-", context: " ", hunk: "@" }[line.kind]}${line.text}`);

test("an edit's change: removed lines before the added ones that take their place, with the lines around them", () => {
  expect(shape(lineDiff("a\nb\nc\n", "a\nB\nc\n"))).toEqual([" a", "-b", "+B", " c"]);
});

test("unchanged lines far from any change are left out, and a gap between changes is marked", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  const after = before.replace("line 1\n", "line one\n").replace("line 18", "line eighteen");
  expect(shape(lineDiff(before, after))).toEqual([
    " line 0",
    "-line 1",
    "+line one",
    " line 2",
    " line 3",
    " line 4",
    "@",
    " line 15",
    " line 16",
    " line 17",
    "-line 18",
    "+line eighteen",
    " line 19",
  ]);
});

test("a diff's lines have ids that are unique in it", () => {
  const lines = lineDiff("x\nx\nx", "y\ny\ny");
  expect(new Set(lines.map((line) => line.id)).size).toBe(lines.length);
});

test("Edit: the change its strings make, counted", () => {
  const proposal = proposalOf({
    rawInput: {
      file_path: "/w/a.ts",
      old_string: "let a = 1;",
      new_string: "let a = 2;\nlet b = 3;",
    },
  });
  expect(proposal).toMatchObject({
    kind: "edit",
    path: "/w/a.ts",
    whole: false,
    additions: 2,
    deletions: 1,
  });
});

test("MultiEdit: each edit's change, one after another", () => {
  const proposal = proposalOf({
    rawInput: {
      file_path: "/w/a.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" },
      ],
    },
  });
  expect(proposal?.kind).toBe("edit");
  if (proposal?.kind !== "edit") return;
  expect(shape(proposal.lines)).toEqual(["-a", "+b", "@", "-c", "+d"]);
  expect(new Set(proposal.lines.map((line) => line.id)).size).toBe(proposal.lines.length);
});

test("Write: the whole file, every line added", () => {
  const proposal = proposalOf({
    rawInput: { file_path: "/w/new.md", content: "# Title\n\nText\n" },
  });
  expect(proposal).toMatchObject({ kind: "edit", whole: true, additions: 3, deletions: 0 });
});

test("a command is quoted as it will run, its purpose beside it", () => {
  expect(
    proposalOf({ rawInput: { command: "rm -rf build", description: " Clean the build " } }),
  ).toEqual({
    kind: "command",
    command: "rm -rf build",
    description: "Clean the build",
  });
});

test("any other tool shows what it was given; one with nothing given shows nothing", () => {
  expect(proposalOf({ rawInput: { url: "https://bun.sh" } })).toEqual({
    kind: "input",
    input: { url: "https://bun.sh" },
  });
  expect(proposalOf({ rawInput: {} })).toBeUndefined();
  expect(proposalOf({})).toBeUndefined();
});

test("a change too large to compare line by line is still drawn whole, removed then added", () => {
  const before = Array.from({ length: 2100 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 2100 }, (_, i) => `new ${i}`).join("\n");
  const lines = lineDiff(before, after);
  expect(lines.filter((line) => line.kind === "del")).toHaveLength(2100);
  expect(lines.filter((line) => line.kind === "add")).toHaveLength(2100);
  expect(lines[0]?.kind).toBe("del");
});
