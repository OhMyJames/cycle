import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { importsOf, violations, zoneOf } from "./boundaries.ts";

const root = new URL("..", import.meta.url).pathname;

describe("importsOf", () => {
  test("finds static, type, side-effect, re-export, multi-line, dynamic and require", () => {
    const text = [
      'import a from "a";',
      'import type { B } from "b";',
      'import "c";',
      'export * from "d";',
      'export { e } from "e";',
      "import {",
      "  f,",
      "  g,",
      '} from "fg";',
      'const h = await import("h");',
      'const i = require("i");',
    ].join("\n");
    expect(importsOf(text).sort()).toEqual(["a", "b", "c", "d", "e", "fg", "h", "i"]);
  });

  test("several on one line, and ones with comments and quotes inside", () => {
    expect(importsOf('import a from "a"; import r from "react"; export * from "b";')).toEqual([
      "a",
      "react",
      "b",
    ]);
    expect(importsOf('import {\n  a, // it\'s\n  b /* "x" */,\n} from "node:fs";')).toEqual([
      "node:fs",
    ]);
    expect(importsOf("const m = await import(`node:fs`);")).toEqual(["node:fs"]);
    expect(importsOf('import def, { a as b } from "m"; import * as ns from "n";')).toEqual([
      "m",
      "n",
    ]);
    expect(importsOf('import type def from "t"; export type { A } from "u";')).toEqual(["t", "u"]);
    expect(importsOf('import x = require("y");')).toEqual(["y"]);
    expect(importsOf("export const a = 1\nexport { b }\nimport.meta.url;")).toEqual([]);
  });

  test("a template literal with a substitution in it is not a module name; foo.import(...) is not an import", () => {
    expect(importsOf(`await import(\`./x/$${"{name}"}.ts\`);`)).toEqual([]);
    expect(importsOf('foo.import("zzz"); foo.require("zzz");')).toEqual([]);
  });

  test("a block comment holding an import, and a string holding a require, are nothing", () => {
    expect(importsOf('/*\nimport x from "node:fs";\n*/')).toEqual([]);
    expect(importsOf("const s = \"call require('fs')\";")).toEqual([]);
  });

  test("takes time in proportion to the text, with or without semicolons", () => {
    const started = performance.now();
    importsOf("export const a = 1\n".repeat(200_000));
    importsOf("import a\n".repeat(200_000));
    importsOf("import {\n".repeat(50_000));
    expect(performance.now() - started).toBeLessThan(3000);
  });

  test("a comment or a string that looks like an import is not one", () => {
    const text = [
      '// import x from "in-comment";',
      "/*",
      ' * import y from "in-block-comment";',
      " */",
      "const s = \"import z from 'in-string'\";",
    ].join("\n");
    expect(importsOf(text)).toEqual([]);
  });
});

describe("zones", () => {
  test.each([
    ["packages/ui/src/model/blocks.ts", ["model", "renderer"]],
    ["packages/ui/src/api.ts", ["model", "renderer"]],
    ["packages/ui/src/react/app.tsx", ["renderer"]],
    ["apps/desktop/src/renderer/main.tsx", ["renderer"]],
    ["apps/desktop/src/preload/preload.ts", ["preload"]],
    ["apps/desktop/src/main/app.ts", []],
    ["apps/daemon/src/daemon.ts", []],
    ["packages/ui/test/store.test.ts", []],
  ])("%s", (file, zones) => expect(zoneOf(file)).toEqual(zones as never));
});

