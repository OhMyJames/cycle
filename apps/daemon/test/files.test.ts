import { expect, test } from "bun:test";
import { Files } from "../src/index.ts";
import { FakeHarness } from "./fake-harness.ts";

function filesFinding(paths: string[]) {
  const harness = new FakeHarness();
  harness.searchFiles = async () => paths.map((path) => ({ path, directory: false }));
  return new Files(harness, () => []);
}

test("a search leaves out what is inside .git and keeps the rest", async () => {
  const files = filesFinding([".git/config", "a/.git/HEAD", "src/a.ts", ".github/ci.yml", "x.git"]);
  const found = await files.search("/project", "a");
  expect(found.map((match) => match.path)).toEqual(["src/a.ts", ".github/ci.yml", "x.git"]);
});

test("a search answers with sixty matches at most, and nothing for an empty query", async () => {
  const files = filesFinding(Array.from({ length: 100 }, (_, index) => `f${index}.ts`));
  expect(await files.search("/project", "f")).toHaveLength(60);
  expect(await files.search("/project", "  ")).toEqual([]);
});
