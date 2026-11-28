// Which module may import which, by zone. The type environments (tsconfig.model.json, tsconfig.renderer.json) keep
// the wrong globals out (document in the model, node:fs or Bun in the page); a type check cannot say that
// the model may not import React or that the preload may not reach the daemon, so that is here.
//
//   model     packages/ui/src/model, packages/ui/src/api.ts: pure TypeScript. The Electron main process runs
//             it too (packages/ui/AGENTS.md), and the preload and the page share the bridge contract in api.ts.
//   renderer  the page: apps/desktop/src/renderer and all of packages/ui/src. Browser code: no Node, no
//             Electron, no Bun, and nothing that starts or talks to the daemon directly (it goes by the bridge).
//   preload   apps/desktop/src/preload: sandboxed. electron, and the bridge contract from @cycle/ui/api, nothing else.
//   app       apps/desktop/src and packages/ui/src: they talk to the Loop server by the protocol in @cycle/protocol, and
//             never import cloud/loop (docs/protocol.md §17).

import { builtinModules } from "node:module";
import { posix } from "node:path";
import { type Argument, parseSync, Visitor } from "oxc-parser";

export type Zone = "model" | "renderer" | "preload" | "app" | "loop-engine";

export const zoneOf = (file: string): Zone[] => {
  const zones: Zone[] = [];
  if (file.startsWith("packages/ui/src/model/") || file === "packages/ui/src/api.ts")
    zones.push("model");
  if (file.startsWith("packages/ui/src/") || file.startsWith("apps/desktop/src/renderer/"))
    zones.push("renderer");
  if (file.startsWith("apps/desktop/src/preload/")) zones.push("preload");
  if (file.startsWith("apps/desktop/src/") || file.startsWith("packages/ui/src/"))
    zones.push("app");
  if (file.startsWith("cloud/loop/src/engine/")) zones.push("loop-engine");
  return zones;
};

/** Literal module references, including types checked at the model and bridge boundaries. */
export const moduleReferences = (text: string, file = "source.ts") => {
  const references: { name: string; typeOnly: boolean }[] = [];
  const collect = (source: Argument | null | undefined, typeOnly = false) => {
    const name =
      source?.type === "Literal"
        ? source.value
        : source?.type === "TemplateLiteral" && source.expressions.length === 0
          ? source.quasis[0]?.value.cooked
          : undefined;
    if (typeof name === "string") references.push({ name, typeOnly });
  };
  new Visitor({
    ImportDeclaration: (node) =>
      collect(
        node.source,
        node.importKind === "type" ||
          (node.specifiers.length > 0 &&
            node.specifiers.every((s) => s.type === "ImportSpecifier" && s.importKind === "type")),
      ),
    ExportNamedDeclaration: (node) =>
      collect(
        node.source,
        node.exportKind === "type" ||
          (node.specifiers.length > 0 && node.specifiers.every((s) => s.exportKind === "type")),
      ),
    ExportAllDeclaration: (node) => collect(node.source, node.exportKind === "type"),
    ImportExpression: (node) => collect(node.source),
    TSImportType: (node) => collect(node.source, true),
    TSImportEqualsDeclaration: (node) => {
      if (node.moduleReference.type === "TSExternalModuleReference")
        collect(node.moduleReference.expression, node.importKind === "type");
    },
    CallExpression: (node) => {
      if (node.callee.type === "Identifier" && node.callee.name === "require") {
        collect(node.arguments[0]);
      }
    },
  }).visit(parseSync(file, text).program);
  return references;
};

const NODE = /^(?:node:|bun(?::|$)|electron(?:\/|$))/;
// Node's own modules by their bare names ("fs", "fs/promises"). An npm package with one of these names (a polyfill
// called "events") would be refused too: the page has none, and if it should, it is a decision to make here.
const BUILTINS = builtinModules.filter((m) => !m.startsWith("_"));
const isBuiltin = (name: string) => BUILTINS.some((m) => name === m || name.startsWith(`${m}/`));
// Packages that run in the daemon or the main process: the page has no business with them.
// The analytics package may be reached for its dictionary (`@cycle/analytics/events`, for types), not for PostHog.
const BACKEND = /^@cycle\/(?:daemon|client|protocol|desktop|oidc)(?:\/|$)|^@cycle\/harness-/;

