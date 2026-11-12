import { describe, expect, test } from "bun:test";
import {
  analyzeFile,
  checkPackage,
  checkPinnedVersions,
  checkTestPlacement,
  isGeneratedPath,
  MAX_TEST_FILE_LINES,
  type Manifest,
} from "../lib/boundaries.ts";

const DIRS: Readonly<Record<string, string>> = {
  "@cycle/protocol": "packages/protocol",
  "@cycle/ui": "packages/ui",
  "@cycle/harness-codex": "harness/codex",
  "@cycle/daemon": "apps/daemon",
  "@cycle/desktop": "apps/desktop",
};

/** What each package declares, as its package.json does. */
const DECLARED: Readonly<Record<string, Record<string, string>>> = {
  "@cycle/ui": { "@cycle/protocol": "workspace:*", react: "19.3.1", "@xterm/xterm": "6.0.0" },
  "@cycle/harness-codex": { "@cycle/protocol": "workspace:*", "@openai/codex": "0.167.2" },
  "@cycle/daemon": { "@cycle/protocol": "workspace:*", "@cycle/harness-codex": "workspace:*" },
  "@cycle/desktop": { "@cycle/ui": "workspace:*", react: "19.3.1", electron: "39.8.10" },
};

type Options = { dependencies?: Record<string, string>; hasTestProject?: boolean };

/** The violations of one file, at a path relative to its package, joined into one string. */
function check(name: string, relativePath: string, code: string, options: Options = {}): string {
  const dir = DIRS[name] ?? "packages/new";
  const manifest: Manifest = { name, dependencies: options.dependencies ?? DECLARED[name] ?? {} };
  return checkPackage({
    dir,
    manifest,
    files: [{ path: `${dir}/${relativePath}`, code }],
    hasTestProject: options.hasTestProject ?? true,
  })
    .map((violation) => violation.message)
    .join("\n");
}

const desktop = (path: string, code: string, options?: Options): string =>
  check("@cycle/desktop", path, code, options);

const declares = (dependencies: Record<string, string>): string =>
  desktop("src/renderer/a.tsx", "", { dependencies });

describe("analyzeFile", () => {
  test("finds every form of module reference", () => {
    const { specifiers, errors } = analyzeFile(
      "a.ts",
      `
      import a from "value-import";
      import type { B } from "type-import";
      import { type C } from "inline-type-import";
      import {
        type D,
      } from 'wrapped-import';
      export { d } from "re-export";
      export type { E } from "type-re-export";
      export * from "export-all";
      export * as all from "export-namespace";
      import "side-effect";
      const e = await import("dynamic-import");
      type F = typeof import("import-type");
      import g = require("import-equals");
      const h = require("require-call");
      export const used = [a, e, g, h] as const;
      export type Used = B | C | D | F;
      `,
    );
    expect(errors).toEqual([]);
    expect(specifiers.toSorted()).toEqual(
      [
        "value-import",
        "type-import",
        "inline-type-import",
        "wrapped-import",
        "re-export",
        "type-re-export",
        "export-all",
        "export-namespace",
        "side-effect",
        "dynamic-import",
        "import-type",
        "import-equals",
        "require-call",
      ].toSorted(),
    );
  });

  test("reads only code, not what strings, comments and regular expressions say", () => {
    const { specifiers, members, calls } = analyzeFile(
      "a.tsx",
      `
      // import "in-a-comment"; fetch(1); Bun.spawn();
      /* export * from "in-a-block"; */
      const text = 'import x from "in-a-string"; fetch(2)';
      const template = \`import "in-a-template"; \${real.member} Bun.file()\`;
      const pattern = /from "in-a-regex" fetch\\(/;
      const half = total / 2; // setTimeout(f)
      const view = <p className="a">a</p>;
      called(new Built(), thing.other?.deep);
      `,
    );
    expect(specifiers).toEqual([]);
    expect([...members].toSorted()).toEqual(["real.member", "thing.other"]);
    expect([...calls].toSorted()).toEqual(["Built", "called"]);
  });

  test("a function or a method with a banned name is not a call to it", () => {
    const { calls } = analyzeFile(
      "a.ts",
      `
      function setTimeout(run: () => void): void { run(); }
      const fake = { fetch(url: string) { return url; }, async close() {} };
      if (ready(fake)) { go(); }
      `,
    );
    expect([...calls].toSorted()).toEqual(["go", "ready", "run"]);
  });

  test("a file that does not parse is an error", () => {
    expect(analyzeFile("a.ts", "const = ;").errors).toHaveLength(1);
    expect(check("@cycle/daemon", "src/a.ts", "const = ;")).toContain("parse error");
  });
});

