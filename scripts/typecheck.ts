import { join } from "node:path";
import { listTsProjects, ROOT } from "./lib/workspace.ts";

// Each package is checked under its own tsconfig, so its `lib` and `types` decide
// which platform APIs it can see. A single root program would blur that.
const projects = [".", ...(await listTsProjects())];
const tsc = join(ROOT, "node_modules", ".bin", "tsc");

const results = await Promise.all(
  projects.map(async (project) => {
    const child = Bun.spawn([tsc, "--noEmit", "-p", join(ROOT, project)], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { project, output: stdout + stderr, code };
  }),
);

const failed = results.filter((result) => result.code !== 0);
for (const { project, output } of failed) {
  console.error(`--- ${project}\n${output}`);
}

if (failed.length > 0) process.exit(1);
console.log(`typecheck ok (${projects.length} projects)`);
