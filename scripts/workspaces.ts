// Both the dependency gate and changed-package selection must see the workspaces Bun installs.
import { join, posix } from "node:path";
import { Glob } from "bun";

export async function workspaceManifests(root: string): Promise<string[]> {
  const { workspaces } = await Bun.file(join(root, "package.json")).json();
  const paths = new Set<string>();
  const patterns: string[] = workspaces.packages;
  // Bun applies exclusions to glob matches in any order. Explicit package paths take precedence.
  const excludes = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => new Glob(posix.join(pattern.slice(1), "package.json")));
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) continue;
    const manifest = posix.join(pattern, "package.json");
    for (const file of new Glob(manifest).scanSync({ cwd: root })) {
      const path = posix.normalize(file);
      if (
        path === manifest ||
        (!path.split("/").includes("node_modules") && !excludes.some((glob) => glob.match(path)))
      ) {
        paths.add(path);
      }
    }
  }
  return [...paths].sort();
}
