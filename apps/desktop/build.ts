import { rm } from "node:fs/promises";

const outdir = `${import.meta.dir}/dist`;
await rm(outdir, { recursive: true, force: true });

const results = await Promise.all([
  // Electron main process: CommonJS for Node, `electron` provided at runtime.
  Bun.build({
    entrypoints: [`${import.meta.dir}/src/main.ts`],
    outdir,
    target: "node",
    format: "cjs",
    naming: "[name].cjs",
    external: ["electron"],
  }),
  // Renderer: a static bundle rooted at index.html.
  Bun.build({
    entrypoints: [`${import.meta.dir}/src/renderer/index.html`],
    outdir: `${outdir}/renderer`,
    target: "browser",
    minify: true,
  }),
]);

for (const result of results) {
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}
console.log(`built ${outdir}`);
