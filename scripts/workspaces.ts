// Both the dependency gate and changed-package selection must see the workspaces Bun installs.
import { join, posix } from "node:path";
import { Glob } from "bun";

export async function workspaceManifests(root: string): Promise<string[]> {
  const { workspaces } = await Bun.file(join(root, "package.json")).json();
  const paths = new Set<string>();
  for (const pattern of workspaces.packages) {
    for (const file of new Glob(`${pattern}/package.json`).scanSync({ cwd: root }))
      paths.add(posix.normalize(file));
  }
  return [...paths].sort();
}
