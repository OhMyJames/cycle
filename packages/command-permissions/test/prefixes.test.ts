import { describe, expect, test } from "bun:test";
import { commandPrefixes } from "../src/index.ts";

describe("commandPrefixes", () => {
  test("one prefix per segment of a chain", () => {
    expect(commandPrefixes("git status")).toEqual(["git status"]);
    expect(commandPrefixes("ls -la")).toEqual(["ls -la"]);
    expect(commandPrefixes("git -C repo status")).toEqual(["git -C repo"]);
    expect(commandPrefixes("cd src && git diff | grep foo")).toEqual([
      "cd src",
      "git diff",
      "grep foo",
    ]);
  });
  test("what cannot be judged by segments is not remembered", () => {
    for (const c of [
      "echo $(rm -rf x)",
      "echo `id`",
      "echo hi > out.txt",
      "sudo ls",
      "bash -c 'ls'",
      "FOO=1 ls",
      "ls\nrm x",
      "ls & rm -rf ~",
      "(ls)",
      "! ls",
      "python -c 'x'",
      "find . -exec rm {} +",
    ]) {
      expect(commandPrefixes(c)).toBeUndefined();
    }
  });
});
