// Builds the daemon into one directory you can copy to a machine and run:
//
//   dist/cycle-<os>-<arch>/cycle   the daemon, one executable (Bun inside)
//   dist/cycle-<os>-<arch>/claude  each agent's own binary that its adapter drives (src/harnesses.ts, binaries.ts)
//
// plus a .tar.gz of it. The machine needs nothing else: no Bun, no Node, no `claude` on PATH.
import { chmod, cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { HARNESSES } from "../src/harnesses.ts";
import { BINARY_SOURCES } from "./binaries.ts";

const root = new URL("..", import.meta.url).pathname;
const name = `cycle-${process.platform}-${process.arch}`;
const out = join(root, "dist", name);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// Found before anything is built: a binary that is not there fails in a second, not after the compile.
const binaries: { name: string; from: string }[] = [];
for (const harness of HARNESSES) {
  if (harness.binary === undefined) continue;
  const source = BINARY_SOURCES[harness.id];
  if (source === undefined)
    throw new Error(`scripts/binaries.ts does not say where ${harness.id}'s binary is`);
  binaries.push({ name: harness.binary, from: await source() });
}

const version = String((await Bun.file(join(root, "../desktop/package.json")).json()).version);

const result = await Bun.build({
  entrypoints: [join(root, "src/main.ts")],
  // The daemon runs from whatever directory it was started in; it must not read a .env or bunfig.toml there.
  // The release version, which is the app's: one number for the whole release.
  define: { "process.env.CYCLE_BUILD_VERSION": JSON.stringify(version) },
  compile: { outfile: join(out, "cycle"), autoloadDotenv: false, autoloadBunfig: false },
  minify: false,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const { name: file, from } of binaries) {
  await cp(from, join(out, file));
  await chmod(join(out, file), 0o755);
}
await cp(join(root, "scripts/install.sh"), join(out, "install.sh"));
await chmod(join(out, "install.sh"), 0o755);
await chmod(join(out, "cycle"), 0o755);

if (Bun.argv.includes("--no-tarball")) {
  console.log(`built ${out}`);
  process.exit(0);
}
const tar = Bun.spawn(["tar", "-czf", `${name}.tar.gz`, name], {
  cwd: join(root, "dist"),
  stdout: "inherit",
  stderr: "inherit",
});
if ((await tar.exited) !== 0) process.exit(1);
const size = async (p: string) => ((await stat(p)).size / 1e6).toFixed(0);
const sizes = [];
for (const file of ["cycle", ...binaries.map((b) => b.name)])
  sizes.push(`${file} ${await size(join(out, file))} MB`);
console.log(
  `built ${out}  (${sizes.join(", ")}, tarball ${await size(join(root, "dist", `${name}.tar.gz`))} MB)`,
);
