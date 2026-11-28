// `bun run check:changed`: while iterating, run only the tests of the packages a change touches.
// Changed = this branch against its merge-base with main, plus uncommitted and untracked files.
// Commit-time still runs the full `bun run check`; this does not replace it.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { workspaceManifests } from "./workspaces.ts";

export type Pkg = { name: string; dir: string; deps: string[] };

const FULL = [
  /^package\.json$/,
  /^bun\.lock$/,
  /^tsconfig[^/]*\.json$/,
  /^biome\.json$/,
  /^bunfig\.toml$/,
  /^\.github\//,
  /^scripts\/check/,
  /^scripts\/boundaries\.ts$/,
  /^scripts\/workspaces\.ts$/,
  /^scripts\/module-graph(?:\.test)?\.ts$/,
];

export type Selection = { full: true } | { full: false; dirs: string[] };

/** Files that change what every package is checked against. */
export const triggersFull = (file: string): boolean => FULL.some((re) => re.test(file));

/** The package directories to test for these changed files (repo-relative, forward slashes). */
export function select(files: string[], pkgs: Pkg[]): Selection {
  if (files.some(triggersFull)) return { full: true };
  const hit = new Set<string>();
  for (const file of files) {
    const owner = pkgs.find((p) => file.startsWith(`${p.dir}/`));
    if (owner) hit.add(owner.name);
  }
  // Add dependents, transitively.
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of pkgs) {
      if (!hit.has(p.name) && p.deps.some((d) => hit.has(d))) {
        hit.add(p.name);
        grew = true;
      }
    }
  }
  return {
    full: false,
    dirs: pkgs
      .filter((p) => hit.has(p.name))
      .map((p) => p.dir)
      .sort(),
  };
}

type Manifest = Partial<
  Record<
    "dependencies" | "devDependencies" | "peerDependencies" | "optionalDependencies",
    Record<string, string>
  >
> & { name?: string };

export async function loadPackages(root: string): Promise<Pkg[]> {
  const manifests: [string, Manifest][] = [];
  for (const file of await workspaceManifests(root)) {
    manifests.push([
      file.slice(0, -"/package.json".length),
      await Bun.file(join(root, file)).json(),
    ]);
  }
  const names = new Set(manifests.map(([, m]) => m.name).filter((n): n is string => !!n));
  return manifests.flatMap(([dir, m]) => {
    if (!m.name) return [];
    const deps = [
      m.dependencies,
      m.devDependencies,
      m.peerDependencies,
      m.optionalDependencies,
    ].flatMap((section) => Object.keys(section ?? {}).filter((d) => names.has(d)));
    return [{ name: m.name, dir, deps }];
  });
}

const git = (root: string, args: string[]) => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
  );
  const run = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env });
  return { code: run.status, out: run.stdout.trim() };
};

/** Files changed on this branch since it left main, plus uncommitted and untracked ones. */
export function changedFiles(root: string): string[] {
  let base: string | undefined;
  for (const main of ["origin/main", "main"]) {
    const mb = git(root, ["merge-base", "HEAD", main]);
    if (mb.code === 0 && mb.out) {
      base = mb.out;
      break;
    }
  }
  if (!base) throw new Error("no merge-base with origin/main or main; run `bun run check`");
  const lines = (args: string[]) => {
    const r = git(root, args);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed`);
    return r.out.split("\n").filter(Boolean);
  };
  return [
    ...new Set([
      ...lines(["diff", "--name-only", "--no-renames", base]),
      ...lines(["ls-files", "--others", "--exclude-standard"]),
    ]),
  ].sort();
}

if (import.meta.main) {
  const root = new URL("..", import.meta.url).pathname;
  const files = changedFiles(root);
  const selection = select(files, await loadPackages(root));
  let cmd: string[];
  if (selection.full) {
    console.log("check:changed: a gate-wide file changed, running all tests");
    cmd = ["bun", "test", "--parallel=2"];
  } else if (selection.dirs.length === 0) {
    console.log("check:changed: no package affected, nothing to run");
    process.exit(0);
  } else {
    console.log(`check:changed: ${selection.dirs.join(", ")}`);
    cmd = ["bun", "test", "--parallel=2", ...selection.dirs.map((d) => `./${d}/`)];
  }
  const proc = Bun.spawn(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  process.exit(await proc.exited);
}
