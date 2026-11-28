// `bun run ui-contract`: takes a new snapshot of what the page relies on the app for (shared/contract.ts), after a change
// to it that the apps of the same contract major can serve, or after raising the major.
//
//   test/ui-contract/snapshot/   the declarations of packages/ui/src/api.ts and what it imports (tsc --declaration)
//   test/ui-contract/snapshot.ts the major, the protocol SDK's version and the hash of the preload they were taken with
//
// test/ui-contract.test.ts fails while the snapshot is not the one this source makes, and, through `bun run typecheck`,
// while the API's types are not ones an app of the snapshot's major can serve (test/ui-contract/compat.ts). This script
// is the one way to move the snapshot forward, and it refuses to when that check fails and the major was not raised. The
// SDK's types and the preload are not compared by type: a change to them is taken only when said (`--accept <why>`), or
// with a new major.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { CONTRACT_MAJOR } from "../src/shared/contract.ts";

const DESKTOP = join(import.meta.dirname, "..");
const ROOT = join(DESKTOP, "../..");
export const CONTRACT_DIR = join(DESKTOP, "test/ui-contract");
const TSC = join(ROOT, "node_modules/.bin/tsc");

export type SnapshotFacts = { major: number; sdk: string; preload: string };

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** The version of the protocol SDK the API's types come from, whatever the package is called in the catalog. */
export const sdkVersion = (root = ROOT): string => {
  const catalog = (
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      workspaces?: { catalog?: Record<string, string> };
    }
  ).workspaces?.catalog;
  const sdk = Object.entries(catalog ?? {}).find(([name]) =>
    name.includes("agentclientprotocol"),
  )?.[1];
  if (sdk === undefined)
    throw new Error("The protocol SDK's version is not in the root package.json catalog.");
  return sdk;
};

export const factsNow = (): SnapshotFacts => ({
  major: CONTRACT_MAJOR,
  sdk: sdkVersion(),
  preload: sha256(readFileSync(join(DESKTOP, "src/preload/preload.ts"))),
});

export const factsText = (facts: SnapshotFacts): string =>
  [
    "// Made by `bun run --cwd apps/desktop ui-contract` (scripts/ui-contract.ts): not edited by hand.",
    "export const SNAPSHOT = {",
    `  major: ${facts.major},`,
    `  sdk: ${JSON.stringify(facts.sdk)},`,
    `  preload: ${JSON.stringify(facts.preload)},`,
    "} as const;",
    "",
  ].join("\n");

const tsc = (project: string): { ok: boolean; out: string } => {
  const result = Bun.spawnSync([TSC, "-p", project], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return { ok: result.success, out: `${result.stdout}${result.stderr}`.trim() };
};

/** Writes the snapshot the source makes now into `dir` (its `snapshot/` and `snapshot.ts`). */
export const makeSnapshot = async (dir: string): Promise<void> => {
  const work = await mkdtemp(join(tmpdir(), "ui-contract-"));
  try {
    const project = join(work, "tsconfig.json");
    await writeFile(
      project,
      JSON.stringify({
        extends: join(ROOT, "tsconfig.base.json"),
        compilerOptions: {
          noEmit: false,
          declaration: true,
          emitDeclarationOnly: true,
          removeComments: true,
          outDir: join(work, "out"),
          rootDir: join(ROOT, "packages/ui/src"),
          types: [],
        },
        files: [join(ROOT, "packages/ui/src/api.ts")],
      }),
    );
    const emitted = tsc(project);
    if (!emitted.ok) throw new Error(`tsc could not declare the API:\n${emitted.out}`);
    await rm(join(dir, "snapshot"), { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await cp(join(work, "out"), join(dir, "snapshot"), { recursive: true });
    await writeFile(join(dir, "snapshot.ts"), factsText(factsNow()));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

/** Every file of a snapshot by its path, with its text: what two snapshots are compared by. */
export const snapshotFiles = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(dir, path)] = readFileSync(path, "utf8");
    }
  };
  if (existsSync(join(dir, "snapshot"))) walk(join(dir, "snapshot"));
  if (existsSync(join(dir, "snapshot.ts")))
    out["snapshot.ts"] = readFileSync(join(dir, "snapshot.ts"), "utf8");
  return out;
};

/** The facts the committed snapshot was taken with. */
export const committedFacts = async (): Promise<SnapshotFacts> =>
  ((await import(join(CONTRACT_DIR, "snapshot.ts"))) as { SNAPSHOT: SnapshotFacts }).SNAPSHOT;

/** Whether the API's types now are ones an app of the committed snapshot can serve: compat.ts compiles. */
const compatible = (): { ok: boolean; out: string } => tsc(join(CONTRACT_DIR, "tsconfig.json"));

/**
 * Why a new snapshot may not be taken, or undefined when it may: see the top of this file. `typesHold` is whether the
 * API's types now are ones an app of the committed snapshot's major can serve; `accepted`, the reason given for a change
 * no check can compare.
 */
export const refusal = (
  before: SnapshotFacts,
  now: SnapshotFacts,
  typesHold: boolean,
  accepted: string | undefined,
): string | undefined => {
  if (now.major < before.major) return `CONTRACT_MAJOR went down (${before.major} → ${now.major}).`;
  if (now.major > before.major) return undefined;
  if (!typesHold)
    return `The API's types are not ones an app of contract ${before.major} can serve. Raise CONTRACT_MAJOR in src/shared/contract.ts, then run this again.`;
  const unchecked = [
    ...(now.sdk !== before.sdk ? [`the protocol SDK (${before.sdk} → ${now.sdk})`] : []),
    ...(now.preload !== before.preload ? ["the preload"] : []),
  ];
  if (unchecked.length > 0 && accepted === undefined)
    return `${unchecked.join(" and ")} changed, which no check can compare. If every app of contract ${before.major} still serves this page, run again with --accept "<why>" and say why in the commit; else raise CONTRACT_MAJOR.`;
  return undefined;
};

if (import.meta.main) {
  const at = process.argv.indexOf("--accept");
  const accepted = at === -1 ? undefined : process.argv[at + 1]?.trim();
  if (at !== -1 && !accepted) throw new Error("--accept takes the reason, in words.");
  const before = await committedFacts();
  const now = factsNow();
  const check = now.major === before.major ? compatible() : { ok: true, out: "" };
  if (!check.ok) console.error(check.out);
  const refused = refusal(before, now, check.ok, accepted);
  if (refused !== undefined) throw new Error(refused);
  if (accepted !== undefined) console.log(`Accepted: ${accepted}`);
  await makeSnapshot(CONTRACT_DIR);
  console.log(`The snapshot of contract ${now.major} is taken.`);
}
