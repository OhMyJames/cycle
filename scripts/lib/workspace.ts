import { dirname, join } from "node:path";
import {
  isGeneratedPath,
  isManifest,
  type Manifest,
  type SourceFile,
  type WorkspacePackage,
} from "./boundaries.ts";

export const ROOT = join(import.meta.dir, "..", "..");

const WORKSPACE_MANIFESTS = "{apps,harness,packages}/*/package.json";
const CODE_EXTENSIONS = "{ts,tsx,mts,cts,js,jsx,mjs,cjs}";
const SOURCE_FILES = `**/*.${CODE_EXTENSIONS}`;
const TEST_FILES = `**/*.{test,spec}.${CODE_EXTENSIONS}`;

const PACKAGE_PROJECTS = "{apps,harness,packages}/*/tsconfig.json";
const TEST_PROJECTS = "{apps,harness,packages}/*/test/tsconfig.json";

const scan = (glob: string, cwd: string = ROOT): Promise<string[]> =>
  Array.fromAsync(new Bun.Glob(glob).scan({ cwd }));

const readAll = (paths: readonly string[]): Promise<SourceFile[]> =>
  Promise.all(
    paths
      .filter((path) => !isGeneratedPath(path))
      .map(async (path) => ({ path, code: await Bun.file(join(ROOT, path)).text() })),
  );

export async function readManifest(path: string): Promise<Manifest> {
  const value: unknown = await Bun.file(path).json();
  if (!isManifest(value)) throw new Error(`${path} is not a valid package manifest`);
  return value;
}

export const readRootManifest = (): Promise<Manifest> => readManifest(join(ROOT, "package.json"));

/** Stops the run unless the Bun running it is the one package.json pins. */
export async function requirePinnedBun(): Promise<void> {
  const { packageManager } = await readRootManifest();
  if (`bun@${Bun.version}` !== packageManager) {
    console.error(`bun ${Bun.version} is running, but package.json pins ${packageManager}`);
    process.exit(1);
  }
}

export async function listPackageDirs(): Promise<string[]> {
  const manifests = await scan(WORKSPACE_MANIFESTS);
  return manifests.map((path) => dirname(path)).toSorted();
}

export async function readPackage(dir: string): Promise<WorkspacePackage> {
  const absolute = join(ROOT, dir);
  const paths = await scan(SOURCE_FILES, absolute);
  // Root-relative, as the files' paths are, so a violation names a path from the root.
  return {
    dir,
    manifest: await readManifest(join(absolute, "package.json")),
    files: await readAll(paths.map((path) => join(dir, path))),
    hasTestProject: await Bun.file(join(absolute, "test", "tsconfig.json")).exists(),
  };
}

/** Every test file in the repository, wherever it was put, relative to the root. */
export async function listTestFiles(): Promise<string[]> {
  const paths = await scan(TEST_FILES);
  return paths.filter((path) => !isGeneratedPath(path));
}

/** Every integration test file, relative to the root. */
export async function listIntegrationTests(): Promise<string[]> {
  const paths = await listTestFiles();
  return paths.filter((path) => path.includes("test/integration/")).toSorted();
}

/**
 * Every TypeScript project in the workspace, relative to the root. A test project with no
 * TypeScript in it yet is left out, because the compiler fails a project with no inputs.
 */
export async function listTsProjects(): Promise<string[]> {
  const packages = (await scan(PACKAGE_PROJECTS)).map((path) => dirname(path));
  const tests = (await scan(TEST_PROJECTS)).map((path) => dirname(path));
  const withCode = await Promise.all(
    tests.map(async (dir) => (await scan("**/*.{ts,tsx,mts,cts}", join(ROOT, dir))).length > 0),
  );
  return [...packages, ...tests.filter((_, index) => withCode[index] === true)]
    .filter((path) => !isGeneratedPath(`${path}/`))
    .toSorted();
}

/** The gate's own code, which is in no workspace package. */
export const readScripts = async (): Promise<SourceFile[]> =>
  readAll(await scan(`scripts/${SOURCE_FILES}`));
