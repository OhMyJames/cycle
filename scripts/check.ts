// `bun run check`: the gate. It must pass before any commit; the pre-commit hook runs it.
// Boundaries first (cheap), then types, lint and tests. Stops at the first failure.

import { Glob } from "bun";
import { violations } from "./boundaries.ts";

const root = new URL("..", import.meta.url).pathname;

type Rule = { name: string; pattern: RegExp; allowed: (file: string) => boolean; why: string };

const rules: Rule[] = [
  {
    name: "ACP SDK uses experimental/v2 only",
    pattern: /(["'`])@agentclientprotocol\/(?!sdk\/experimental\/v2\1)/,
    allowed: (f) => f === "scripts/check.ts" || f === "package.json" || f.endsWith("/package.json"),
    why: "ACP v2 is a draft; import only `@agentclientprotocol/sdk/experimental/v2` (never unstable or v1).",
  },
  {
    name: "no Bun APIs where Node runs",
    pattern: /\bBun\./,
    allowed: (f) =>
      !(
        f.startsWith("packages/protocol/src/") ||
        f.startsWith("packages/analytics/src/") ||
        f.startsWith("packages/client/src/") ||
        f.startsWith("packages/ui/src/") ||
        f.startsWith("packages/ui/test/browser/") ||
        f.startsWith("apps/desktop/src/")
      ),
    why: "Electron's main process is Node, and the interface's tests run in a browser. Use node: modules or the web's own APIs there (see packages/client/src/transport.ts).",
  },
  {
    name: "no suppressed checks",
    pattern: /@ts-ignore|@ts-expect-error|biome-ignore/,
    allowed: (f) => f === "scripts/check.ts",
    why: "fix the cause, or change the rule on purpose.",
  },
];

const sources = new Glob("{packages,harness,apps,scripts}/**/*.{ts,tsx,json}");
const failures: string[] = [];
for await (const file of sources.scan({ cwd: root })) {
  if (file.includes("node_modules/")) continue;
  const text = await Bun.file(root + file).text();
  for (const rule of rules) {
    if (!rule.allowed(file) && rule.pattern.test(text)) {
      failures.push(`${file}: ${rule.name} (${rule.why})`);
    }
  }
  failures.push(...violations(file, text));
}
// The ACP SDK is pinned to one exact version in the root workspace catalog, and every workspace
// package refers to it via `catalog:` so upgrades happen in one place.
{
  type Manifest = {
    workspaces?: { catalog?: Record<string, string> };
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const sections = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const;
  const rootPkg = (await Bun.file(`${root}package.json`).json()) as Manifest;
  const pinned = rootPkg.workspaces?.catalog?.["@agentclientprotocol/sdk"];
  if (pinned === undefined || !/^\d+\.\d+\.\d+$/.test(pinned)) {
    failures.push(
      `package.json: workspaces.catalog["@agentclientprotocol/sdk"] must be an exact semver version (got ${JSON.stringify(pinned)})`,
    );
  }
  const manifests = [
    "package.json",
    ...Array.from(new Glob("{packages,harness,apps}/*/package.json").scanSync({ cwd: root })),
  ];
  for (const file of manifests) {
    const pkg = (await Bun.file(root + file).json()) as Manifest;
    for (const section of sections) {
      const spec = pkg[section]?.["@agentclientprotocol/sdk"];
      if (spec !== undefined && spec !== "catalog:") {
        failures.push(
          `${file}: ${section}["@agentclientprotocol/sdk"] must be "catalog:" (got ${JSON.stringify(spec)})`,
        );
      }
    }
  }
}
// DESIGN.md and the stylesheet agree on the --cycle-* tokens: one that is written and not defined is a promise
// nothing keeps, and one that is defined and not written is a decision nobody can see.
{
  const design = await Bun.file(`${root}DESIGN.md`).text();
  // The stylesheet is app.css and the parts it imports (packages/ui/src/styles/), in that order; a part it does not
  // import is in no build, and is said so.
  const styles = `${root}packages/ui/src/styles/`;
  const entry = await Bun.file(`${styles}app.css`).text();
  const parts = Array.from(
    entry.matchAll(/^@import "\.\/([\w-]+\.css)";$/gm),
    (m) => m[1] as string,
  );
  for await (const file of new Glob("*.css").scan({ cwd: styles })) {
    if (file !== "app.css" && file !== "built.css" && !parts.includes(file)) {
      failures.push(`packages/ui/src/styles/${file} is not imported by app.css`);
    }
  }
  let css = entry;
  for (const part of parts) css += await Bun.file(styles + part).text();
  const named = new Set(design.match(/--cycle-[a-z-]+/g) ?? []);
  const defined = new Set(
    Array.from(css.matchAll(/^\s*(--cycle-[a-z-]+)\s*:/gm), (m) => m[1] as string),
  );
  for (const token of named)
    if (!defined.has(token))
      failures.push(`DESIGN.md names ${token}, which the stylesheet does not define`);
  for (const token of defined)
    if (!named.has(token))
      failures.push(`the stylesheet defines ${token}, which DESIGN.md does not mention`);
}

// The dictionary of analytics events and its document agree: an event nobody wrote down is one nobody can review for what it
// sends, and one written down that is not in the dictionary is a promise nothing keeps.
{
  const { EVENTS } = await import("../packages/analytics/src/events.ts");
  const document = await Bun.file(`${root}docs/analytics.md`).text();
  const written = new Set(
    Array.from(document.matchAll(/^\| `([a-z_]+)`/gm), (m) => m[1] as string),
  );
  for (const name of Object.keys(EVENTS))
    if (!written.has(name))
      failures.push(
        `packages/analytics/src/events.ts has ${name}, which docs/analytics.md does not list`,
      );
  for (const name of written)
    if (!(name in EVENTS))
      failures.push(`docs/analytics.md lists ${name}, which the dictionary does not have`);
}

// New interface text goes in the message catalog, not in the markup (decision 0012). The count of what is still in the markup
// may only go down; the script says which file got worse.
{
  const ratchet = Bun.spawnSync(
    ["bun", `${root}.claude/skills/cycle-design-taste/scripts/scan-copy.mjs`, "--i18n"],
    { cwd: root },
  );
  if (ratchet.exitCode !== 0)
    failures.push(`i18n:\n${new TextDecoder().decode(ratchet.stdout).trim()}`);
}

if (failures.length > 0) {
  console.error(`boundaries failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("boundaries ok");

const steps: [string, string[]][] = [
  ["css", ["bun", "run", "--cwd", "packages/ui", "build:css"]],
  ["typecheck", ["bun", "run", "typecheck"]],
  ["lint", ["bun", "run", "lint"]],
  // The interface's tests run in a real browser and are not here: `bun run test:browser`, and CI's browser job.
  ["test", ["bun", "test", "--parallel=2"]],
];
const timings: string[] = [];
for (const [name, cmd] of steps) {
  console.log(`\n== ${name}`);
  const started = Date.now();
  const proc = Bun.spawn(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) {
    console.error(`\ncheck failed at ${name}`);
    process.exit(1);
  }
  timings.push(`${name} ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
console.log(`\n${timings.join("  ")}`);
console.log("\ncheck ok");
