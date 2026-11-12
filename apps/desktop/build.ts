import { rm } from "node:fs/promises";

const outdir = `${import.meta.dir}/dist`;
await rm(outdir, { recursive: true, force: true });

const node: Partial<Bun.BuildConfig> = {
  target: "node",
  format: "cjs",
  naming: "[name].cjs",
  external: ["electron"],
};
const results = await Promise.all([
  // Electron's main process and preload: CommonJS, with `electron` given at run time.
  Bun.build({ entrypoints: [`${import.meta.dir}/src/main.ts`], outdir, ...node }),
  Bun.build({ entrypoints: [`${import.meta.dir}/src/preload.ts`], outdir, ...node }),
  // The page: a static bundle rooted at index.html, which the daemon serves.
  // Code only some views need, such as the terminal emulator, is split off.
  Bun.build({
    entrypoints: [`${import.meta.dir}/src/renderer/index.html`],
    outdir: `${outdir}/renderer`,
    target: "browser",
    minify: true,
    splitting: true,
    define: { "process.env.NODE_ENV": '"production"' },
  }),
]);

for (const result of results) {
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}
console.log(`built ${outdir}`);
