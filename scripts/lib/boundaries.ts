import { builtinModules } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";
import { scanSource } from "./scan.ts";

/** What code on one platform may reach. */
export type Platform = {
  /** Workspace packages it may depend on. */
  workspace: readonly string[];
  /** External packages it may depend on. A trailing "/" allows a whole npm scope. */
  external: readonly string[];
  /** Whether it may import runtime modules such as node:fs or bun:sqlite. */
  runtimeModules: boolean;
};

/** Part of a package that runs somewhere other than the rest of it. */
export type Scope = Platform & {
  /** Relative to the package root. A trailing "/" covers a directory; otherwise an exact file. */
  paths: readonly string[];
};

export type PackageRule = Platform & {
  /** The first scope that covers a file wins. Everything else follows the rule itself. */
  scopes?: readonly Scope[];
};

/**
 * The architecture, as data. A package missing from this table fails the check,
 * so adding a package forces a decision about what it may depend on.
 *
 * Clients reach an agent only through the daemon, and only harness code may depend on a specific
 * agent. The protocol and the UI run anywhere, so they import no runtime modules.
 */
export const RULES: Readonly<Record<string, PackageRule>> = {
  "@cycle/protocol": { workspace: [], external: [], runtimeModules: false },
  "@cycle/ui": {
    workspace: ["@cycle/protocol"],
    external: [
      "react",
      "react-dom",
      "marked",
      "highlight.js",
      "@xterm/",
      "@ui-sdk/",
      "@types/react",
      "@types/react-dom",
    ],
    runtimeModules: false,
  },
  "@cycle/harness-codex": {
    workspace: ["@cycle/protocol"],
    external: ["@openai/codex"],
    runtimeModules: true,
  },
  // The only code that knows Claude Code, through the Claude Agent SDK.
  "@cycle/harness-claude": {
    workspace: ["@cycle/protocol"],
    external: ["@anthropic-ai/claude-agent-sdk"],
    runtimeModules: true,
  },
  // The only code that knows pi-ai, which speaks each model provider's own protocol.
  "@cycle/gateway": {
    workspace: ["@cycle/protocol"],
    external: ["@earendil-works/pi-ai"],
    runtimeModules: true,
  },
  "@cycle/daemon": {
    workspace: [
      "@cycle/protocol",
      "@cycle/harness-codex",
      "@cycle/harness-claude",
      "@cycle/gateway",
    ],
    external: [],
    runtimeModules: true,
  },
  // The page is the default. The main process and the preload run on Electron; the build, the
  // packaging and the installer on Bun. The updater runs in the main process.
  "@cycle/desktop": {
    workspace: ["@cycle/ui"],
    external: ["react", "react-dom", "@types/react", "@types/react-dom"],
    runtimeModules: false,
    scopes: [
      {
        paths: [
          "src/main.ts",
          "src/launch.ts",
          "src/login-env.ts",
          "src/preload.ts",
          "src/package/",
          "src/install/",
          "src/update/",
          "build.ts",
        ],
        workspace: [],
        external: ["electron", "@types/node"],
        runtimeModules: true,
      },
    ],
  },
};

/** Imports below a workspace package's root that are part of what it offers. */
const ALLOWED_DEEP_IMPORTS: ReadonlySet<string> = new Set(["@cycle/ui/styles.css"]);

/** Installed or generated trees. Nothing in them is ours to check. */
const GENERATED = /(^|\/)(node_modules|dist|build|artifacts|coverage)\//;

export const isGeneratedPath = (path: string): boolean => GENERATED.test(path);

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export type Manifest = { name?: string; packageManager?: string } & Partial<
  Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>
>;

export type SourceFile = { path: string; code: string };

export type WorkspacePackage = {
  dir: string;
  manifest: Manifest;
  files: readonly SourceFile[];
  /** Whether `test/tsconfig.json` exists. Tests need their own project to see test APIs. */
  hasTestProject?: boolean;
};

