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

export type Zone = "model" | "renderer" | "preload" | "app";

export const zoneOf = (file: string): Zone[] => {
  const zones: Zone[] = [];
  if (file.startsWith("packages/ui/src/model/") || file === "packages/ui/src/api.ts")
    zones.push("model");
  if (file.startsWith("packages/ui/src/") || file.startsWith("apps/desktop/src/renderer/"))
    zones.push("renderer");
  if (file.startsWith("apps/desktop/src/preload/")) zones.push("preload");
  if (file.startsWith("apps/desktop/src/") || file.startsWith("packages/ui/src/"))
    zones.push("app");
  return zones;
};

type Token = { kind: "word" | "string" | "dynamic" | "punct"; text: string };

/**
 * A file as words, strings and punctuation, one pass: comments are skipped, a string ends at its quote or at the
 * end of its line (so one quote that is really in a regular expression spoils only its line), a template literal
 * with ${} in it is "dynamic" (its module cannot be known).
 */
const tokenize = (text: string): Token[] => {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i] as string;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      const eol = text.indexOf("\n", i);
      i = eol === -1 ? n : eol;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      i = close === -1 ? n : close + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      tokens.push({ kind: "string", text: text.slice(i + 1, j) });
      i = j + 1;
    } else if (c === "`") {
      let j = i + 1;
      let depth = 0;
      let dynamic = false;
      while (j < n && !(text[j] === "`" && depth === 0)) {
        if (text[j] === "\\") j += 2;
        else if (text[j] === "$" && text[j + 1] === "{") {
          dynamic = true;
          depth++;
          j += 2;
        } else {
          if (depth > 0 && text[j] === "}") depth--;
          j++;
        }
      }
      tokens.push({ kind: dynamic ? "dynamic" : "string", text: text.slice(i + 1, j) });
      i = j + 1;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(text[j] as string)) j++;
      tokens.push({ kind: "word", text: text.slice(i, j) });
      i = j;
    } else {
      tokens.push({ kind: "punct", text: c });
      i++;
    }
  }
  return tokens;
};

/**
 * The module names a file imports: static, side-effect, re-export, dynamic and require. Read from the tokens, so a
 * comment or a string that looks like an import is not one, and several imports on a line are all found.
 * What it does not see: an import behind a template literal that has ${} in it. It does not parse regular expressions or
 * JSX text, so a regular expression with a backtick or "/*" in it (or JSX text with an apostrophe, on that line) can hide
 * what follows: to the next backtick, to the next "*" + "/", or to the end of the line. Imports are at the top of a file, and
 * the type environments (tsconfig.model.json, tsconfig.renderer.json) do not depend on this reader.
 */
export const importsOf = (text: string): string[] => {
  const t = tokenize(text);
  const found: string[] = [];
  const is = (k: number, kind: Token["kind"], value?: string) =>
    t[k]?.kind === kind && (value === undefined || t[k]?.text === value);
  // Where each "{" closes, found once for the whole file (looking forward from each would be quadratic on a file
  // of unclosed braces). One that never closes goes to the end.
  const closes = new Map<number, number>();
  const open: number[] = [];
  for (let j = 0; j < t.length; j++) {
    if (is(j, "punct", "{")) open.push(j);
    else if (is(j, "punct", "}")) {
      const at = open.pop();
      if (at !== undefined) closes.set(at, j);
    }
  }
  // Past the "}" that closes the "{" at k.
  const afterBraces = (k: number): number => (closes.get(k) ?? t.length - 1) + 1;
  // "from" and then the module, if that is what is at k.
  const fromModule = (k: number) => {
    if (is(k, "word", "from") && is(k + 1, "string")) found.push((t[k + 1] as Token).text);
  };
  for (let k = 0; k < t.length; k++) {
    if (!is(k, "word") || is(k - 1, "punct", ".")) continue;
    const word = (t[k] as Token).text;
    if (word === "require" || (word === "import" && is(k + 1, "punct", "("))) {
      if (is(k + 1, "punct", "(") && is(k + 2, "string")) found.push((t[k + 2] as Token).text);
    } else if (word === "import") {
      if (is(k + 1, "string")) found.push((t[k + 1] as Token).text);
      else if (!is(k + 1, "punct", ".")) {
        let j = k + 1;
        if (is(j, "word", "type") && !is(j + 1, "word", "from")) j++;
        // The clause: a default name, then "* as name" or "{ ... }", each optional.
        if (is(j, "word") && !is(j, "word", "from")) j++;
        if (is(j, "punct", ",")) j++;
        if (is(j, "punct", "*")) j += is(j + 1, "word", "as") ? 3 : 1;
        else if (is(j, "punct", "{")) j = afterBraces(j);
        fromModule(j);
      }
    } else if (word === "export") {
      let j = k + 1;
      if (is(j, "word", "type")) j++;
      if (is(j, "punct", "*")) {
        j++;
        if (is(j, "word", "as") && is(j + 1, "word")) j += 2;
      } else if (is(j, "punct", "{")) j = afterBraces(j);
      else continue;
      fromModule(j);
    }
  }
  return found;
};

const NODE = /^(?:node:|bun(?::|$)|electron(?:\/|$))/;
// Node's own modules by their bare names ("fs", "fs/promises"). An npm package with one of these names (a polyfill
// called "events") would be refused too: the page has none, and if it should, it is a decision to make here.
const BUILTINS = builtinModules.filter((m) => !m.startsWith("_"));
const isBuiltin = (name: string) => BUILTINS.some((m) => name === m || name.startsWith(`${m}/`));
// Packages that run in the daemon or the main process: the page has no business with them.
// The analytics package may be reached for its dictionary (`@cycle/analytics/events`, for types), not for PostHog.
const BACKEND =
  /^@cycle\/(?:daemon|client|protocol|desktop|oidc)(?:\/|$)|^@cycle\/harness-|^@cycle\/analytics(?:$|\/posthog)/;

const isRelative = (name: string) => name.startsWith(".");

/** Inside the zone, after the relative name is resolved: the model's own files, and the bridge contract that wraps them. */
const inModel = (resolved: string) =>
  resolved.startsWith("packages/ui/src/model/") ||
  resolved.replace(/\.tsx?$/, "") === "packages/ui/src/api";

const forbidden: Record<Zone, (name: string, file: string) => string | undefined> = {
  model: (name, file) => {
    if (name === "@agentclientprotocol/sdk/experimental/v2") return undefined;
    if (isRelative(name)) {
      if (inModel(posix.normalize(posix.join(posix.dirname(file), name)))) return undefined;
      return "the model may import only its own files (packages/ui/src/model, api.ts), not code that uses the page or the main process";
    }
    return "the model is pure TypeScript: it may import only its own files and @agentclientprotocol/sdk/experimental/v2";
  },
  renderer: (name) => {
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
};

/** One line per broken rule in this file; empty when it keeps to its zones. */
export const violations = (file: string, text: string): string[] => {
  const zones = zoneOf(file);
  if (zones.length === 0) return [];
  const names = importsOf(text);
  const out: string[] = [];
  for (const zone of zones)
    for (const name of names) {
      const why = forbidden[zone](name, file);
      if (why) out.push(`${file}: ${zone} imports "${name}" (${why})`);
    }
  return out;
};
