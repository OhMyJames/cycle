import { expect, test } from "bun:test";
import { matchNames, matchPaths, matchSkills, sectioned, skillRows } from "../src/lib/suggest.ts";

const names = (rows: readonly { name: string }[]) => rows.map((row) => row.name);
const skill = (name: string) => ({ name, description: "" });

test("a name that starts with the query comes before one that holds it", () => {
  const rows = [skill("archive"), skill("compact"), skill("search")];
  expect(names(matchNames(rows, "c"))).toEqual(["compact", "archive", "search"]);
  expect(names(matchNames(rows, ""))).toEqual(["archive", "compact", "search"]);
  expect(matchNames(rows, "zz")).toEqual([]);
});

test("a plugin's skills are one row, and a colon looks among them", () => {
  const rows = skillRows([
    skill("figma:use"),
    skill("review"),
    skill("figma:make"),
    skill("solo:only"),
  ]);
  expect(names(rows)).toEqual(["figma", "review", "solo:only"]);
  expect(rows[0]?.description).toBe("2 skills · the agent picks");
  expect(names(matchSkills(rows, "fig"))).toEqual(["figma"]);
  expect(names(matchSkills(rows, "figma:m"))).toEqual(["figma:make"]);
});

test("a plugin stays apart when a skill already has its name", () => {
  const rows = skillRows([skill("docs"), skill("docs:read"), skill("docs:write")]);
  expect(names(rows)).toEqual(["docs", "docs:read", "docs:write"]);
});

const paths = (rows: readonly { path: string }[]) => rows.map((row) => row.path);
const file = (path: string) => ({ path, directory: false });
const folder = (path: string) => ({ path, directory: true });

test("with nothing typed, folders come first and hidden entries stay out", () => {
  const rows = [file("README.md"), folder("src"), file(".env"), folder(".git")];
  expect(paths(matchPaths(rows, ""))).toEqual(["src", "README.md"]);
});

test("paths rank by name, then by path, shortest first", () => {
  const rows = [
    file("docs/app-notes.md"),
    file("src/app.ts"),
    file("src/application/index.ts"),
    file("src/zapper.ts"),
    file("app/main.ts"),
  ];
  expect(paths(matchPaths(rows, "app"))).toEqual([
    "src/app.ts",
    "docs/app-notes.md",
    "src/zapper.ts",
    "app/main.ts",
    "src/application/index.ts",
  ]);
  expect(paths(matchPaths(rows, "src/a"))).toEqual(["src/app.ts", "src/application/index.ts"]);
});

test("a hidden file shows only when the query asks for one", () => {
  const rows = [file(".env"), file("env.ts")];
  expect(paths(matchPaths(rows, "env"))).toEqual(["env.ts"]);
  expect(paths(matchPaths(rows, ".env"))).toEqual([".env"]);
});

test("no more than eight paths show", () => {
  const rows = Array.from({ length: 20 }, (_, index) => file(`a${index}.ts`));
  expect(matchPaths(rows, "a")).toHaveLength(8);
});

test("rows get headings only when there is more than one kind", () => {
  const one = [{ group: "Files", label: "a" }];
  expect(sectioned(one)).toEqual(one);
  const two = [
    { group: "Commands", label: "/new" },
    { group: "Skills", label: "$review" },
    { group: "Commands", label: "/fork" },
  ];
  expect(sectioned(two)).toEqual([
    { heading: "Commands" },
    { group: "Commands", label: "/new" },
    { group: "Commands", label: "/fork" },
    { heading: "Skills" },
    { group: "Skills", label: "$review" },
  ]);
});