export type Violation = { where: string; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isManifest(value: unknown): value is Manifest {
  if (!isRecord(value)) return false;
  return DEPENDENCY_FIELDS.every((field) => {
    const dependencies = value[field];
    if (dependencies === undefined) return true;
    return (
      isRecord(dependencies) &&
      Object.values(dependencies).every((version) => typeof version === "string")
    );
  });
}

/** Marks an import whose target is computed and so cannot be checked. */
const DYNAMIC = "<dynamic>";

export type FileAnalysis = {
  specifiers: string[];
  /** Static member accesses on a plain identifier, such as `Bun.spawn` or `test.only`. */
  members: Set<string>;
  /** Plain identifiers that are called or constructed, such as `fetch`. */
  calls: Set<string>;
  errors: string[];
};

// `import type` and `export … from` vanish when Bun transpiles, so these find them in the text.
const FROM = /(?<![.\w$])(?:import|export)\b[\s\w$,{}*]*?\bfrom\s*(?=["'])/g;
const SIDE_EFFECT = /(?<![.\w$])import\s*(?=["'])/g;
const CALLED_IMPORT = /(?<![.\w$])(?:import|require)\s*\(\s*/g;
const MEMBER = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\??\.\s*([A-Za-z_$][\w$]*)/g;
const CALL = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
const CONSTRUCTED = /(?<![.\w$])new\s+([A-Za-z_$][\w$]*)/g;
const DECLARED = /(?<![.\w$])function\s*\*?\s*$/;

/** The offset just past the parenthesis that closes the one at `open`. */
function afterClosing(masked: string, open: number): number {
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    if (masked[index] === "(") depth += 1;
    else if (masked[index] === ")" && (depth -= 1) === 0) return index + 1;
  }
  return masked.length;
}

function loaderOf(path: string): "ts" | "tsx" | "js" | "jsx" {
  if (/\.[cm]?ts$/.test(path)) return "ts";
  if (path.endsWith(".tsx")) return "tsx";
  return path.endsWith(".jsx") ? "jsx" : "js";
}

/**
 * Collects every module reference in a file, including type-only forms. Type
 * imports count: they couple packages even though they vanish at runtime.
 */
export function analyzeFile(path: string, code: string): FileAnalysis {
  const { masked, strings } = scanSource(code);
  const specifiers = new Set<string>();
  const members = new Set<string>();
  const calls = new Set<string>();
  const errors: string[] = [];

  for (const pattern of [FROM, SIDE_EFFECT]) {
    for (const match of masked.matchAll(pattern)) {
      const specifier = strings.get(match.index + match[0].length);
      if (specifier !== undefined) specifiers.add(specifier);
    }
  }
  for (const match of masked.matchAll(CALLED_IMPORT)) {
    const quote = match.index + match[0].length;
    const specifier = strings.get(quote);
    const after = specifier === undefined ? "" : masked.slice(quote + specifier.length + 2);
    specifiers.add(specifier !== undefined && /^\s*[),]/.test(after) ? specifier : DYNAMIC);
  }
  try {
    const transpiler = new Bun.Transpiler({ loader: loaderOf(path) });
    // Bun adds the JSX runtime's imports to what the file wrote, so only what it wrote counts.
    const written = new Set(strings.values());
    for (const found of transpiler.scanImports(code)) {
      if (written.has(found.path)) specifiers.add(found.path);
    }
  } catch {
    errors.push("the file does not parse");
  }

  for (const match of masked.matchAll(MEMBER)) members.add(`${match[1]}.${match[2]}`);
  for (const match of masked.matchAll(CONSTRUCTED)) {
    if (match[1] !== undefined) calls.add(match[1]);
  }
  for (const match of masked.matchAll(CALL)) {
    const open = match.index + match[0].length - 1;
    // `name(…) {` defines a method and `function name(` a function: neither is a call.
    const defines =
      /^\s*\{/.test(masked.slice(afterClosing(masked, open))) ||
      DECLARED.test(masked.slice(0, match.index));
    if (match[1] !== undefined && !defines) calls.add(match[1]);
  }

  return { specifiers: [...specifiers], members, calls, errors };
}

export type FileZone = "source" | "unit-test" | "integration-test";

/** Classifies a path relative to its package root, or `scripts/`. */
export const zoneOf = (relativePath: string): FileZone =>
  relativePath.startsWith("test/integration/")
    ? "integration-test"
    : relativePath.startsWith("test/")
      ? "unit-test"
      : "source";

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const TEST_HOME = /^((apps|harness|packages)\/[^/]+|scripts)\/test\//;

/** Tests live in a `test/` directory beside `src/`, never beside the code they cover. */
export function checkTestPlacement(rootRelativePaths: readonly string[]): Violation[] {
  return rootRelativePaths
    .filter((path) => TEST_FILE.test(path) && !TEST_HOME.test(path))
    .map((path) => ({
      where: path,
      message: "test files belong in the package's test/ directory, beside src/",
    }));
}

/** Keeps generated tests reviewable: a file past this size should be split or made table-driven. */
export const MAX_TEST_FILE_LINES = 400;

const TEST_APIS = ["test", "it", "describe"];
const DISABLING_MODIFIERS = ["only", "skip", "todo", "skipIf", "todoIf"];
const DISABLING_MEMBERS = new Set(
  TEST_APIS.flatMap((api) => DISABLING_MODIFIERS.map((modifier) => `${api}.${modifier}`)),
);

const UNIT_BANNED_MODULES = new Set([
  "child_process",
  "dgram",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "net",
  "tls",
  "worker_threads",
  "bun:sqlite",
]);

const UNIT_BANNED_MEMBERS = new Set(
  ["spawn", "spawnSync", "serve", "connect", "listen", "sleep", "sleepSync", "file", "write"].map(
    (name) => `Bun.${name}`,
  ),
);

const UNIT_BANNED_CALLS = new Set(["fetch", "setTimeout", "setInterval", "WebSocket"]);

/**
 * Rules for one file under `test/`. Unit tests run on every commit, so anything slow or
 * flaky (processes, network, disk, timers) must move to `test/integration/`.
 */
export function checkTestFile(
  where: string,
  zone: FileZone,
  code: string,
  analysis: FileAnalysis,
): Violation[] {
  const messages: string[] = [];

  const lines = code.split("\n").length;
  if (lines > MAX_TEST_FILE_LINES) {
    messages.push(
      `${lines} lines exceeds ${MAX_TEST_FILE_LINES}; split it or make it table-driven`,
    );
  }

  for (const member of analysis.members) {
    if (DISABLING_MEMBERS.has(member)) {
      messages.push(`${member} is not allowed; a test must run, or be deleted`);
    }
  }

  if (zone === "unit-test") {
    const moveIt = "unit tests may not use it; move the test to test/integration/";
    for (const specifier of analysis.specifiers) {
      if (UNIT_BANNED_MODULES.has(specifier.replace(/^node:/, ""))) {
        messages.push(`"${specifier}": ${moveIt}`);
      }
    }
    for (const member of analysis.members) {
      if (UNIT_BANNED_MEMBERS.has(member)) messages.push(`${member}: ${moveIt}`);
    }
    for (const call of analysis.calls) {
      if (UNIT_BANNED_CALLS.has(call)) messages.push(`${call}: ${moveIt}`);
    }
  }

  return messages.map((message) => ({ where, message }));
}

const RUNTIME_MODULES = new Set(builtinModules);

const isRuntimeModule = (specifier: string): boolean =>
  specifier === "bun" ||
  specifier.startsWith("node:") ||
  specifier.startsWith("bun:") ||
  RUNTIME_MODULES.has(specifier.split("/")[0] ?? specifier);

const packageNameOf = (specifier: string): string => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
};

const allowsExternal = (platform: Platform, name: string): boolean =>
  platform.external.some((entry) =>
    entry.endsWith("/") ? name.startsWith(entry) : name === entry,
  );

const isUnder = (relativePath: string, entry: string): boolean =>
  entry.endsWith("/") ? relativePath.startsWith(entry) : relativePath === entry;

const scopeOf = (rule: PackageRule, relativePath: string): Platform =>
  rule.scopes?.find((scope) => scope.paths.some((path) => isUnder(relativePath, path))) ?? rule;

const declaredDependencies = (manifest: Manifest): Set<string> =>
  new Set(DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {})));

/** Requires exact versions, so an install can never change what runs. */
export function checkPinnedVersions(where: string, manifest: Manifest): Violation[] {
  const violations: Violation[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (version !== "workspace:*" && !/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(version)) {
        violations.push({
          where,
          message: `${field}: ${name}@${version} must be an exact version or workspace:*`,
        });
      }
    }
  }
  return violations;
}

export function checkPackage(pkg: WorkspacePackage): Violation[] {
  const name = pkg.manifest.name ?? pkg.dir;
  const rule = RULES[name];
  if (!rule) {
    return [
      { where: pkg.dir, message: `${name} has no entry in RULES (scripts/lib/boundaries.ts)` },
    ];
  }

  const violations = checkPinnedVersions(pkg.dir, pkg.manifest);
  const declared = declaredDependencies(pkg.manifest);

  const everyPlatform: readonly Platform[] = [rule, ...(rule.scopes ?? [])];
  for (const dependency of declared) {
    const allowed = everyPlatform.some((platform) =>
      dependency.startsWith("@cycle/")
        ? platform.workspace.includes(dependency)
        : allowsExternal(platform, dependency),
    );
    if (!allowed) {
      violations.push({ where: pkg.dir, message: `${name} may not depend on ${dependency}` });
    }
  }

  for (const file of pkg.files) {
    const relativePath = relative(resolve(pkg.dir), resolve(file.path));
    const zone = zoneOf(relativePath);
    const platform = scopeOf(rule, relativePath);
    const analysis = analyzeFile(file.path, file.code);
    for (const error of analysis.errors) {
      violations.push({ where: file.path, message: `parse error: ${error}` });
    }
    for (const specifier of analysis.specifiers) {
      const message = checkSpecifier({
        specifier,
        file,
        pkg,
        rule,
        // A test may import whatever any part of its package may.
        platforms: zone === "source" ? [platform] : everyPlatform,
        name,
        declared,
        zone,
      });
      if (message !== undefined) violations.push({ where: file.path, message });
    }
    if (zone !== "source") {
      violations.push(...checkTestFile(file.path, zone, file.code, analysis));
      if (pkg.hasTestProject === false) {
        violations.push({
          where: file.path,
          message: "test/tsconfig.json is missing; tests are not being typechecked",
        });
      }
    }
  }

  return violations;
}

function checkSpecifier(input: {
  specifier: string;
  file: SourceFile;
  pkg: WorkspacePackage;
  rule: PackageRule;
  platforms: readonly Platform[];
  name: string;
  declared: ReadonlySet<string>;
  zone: FileZone;
}): string | undefined {
  const { specifier, file, pkg, rule, platforms, name, declared, zone } = input;

  if (specifier === DYNAMIC) {
    return "computed imports cannot be checked; use a string literal";
  }

  if (specifier.startsWith(".")) {
    const target = relative(resolve(pkg.dir), resolve(dirname(file.path), specifier));
    if (target === ".." || target.startsWith(`..${sep}`)) {
      return `"${specifier}" reaches outside the package; depend on it by name`;
    }
    if (zone !== "source") return undefined;
    if (zoneOf(target) !== "source") {
      return `"${specifier}": source code may not import from test/`;
    }
    // Code under the package's own rule runs anywhere, so every scope may import it.
    const owner = scopeOf(rule, target);
    return owner === rule || platforms.includes(owner)
      ? undefined
      : `"${specifier}" belongs to another platform in this package`;
  }

  if (specifier.startsWith("/")) return `"${specifier}" is an absolute path`;

  if (isRuntimeModule(specifier)) {
    // Tests always run on Bun, so a platform-neutral package's tests may still use its APIs.
    return zone !== "source" || platforms.some((platform) => platform.runtimeModules)
      ? undefined
      : `${name} may not import runtime module "${specifier}" here`;
  }

  const target = packageNameOf(specifier);

  if (target.startsWith("@cycle/")) {
    if (!platforms.some((platform) => platform.workspace.includes(target))) {
      return `${name} may not import ${target} here`;
    }
    if (specifier !== target && !ALLOWED_DEEP_IMPORTS.has(specifier)) {
      return `"${specifier}" reaches into ${target}; import its root`;
    }
  } else if (!platforms.some((platform) => allowsExternal(platform, target))) {
    return `${name} may not import ${specifier} here`;
  }

  return declared.has(target)
    ? undefined
    : `${target} is imported but not declared in package.json`;
}
