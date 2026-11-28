// Production TypeScript module dependencies. Run directly to print a Graphviz graph.
import { realpath } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { workspaceManifests } from "./workspaces.ts";

export async function moduleGraph(directory: string) {
  const root = await realpath(directory);
  const graph = new Map<string, string[]>();
  const packages = new Set<string>();
  for (const manifest of await workspaceManifests(root)) {
    packages.add((await Bun.file(join(root, manifest)).json()).name);
    const sources = new Bun.Glob(`${dirname(manifest)}/src/**/*.{ts,tsx}`);
    for (const file of sources.scanSync(root)) graph.set(file, []);
  }
  const ts = new Bun.Transpiler({ loader: "ts" });
  const tsx = new Bun.Transpiler({ loader: "tsx" });
  for (const [file, edges] of graph) {
    const source = (await Bun.file(join(root, file)).text()).replace(/^#![^\n]*/, "");
    const parser = file.endsWith(".tsx") ? tsx : ts;
    for (const { path } of parser.scanImports(source)) {
      const name = path
        .split("/")
        .slice(0, path.startsWith("@") ? 2 : 1)
        .join("/");
      if (!path.startsWith(".") && !packages.has(name)) continue;
      const target = relative(root, Bun.resolveSync(path, join(root, dirname(file))));
      if (graph.has(target) && !edges.includes(target)) edges.push(target);
    }
  }
  return graph;
}

/** Include the closing edge in diagnostics, so the owner can follow the whole cycle. */
export function firstCycle(graph: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const done = new Set<string>();
  const active = new Set<string>();
  function visit(file: string): string[] | undefined {
    if (done.has(file)) return;
    if (active.has(file)) {
      const path = [...active];
      return [...path.slice(path.indexOf(file)), file];
    }
    active.add(file);
    for (const dependency of graph.get(file) ?? []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    active.delete(file);
    done.add(file);
  }
  for (const file of graph.keys()) {
    const cycle = visit(file);
    if (cycle) return cycle;
  }
}

if (import.meta.main) {
  const graph = await moduleGraph(new URL("..", import.meta.url).pathname);
  console.log("digraph dependencies {");
  for (const file of [...graph.keys()].sort()) {
    console.log(`  ${JSON.stringify(file)};`);
    for (const dependency of [...(graph.get(file) ?? [])].sort()) {
      console.log(`  ${JSON.stringify(file)} -> ${JSON.stringify(dependency)};`);
    }
  }
  console.log("}");
}