describe("architecture rules", () => {
  test.each([
    ["@cycle/protocol", "src/index.ts", `export * from "./wire.ts";`],
    ["@cycle/ui", "src/App.tsx", `import "@cycle/protocol"; import "react"; import "./a.css";`],
    ["@cycle/ui", "src/terminal.tsx", `import { Terminal } from "@xterm/xterm";`],
    [
      "@cycle/harness-codex",
      "src/rpc.ts",
      `import "node:child_process"; import "@cycle/protocol";`,
    ],
    ["@cycle/harness-codex", "src/bin.ts", `import "@openai/codex";`],
    ["@cycle/daemon", "src/main.ts", `import "@cycle/harness-codex"; import "bun";`],
    ["@cycle/desktop", "src/renderer/index.tsx", `import "@cycle/ui"; import "react";`],
    ["@cycle/desktop", "src/renderer/index.tsx", `import "@cycle/ui/styles.css";`],
    ["@cycle/desktop", "src/main.ts", `import "electron"; import "node:path";`],
    ["@cycle/desktop", "src/preload.ts", `import { contextBridge } from "electron";`],
    ["@cycle/desktop", "build.ts", `import "node:fs"; import "./src/main.ts";`],
    ["@cycle/desktop", "src/main.ts", `import "./channels.ts";`],
  ])("%s %s may: %s", (name, path, code) => {
    expect(check(name, path, code)).toBe("");
  });

  test.each([
    ["@cycle/protocol", "src/index.ts", `import "bun";`, "runtime module"],
    ["@cycle/protocol", "src/index.ts", `import "@cycle/ui";`, "may not import @cycle/ui"],
    ["@cycle/protocol", "src/index.ts", `import "zod";`, "may not import zod"],
    ["@cycle/ui", "src/client.ts", `import "node:fs";`, "runtime module"],
    ["@cycle/ui", "src/client.ts", `import "fs/promises";`, "runtime module"],
    ["@cycle/ui", "src/client.ts", `import "bun:sqlite";`, "runtime module"],
    ["@cycle/ui", "src/client.ts", `import "@cycle/daemon";`, "may not import @cycle/daemon"],
    // A type-only import is still one.
    [
      "@cycle/ui",
      "src/client.ts",
      `import type { T } from "@cycle/harness-codex"; export type U = T;`,
      "may not import @cycle/harness-codex",
    ],
    ["@cycle/ui", "src/client.ts", `import "@openai/codex";`, "may not import @openai/codex"],
    ["@cycle/ui", "src/client.ts", `import "marked";`, "not declared in package.json"],
    ["@cycle/ui", "src/a.ts", `import "@cycle/protocol/src/wire.ts";`, "import its root"],
    ["@cycle/ui", "src/a.ts", `import "../../protocol/src/index.ts";`, "outside the package"],
    ["@cycle/ui", "src/a.ts", `import "/etc/passwd";`, "is an absolute path"],
    ["@cycle/ui", "src/a.ts", `const m = "x"; await import(m);`, "computed imports"],
    ["@cycle/ui", "src/a.ts", "await import(`./${name}.ts`);", "computed imports"],
    ["@cycle/daemon", "src/main.ts", `import "@openai/codex";`, "may not import @openai/codex"],
    ["@cycle/daemon", "src/main.ts", `import "@cycle/ui";`, "may not import @cycle/ui"],
    ["@cycle/desktop", "src/renderer/a.tsx", `import "node:fs";`, "runtime module"],
    ["@cycle/desktop", "src/renderer/a.tsx", `import "electron";`, "may not import electron"],
    ["@cycle/desktop", "src/renderer/a.tsx", `import "../main.ts";`, "another platform"],
    ["@cycle/desktop", "src/renderer/a.tsx", `import "@cycle/ui/src/App.tsx";`, "import its root"],
    ["@cycle/desktop", "src/main.ts", `import "@cycle/ui";`, "may not import @cycle/ui"],
    ["@cycle/desktop", "src/main.ts", `import "react";`, "may not import react"],
    ["@cycle/new", "src/index.ts", "", "no entry in RULES"],
  ])("%s %s may not: %s", (name, path, code, message) => {
    expect(check(name, path, code)).toContain(message);
  });

  test("a dependency is checked even unused, against every scope of its package", () => {
    expect(declares({ electron: "39.8.10", "@types/node": "26.6.6" })).toBe("");
    expect(declares({ hono: "1.0.0" })).toContain("may not depend on hono");
    expect(declares({ "@cycle/daemon": "workspace:*" })).toContain("may not depend on");
    expect(declares({ react: "^19.0.0" })).toContain("must be an exact version");
  });
});