// [file, source, whether it is refused]
const cases: [string, string, boolean][] = [
  // The model
  ["packages/ui/src/model/x.ts", 'import react from "react";', true],
  ["packages/ui/src/model/x.ts", 'import { a } from "node:fs";', true],
  ["packages/ui/src/model/x.ts", 'import { a } from "@cycle/daemon";', true],
  ["packages/ui/src/model/x.ts", 'import { a } from "lexical";', true],
  [
    "packages/ui/src/model/x.ts",
    'import type { U } from "@agentclientprotocol/sdk/experimental/v2";',
    false,
  ],
  ["packages/ui/src/model/x.ts", 'import { a } from "./blocks.ts";', false],
  ["packages/ui/src/api.ts", 'import type { C } from "./model/index.ts";', false],
  ["packages/ui/src/api.ts", 'import { useState } from "react";', true],
  ["packages/ui/src/model/x.ts", 'import { a } from "../react/index.ts";', true],
  ["packages/ui/src/model/x.ts", 'import { a } from "../store/store.ts";', true],
  [
    "packages/ui/src/model/x.ts",
    'import { a } from "../../../../apps/desktop/src/main/app.ts";',
    true,
  ],
  ["packages/ui/src/model/x.ts", 'import { a } from "../api.ts";', false],
  ["packages/ui/src/model/x.ts", 'import { a } from "./sub/y.ts";', false],
  ["packages/ui/src/api.ts", 'import { a } from "./react/index.ts";', true],
  ["packages/ui/src/model/x.ts", 'import a from "a"; import r from "react";', true],
  ["packages/ui/src/model/x.ts", 'import {\n a, // it\'s\n} from "node:fs";', true],
  // The page
  ["apps/desktop/src/renderer/main.tsx", 'import { readFile } from "node:fs";', true],
  ["apps/desktop/src/renderer/main.tsx", 'import { join } from "path";', true],
  ["apps/desktop/src/renderer/main.tsx", 'import { app } from "electron";', true],
  ["apps/desktop/src/renderer/main.tsx", 'import { x } from "@cycle/daemon";', true],
  ["apps/desktop/src/renderer/main.tsx", 'import { x } from "@cycle/client";', true],
  ["apps/desktop/src/renderer/main.tsx", 'const m = await import("node:os");', true],
  ["apps/desktop/src/renderer/main.tsx", 'import { x } from "@cycle/protocol";', true],
  ["apps/desktop/src/renderer/main.tsx", 'import { x } from "@cycle/desktop";', true],
  ["apps/desktop/src/renderer/main.tsx", 'import { x } from "@cycle/harness-claude";', true],
  ["apps/desktop/src/renderer/main.tsx", 'import { x } from "module";', true],
  ["apps/desktop/src/renderer/main.tsx", 'import { x } from "tty";', true],
  ["apps/desktop/src/renderer/main.tsx", 'import { x } from "vm";', true],
  ["apps/desktop/src/renderer/main.tsx", 'import { x } from "fs/promises";', true],
  ["apps/desktop/src/renderer/main.tsx", 'import { x } from "bun:sqlite";', true],
  ["apps/desktop/src/renderer/main.tsx", 'import { x } from "bun";', true],
  ["packages/ui/src/react/app.tsx", 'import { x } from "bun:test";', true],
  ["packages/ui/src/react/app.tsx", 'import { api } from "@cycle/ui/api";', false],
  ["packages/ui/src/react/app.tsx", 'import { createRoot } from "react-dom/client";', false],
  ["packages/ui/src/store/store.ts", 'import { applyUpdate } from "../model/index.ts";', false],
  // The preload
  ["apps/desktop/src/preload/preload.ts", 'import { x } from "@cycle/daemon";', true],
  ["apps/desktop/src/preload/preload.ts", 'import { x } from "@cycle/daemon/src/daemon.ts";', true],
  ["apps/desktop/src/preload/preload.ts", 'import { x } from "../main/app.ts";', true],
  ["apps/desktop/src/preload/preload.ts", 'import { x } from "./helper.ts";', true],
  ["apps/desktop/src/preload/preload.ts", 'import { x } from "electron/renderer";', false],
  ["apps/desktop/src/preload/preload.ts", 'import { x } from "node:fs";', true],
  ["apps/desktop/src/preload/preload.ts", 'import { x } from "react";', true],
  ["apps/desktop/src/preload/preload.ts", 'import { x } from "@cycle/ui";', true],
  [
    "apps/desktop/src/preload/preload.ts",
    'import { API_METHODS, type AppEvent } from "@cycle/ui/api";\nimport { contextBridge, ipcRenderer } from "electron";',
    false,
  ],
  // Elsewhere is not these rules' business
  ["apps/desktop/src/main/app.ts", 'import { readFile } from "node:fs";', false],
  ["apps/daemon/src/daemon.ts", 'import { x } from "node:fs";', false],
];

describe("import rules", () => {
  test.each(cases)("%s: %s", (file, text, refused) => {
    expect(violations(file, text).length > 0).toBe(refused);
  });

  test("the message names the file, the zone and the module", () => {
    const [line] = violations("packages/ui/src/model/x.ts", 'import { useState } from "react";');
    expect(line).toContain("packages/ui/src/model/x.ts");
    expect(line).toContain("model");
    expect(line).toContain('"react"');
  });
});

// The type environments: the globals that a type check can see.
const tsc = join(root, "node_modules/typescript/bin/tsc");
const scratch = join(root, "node_modules/.cache");
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(join(scratch, "boundaries-"));

const typeErrors = (config: string, source: string, extraEnv?: Record<string, string>): string => {
  const sub = mkdtempSync(join(dir, "case-"));
  writeFileSync(join(sub, "case.ts"), source);
  writeFileSync(
    join(sub, "tsconfig.json"),
    JSON.stringify({ extends: join(root, config), include: ["./case.ts"] }),
  );
  const out = Bun.spawnSync(["bun", tsc, "--pretty", "false", "-p", join(sub, "tsconfig.json")], {
    cwd: sub,
    ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
  });
  return new TextDecoder().decode(out.stdout);
};

describe("type environments", () => {
  test("the model sees no document, window, process or Bun", () => {
    for (const global of ["document.title", "window.name", "process.pid", "Bun.version"])
      expect(typeErrors("tsconfig.model.json", `export const x = ${global};`)).toContain(
        "error TS",
      );
  });

  test("type diagnostics stay plain even when color output is forced", () => {
    const out = typeErrors("tsconfig.model.json", "export const x = document.title;", {
      FORCE_COLOR: "1",
    });
    expect(out).toContain("error TS");
    expect(out).not.toContain(`${String.fromCharCode(27)}[`);
  });

  test("the model may use plain TypeScript and the bridge's types", () => {
    const source = [
      `import type { AppEvent } from "${join(root, "packages/ui/src/api.ts")}";`,
      "export const x = (e: AppEvent): string => JSON.stringify([e, new Map<string, number>()]);",
    ].join("\n");
    expect(typeErrors("tsconfig.model.json", source)).toBe("");
  });

  test("the page sees the DOM, and no Node or Bun", () => {
    expect(typeErrors("tsconfig.renderer.json", "export const x = document.title;")).toBe("");
    expect(typeErrors("tsconfig.renderer.json", "export const x = process.pid;")).toContain(
      "error TS",
    );
    expect(typeErrors("tsconfig.renderer.json", "export const x = Bun.version;")).toContain(
      "error TS",
    );
    expect(
      typeErrors(
        "tsconfig.renderer.json",
        'import { readFileSync } from "node:fs";\nreadFileSync;',
      ),
    ).toContain("error TS");
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));
