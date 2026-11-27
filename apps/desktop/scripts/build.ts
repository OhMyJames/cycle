// Builds the app into dist/: main (node, esm), the preload (cjs: a sandboxed preload cannot be esm),
// and the page (a browser bundle, its html, and the css Tailwind builds).
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { CONTRACT_FILE, contractDigest } from "./contract.ts";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "renderer"), { recursive: true });

// Compile against the stable Node-API. The bundle runs on the same minimum macOS as Electron.
if (process.platform === "darwin") {
  const headers = dirname(Bun.resolveSync("node-api-headers/package.json", root));
  const result = Bun.spawnSync(
    [
      "/usr/bin/clang",
      "-arch",
      process.arch === "arm64" ? "arm64" : "x86_64",
      "-mmacosx-version-min=13.0",
      "-fobjc-arc",
      "-bundle",
      "-undefined",
      "dynamic_lookup",
      "-framework",
      "AppKit",
      "-I",
      join(headers, "include"),
      join(root, "src/native/ime-paste.m"),
      "-o",
      join(dist, "ime-paste.node"),
    ],
    { stderr: "inherit" },
  );
  if (!result.success) throw new Error("Could not build the macOS paste handler");
}

const bundle = async (config: Parameters<typeof Bun.build>[0]) => {
  const result = await Bun.build(config);
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
};

await bundle({
  entrypoints: [join(root, "src/main/main.ts")],
  outdir: dist,
  target: "node",
  format: "esm",
  external: ["electron"],
  naming: "main.mjs",
});
await bundle({
  entrypoints: [join(root, "src/preload/preload.ts")],
  outdir: dist,
  target: "node",
  format: "cjs",
  external: ["electron"],
  naming: "preload.cjs",
});
await bundle({
  entrypoints: [join(root, "src/renderer/main.tsx")],
  outdir: join(dist, "renderer"),
  target: "browser",
  format: "esm",
  // Split: the highlighter's languages and themes load when a code block needs them (about 12 MB in all, 0.9 MB at start).
  splitting: true,
  naming: { entry: "renderer.js", chunk: "chunks/[name]-[hash].js", asset: "[name]-[hash].[ext]" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
await cp(join(root, "src/renderer/index.html"), join(dist, "renderer/index.html"));

const css = Bun.spawn(
  ["bun", join(root, "../../packages/ui/scripts/build-css.ts"), join(dist, "renderer/app.css")],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await css.exited) !== 0) process.exit(1);
console.log("built", dist);

await writeFile(join(dist, CONTRACT_FILE), `${contractDigest()}\n`);