const isRelative = (name: string) => name.startsWith(".");

/** Inside the zone, after the relative name is resolved: the model's own files, and the bridge contract that wraps them. */
const inModel = (resolved: string) =>
  resolved.startsWith("packages/ui/src/model/") ||
  resolved.replace(/\.tsx?$/, "") === "packages/ui/src/api";

const forbidden: Record<
  Zone,
  (name: string, file: string, typeOnly: boolean) => string | undefined
> = {
  model: (name, file) => {
    if (name === "@agentclientprotocol/sdk/experimental/v2") return undefined;
    if (isRelative(name)) {
      if (inModel(posix.normalize(posix.join(posix.dirname(file), name)))) return undefined;
      return "the model may import only its own files (packages/ui/src/model, api.ts), not code that uses the page or the main process";
    }
    return "the model is pure TypeScript: it may import only its own files and @agentclientprotocol/sdk/experimental/v2";
  },
  renderer: (name, file, typeOnly) => {
    if (name === "@cycle/analytics/events" && typeOnly) return undefined;
    const resolved = isRelative(name) ? posix.join(posix.dirname(file), name) : name;
    if (/^(?:@cycle\/analytics|packages\/analytics|posthog-node|posthog-js)(?:\/|$)/.test(resolved))
      return "the page may import only types from @cycle/analytics/events; the main process owns analytics";

    if (NODE.test(name) || isBuiltin(name))
      return "the page runs in a browser: no Node, Bun or Electron module";
    if (BACKEND.test(name))
      return "the page reaches the daemon only through the bridge (@cycle/ui/api), not by importing it";
    return undefined;
  },
  app: (name, file) => {
    if (/^@cycle\/loop(?:\/|$)/.test(name))
      return "the Loop server is reached over its protocol, not imported";
    if (
      isRelative(name) &&
      posix.normalize(posix.join(posix.dirname(file), name)).startsWith("cloud/")
    )
      return "the Loop server is reached over its protocol, not imported";
    return undefined;
  },
  preload: (name) => {
    if (name === "electron" || name === "electron/renderer" || name === "@cycle/ui/api")
      return undefined;
    return "the preload may import only electron and @cycle/ui/api";
  },
  "loop-engine": (name, file) => {
    const resolved = isRelative(name)
      ? posix.normalize(posix.join(posix.dirname(file), name)).replace(/\.tsx?$/, "")
      : name;
    if (
      resolved === "cloud/loop/src/flows/dev" ||
      resolved.startsWith("cloud/loop/src/flows/dev/") ||
      resolved === "cloud/loop/src/ports/github" ||
      resolved === "cloud/loop/src/ports/git"
    ) {
      return "the Loop engine must stay flow- and forge-agnostic (no flows/dev, ports/github, or ports/git)";
    }
    return undefined;
  },
};

/** Maximum lines allowed in `cloud/loop/src/engine/engine.ts` (CYC-481). */
export const MAX_ENGINE_LINES = 600;

/** One line per broken rule in this file; empty when it keeps to its zones. */
export const violations = (file: string, text: string): string[] => {
  const zones = zoneOf(file);
  const out: string[] = [];
  if (zones.length > 0) {
    const references = moduleReferences(text, file);
    for (const zone of zones)
      for (const { name, typeOnly } of references) {
        const why = forbidden[zone](name, file, typeOnly);
        if (why) out.push(`${file}: ${zone} imports "${name}" (${why})`);
      }
  }
  if (
    file.startsWith("apps/desktop/src/") &&
    file !== "apps/desktop/src/main/main.ts" &&
    /\bitsaplan-key\b/i.test(text)
  ) {
    out.push(
      `${file}: desktop must not hold or reference itsaplan-key (the Loop server holds the key, CYC-481/483)`,
    );
  }
  if (file === "cloud/loop/src/engine/engine.ts") {
    const lines = text.split("\n").length;
    if (lines > MAX_ENGINE_LINES) {
      out.push(
        `${file}: has ${lines} lines, exceeding the ${MAX_ENGINE_LINES}-line limit (keep flow logic out of engine.ts, CYC-481)`,
      );
    }
  }
  return out;
};