describe("generated trees", () => {
  test.each([
    "node_modules/a/index.ts",
    "apps/desktop/node_modules/a/index.ts",
    "build/index.ts",
    "apps/desktop/dist/main.cjs",
    "dist/index.js",
  ])("%s is generated", (path) => {
    expect(isGeneratedPath(path)).toBe(true);
  });

  test.each(["apps/desktop/build.ts", "packages/ui/src/dist.ts", "src/builder/a.ts"])(
    "%s is ours",
    (path) => {
      expect(isGeneratedPath(path)).toBe(false);
    },
  );
});

describe("checkPinnedVersions", () => {
  test.each(["^1.0.0", "~1.0.0", "*", "latest", ">=1", "1.x"])("rejects %s", (version) => {
    expect(checkPinnedVersions("x", { dependencies: { a: version } })).toHaveLength(1);
  });

  test.each(["1.2.3", "7.1.0-beta", "workspace:*"])("accepts %s", (version) => {
    expect(checkPinnedVersions("x", { devDependencies: { a: version } })).toEqual([]);
  });
});

describe("test rules", () => {
  test.each([
    ["src/a.test.ts", 1],
    ["apps/desktop/src/a.test.ts", 1],
    ["apps/desktop/a.spec.tsx", 1],
    ["scripts/lib/a.test.ts", 1],
    ["a.test.ts", 1],
    ["apps/desktop/test/a.test.ts", 0],
    ["apps/desktop/test/integration/a.test.ts", 0],
    ["packages/ui/test/nested/a.spec.tsx", 0],
    ["scripts/test/a.test.ts", 0],
    ["apps/desktop/src/not-a-test.ts", 0],
  ])("placement of %s has %i violation(s)", (path, count) => {
    expect(checkTestPlacement([path])).toHaveLength(count);
  });

  test("source may not import from test/, and a test may import any source", () => {
    expect(desktop("src/renderer/a.ts", `import "../../test/helper.ts";`)).toContain(
      "may not import from test/",
    );
    expect(desktop("test/a.test.ts", `import "../src/main.ts"; import "./helper.ts";`)).toBe("");
  });

  test("tests in a platform-neutral package may use runtime modules", () => {
    expect(desktop("test/a.test.ts", `import "bun:test"; import "node:path";`)).toBe("");
    expect(desktop("src/renderer/a.ts", `import "bun:test";`)).toContain("runtime module");
  });

  test("tests still obey the architecture", () => {
    expect(desktop("test/a.test.ts", `import "@cycle/daemon";`)).toContain(
      "may not import @cycle/daemon",
    );
    expect(desktop("test/a.test.ts", `import "../../daemon/src/main.ts";`)).toContain(
      "outside the package",
    );
  });

  test("a package with tests needs a test project", () => {
    expect(desktop("test/a.test.ts", "", { hasTestProject: false })).toContain(
      "test/tsconfig.json is missing",
    );
    expect(desktop("src/renderer/a.ts", "", { hasTestProject: false })).toBe("");
  });

  test.each([
    `test.only("x", () => {});`,
    `test.skip("x", () => {});`,
    `test.skip.each([1])("x", () => {});`,
    `it.todo("x");`,
    `describe.only("x", () => {});`,
    `test.skipIf(true)("x", () => {});`,
  ])("no test may be focused or disabled: %s", (code) => {
    expect(desktop("test/integration/a.test.ts", code)).toContain("a test must run, or be deleted");
  });

  test.each([
    `import "node:child_process";`,
    `import { readFile } from "node:fs/promises";`,
    `import "fs";`,
    `import "node:net";`,
    `import type { Server } from "node:http";`,
    `import "bun:sqlite";`,
    `Bun.spawn(["x"]);`,
    `await Bun.sleep(1);`,
    `Bun.serve({ fetch: () => new Response() });`,
    `Bun.file("x");`,
    `await Bun.write("x", "y");`,
    `await fetch("http://x");`,
    `setTimeout(() => {}, 1);`,
    `const timer = setInterval(tick, 1);`,
    `new WebSocket("ws://x");`,
  ])("a unit test may not do I/O or wait: %s", (code) => {
    expect(desktop("test/a.test.ts", code)).toContain("move the test to test/integration/");
    expect(desktop("test/integration/a.test.ts", code)).toBe("");
  });

  test("an oversized test file fails", () => {
    const code = "\n".repeat(MAX_TEST_FILE_LINES);
    expect(desktop("test/a.test.ts", code)).toContain("split it or make it table-driven");
    expect(desktop("test/a.test.ts", "\n".repeat(MAX_TEST_FILE_LINES - 1))).toBe("");
  });
});
