import { expect, test } from "bun:test";
import { codeReference, isPathLink, linkReference } from "../src/file-reference.ts";

const ROOT = "/home/dev/cycle";

test("inline code that names a file of the folder, relative or absolute, with a line or without", () => {
  expect(codeReference("packages/ui/src/app.tsx", ROOT)).toEqual({
    path: "packages/ui/src/app.tsx",
  });
  expect(codeReference("packages/ui/src/app.tsx:364", ROOT)).toEqual({
    path: "packages/ui/src/app.tsx",
    line: 364,
  });
  expect(codeReference("src/a.ts#L12-L20", ROOT)).toEqual({ path: "src/a.ts", line: 12 });
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
  expect(linkReference("file:///home/dev/cycle/x.ts", ROOT)).toEqual({ path: "x.ts" });
  expect(linkReference("cycle-file:../elsewhere.ts", ROOT)).toBeUndefined();
  expect(linkReference("https://example.com/a.ts", ROOT)).toBeUndefined();
});
