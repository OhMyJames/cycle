import { expect, test } from "bun:test";
import { codeReference, isPathLink, linkReference, pathLinkUrl } from "../src/file-reference.ts";

const ROOT = "/home/dev/cycle";

test("inline code that names a file of the folder, relative or absolute, with a line or without", () => {
  expect(codeReference("packages/ui/src/app.tsx", ROOT)).toEqual({
    path: "packages/ui/src/app.tsx",
  });
  expect(codeReference("packages/ui/src/app.tsx:364", ROOT)).toEqual({
    path: "packages/ui/src/app.tsx",
    line: 364,
  });
  expect(codeReference("src/a.ts#L12-L20", ROOT)).toEqual({ path: "src/a.ts", line: 12, end: 20 });
  expect(codeReference("src/a.ts:12-20", ROOT)).toEqual({ path: "src/a.ts", line: 12, end: 20 });
  expect(codeReference("src/a.ts#L12-20", ROOT)).toEqual({ path: "src/a.ts", line: 12, end: 20 });
  // A column is not the end of a range; a range that does not go past its start is its one line.
  expect(codeReference("src/a.ts:12:3", ROOT)).toEqual({ path: "src/a.ts", line: 12 });
  expect(codeReference("src/a.ts:12-12", ROOT)).toEqual({ path: "src/a.ts", line: 12 });
  expect(codeReference("src/a.ts:12-4", ROOT)).toEqual({ path: "src/a.ts", line: 12 });
  expect(codeReference("/home/dev/cycle/README.md", ROOT)).toEqual({ path: "README.md" });
  expect(codeReference("./docs/../README.md", ROOT)).toEqual({ path: "README.md" });
  expect(codeReference("package.json", ROOT)).toEqual({ path: "package.json" });
});

test("inline code that could as well be code, a command, a package or somewhere else stays text", () => {
  for (const text of [
    "state.active",
    "process.env",
    "bun test",
    "src/*.ts",
    "@ui-sdk/react",
    "~/notes.md",
    "--watch",
    "https://bun.sh/docs.md",
    "fn(a.ts)",
    "/etc/hosts.conf",
    "../outside/file.ts",
    "src/folder",
    "/home/dev/cycle/packages",
    "github.com/user/repo.git",
    "example.com/index.html",
  ])
    expect(codeReference(text, ROOT)).toBeUndefined();
});

test("a link to a path is one to show; an address, a fragment or a path outside is not", () => {
  expect(isPathLink("src/app.tsx")).toBe(true);
  expect(isPathLink("src/app.tsx:12")).toBe(true);
  expect(isPathLink("https://bun.sh")).toBe(false);
  expect(isPathLink("mailto:a@b.c")).toBe(false);
  expect(isPathLink("#section")).toBe(false);
  expect(linkReference("cycle-file:apps/daemon/src/connection-manager.ts", ROOT)).toEqual({
    path: "apps/daemon/src/connection-manager.ts",
  });
  expect(linkReference("cycle-file:/home/dev/cycle/a%20b.md#L3", ROOT)).toEqual({
    path: "a b.md",
    line: 3,
  });
  expect(linkReference("cycle-file:src/x.ts#L3-L9", ROOT)).toEqual({
    path: "src/x.ts",
    line: 3,
    end: 9,
  });
  expect(linkReference("file:///home/dev/cycle/x.ts", ROOT)).toEqual({ path: "x.ts" });
  expect(linkReference("cycle-file:file:///home/dev/cycle/x.ts", ROOT)).toEqual({ path: "x.ts" });
  expect(linkReference("cycle-file:packages/ui/", ROOT)).toEqual({
    path: "packages/ui",
    folder: true,
  });
  expect(linkReference("cycle-file:../elsewhere.ts", ROOT)).toBeUndefined();
  expect(linkReference("https://example.com/a.ts", ROOT)).toBeUndefined();
});

test("a link to a file is made a path the link checks keep, an address is not touched", () => {
  expect(pathLinkUrl("file:///home/dev/cycle/x.ts")).toBe("/home/dev/cycle/x.ts");
  expect(pathLinkUrl("app.tsx:12")).toBe("./app.tsx:12");
  expect(pathLinkUrl("src/app.tsx:12")).toBe("src/app.tsx:12");
  expect(pathLinkUrl("https://bun.sh")).toBe("https://bun.sh");
  expect(pathLinkUrl("mailto:a@b.c")).toBe("mailto:a@b.c");
});
