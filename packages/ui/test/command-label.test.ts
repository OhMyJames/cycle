import { expect, test } from "bun:test";
import { commandLabel } from "../src/model/command-label.ts";

test("a command that plainly searches, reads or lists is named for it", () => {
  expect(commandLabel("rg useSteady src")).toEqual({
    kind: "search",
    detail: "'useSteady' in src",
  });
  expect(commandLabel('grep -rn -e "a b" --include "*.ts" packages')).toEqual({
    kind: "search",
    detail: "'a b' in packages",
  });
  expect(commandLabel("rg -t ts TODO")).toEqual({ kind: "search", detail: "'TODO'" });
  expect(commandLabel("cat packages/ui/src/app.tsx")).toEqual({ kind: "read", detail: "app.tsx" });
  expect(commandLabel("head -n 40 a.ts b.ts c.ts d.ts")).toEqual({
    kind: "read",
    detail: "a.ts, b.ts, c.ts +1",
  });
  expect(commandLabel("sed -n '1,40p' src/a.ts")).toEqual({ kind: "read", detail: "a.ts" });
  expect(commandLabel("ls -la src")).toEqual({ kind: "list", detail: "src" });
  expect(commandLabel("ls")).toEqual({ kind: "list", detail: "." });
  expect(commandLabel("find src -name '*.ts'")).toEqual({ kind: "list", detail: "src" });
});

test("what says nothing, or only trims, does not change what it is", () => {
  expect(commandLabel("cd packages/ui && rg foo")).toEqual({ kind: "search", detail: "'foo'" });
  expect(commandLabel("rg foo | head -20 | wc -l")).toEqual({ kind: "search", detail: "'foo'" });
  expect(commandLabel("rg foo 2>/dev/null")).toEqual({ kind: "search", detail: "'foo'" });
  expect(commandLabel("rg foo 2>&1")).toEqual({ kind: "search", detail: "'foo'" });
  expect(commandLabel("cat a.ts; cat b.ts")).toEqual({ kind: "read", detail: "a.ts, b.ts" });
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
  ])
    expect(commandLabel(command)).toBeUndefined();
  // A quoted operator is a word, not a write.
  expect(commandLabel("rg '>' src")).toEqual({ kind: "search", detail: "'>' in src" });
});
