import { expect, test } from "bun:test";
import { commandLabel } from "../src/model/command-label.ts";

test("a command that plainly searches, reads or lists is named for it", () => {
  expect(commandLabel("rg useSteady src")).toEqual({
    kind: "search",
    detail: "'useSteady' in src",
    count: 1,
  });
  expect(commandLabel('grep -rn -e "a b" --include "*.ts" packages')).toEqual({
    kind: "search",
    detail: "'a b' in packages",
    count: 1,
  });
  expect(commandLabel("rg -t ts TODO")).toEqual({ kind: "search", detail: "'TODO'", count: 1 });
  expect(commandLabel("cat packages/ui/src/app.tsx")).toEqual({
    kind: "read",
    detail: "app.tsx",
    count: 1,
  });
  expect(commandLabel("head -n 40 a.ts b.ts c.ts d.ts")).toEqual({
    kind: "read",
    detail: "a.ts, b.ts, c.ts +1",
    count: 4,
  });
  expect(commandLabel("sed -n '1,40p' src/a.ts")).toEqual({
    kind: "read",
    detail: "a.ts",
    count: 1,
  });
  expect(commandLabel("ls -la src")).toEqual({ kind: "list", detail: "src", count: 1 });
  expect(commandLabel("ls")).toEqual({ kind: "list", detail: ".", count: 1 });
  expect(commandLabel("find src -name '*.ts'")).toEqual({ kind: "list", detail: "src", count: 1 });
});

test("what says nothing, or only trims, does not change what it is", () => {
  expect(commandLabel("rg foo | head -20 | wc -l")).toEqual({
    kind: "search",
    detail: "'foo'",
    count: 1,
  });
  expect(commandLabel("rg foo 2>/dev/null")).toEqual({ kind: "search", detail: "'foo'", count: 1 });
  expect(commandLabel("rg foo 2>&1")).toEqual({ kind: "search", detail: "'foo'", count: 1 });
  expect(commandLabel("cat a.ts; cat b.ts")).toEqual({
    kind: "read",
    detail: "a.ts, b.ts",
    count: 2,
  });
});

test("anything that could change something, or is not plain, is quoted as it is", () => {
  for (const command of [
    "bun test",
    "rg foo > out.txt",
    "cat a.ts >> b.ts",
    "cat a.ts > b",
    "sed -i 's/a/b/' a.ts",
    "sed -n -i 's/a/b/p' a.ts",
    "sed 's/a/b/' a.ts",
    "find . -name '*.tmp' -delete",
    "find . -exec rm {} ;",
    "cat $(ls)",
    "rg `whoami`",
    "diff <(cat a) <(cat b)",
    "rg foo && ls",
    "rm -rf build",
    "cat",
    "rg",
    "echo hi",
    "cat 'unterminated",
    "cat a.ts | tee b.ts",
    // Writes however the redirection is spelled.
    "cat a.ts>b.ts",
    'cat a.ts >"out.txt"',
    "cat a.ts >&out.txt",
    "cat a.ts >& out.txt",
    "rg foo &> out.txt",
    "rg foo >| out.txt",
    "cat <<EOF",
    // A sed that writes or runs.
    "sed -n 's/a/b/w out.txt' a.ts",
    "sed -n '1e touch x' a.ts",
    "sed -n '/x/p' a.ts",
    "sed -ni 's/a/b/p' a.ts",
    "sed -n -f script.sed a.ts",
    // A trim told to write.
    "rg foo | sort -o out.txt",
    "rg foo | uniq - out.txt",
    // Options that write or run.
    "tree -o out.txt src",
    "rg --pre ./x foo",
    "grep -f pats.txt src",
    // Somewhere else, which the label would not say.
    "cd packages/other && ls",
    "cd /etc && cat passwd",
    // Bundled short flags that write or read patterns from a file.
    "rg foo | sort -uo out.txt",
    "tree -ao out.txt src",
    "grep -rf pats.txt src",
    // less saves and runs things.
    "rg foo | less -o out.txt",
    "less '+!touch x' a.ts",
    // The project's own program, whatever it is called.
    "./ls",
    "scripts/cat x",
    "/tmp/x/rg foo",
  ])
    expect(commandLabel(command)).toBeUndefined();
  // A quoted operator is a word, not a write.
  expect(commandLabel("rg '>' src")).toEqual({ kind: "search", detail: "'>' in src", count: 1 });
});

test("continued lines, comments, each program's own flags, and find's own options", () => {
  expect(commandLabel("rg foo \\\n  src")).toEqual({
    kind: "search",
    detail: "'foo' in src",
    count: 1,
  });
  expect(commandLabel("ls # the folder")).toEqual({ kind: "list", detail: ".", count: 1 });
  expect(commandLabel("grep -T foo src")).toEqual({
    kind: "search",
    detail: "'foo' in src",
    count: 1,
  });
  expect(commandLabel("rg -r x foo src")).toEqual({
    kind: "search",
    detail: "'foo' in src",
    count: 1,
  });
  expect(commandLabel("find -L src -name x")).toEqual({ kind: "list", detail: "src", count: 1 });
  expect(commandLabel("rg foo 2>&1 | sort | uniq")).toEqual({
    kind: "search",
    detail: "'foo'",
    count: 1,
  });
  expect(commandLabel("cat a.ts >&2")).toEqual({ kind: "read", detail: "a.ts", count: 1 });
  expect(commandLabel("cd && ls")).toEqual({ kind: "list", detail: ".", count: 1 });
  expect(commandLabel("sed -n '1,40p;$p' src/a.ts")).toEqual({
    kind: "read",
    detail: "a.ts",
    count: 1,
  });
});

test("rg --files lists; a flag's value is no path; parts put together say each thing once", () => {
  expect(commandLabel("rg --files src")).toEqual({ kind: "list", detail: "src", count: 1 });
  expect(commandLabel("ls -I node_modules src")).toEqual({ kind: "list", detail: "src", count: 1 });
  expect(commandLabel("find -D tree src")).toEqual({ kind: "list", detail: "src", count: 1 });
  expect(commandLabel("cat a b c d; cat e f g h")).toEqual({
    kind: "read",
    detail: "a, b, c +5",
    count: 8,
  });
  expect(commandLabel("cat a.ts; cat a.ts")).toEqual({ kind: "read", detail: "a.ts", count: 1 });
});
