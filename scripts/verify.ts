// The tests the gate leaves out: every test file under a `test/integration/` directory. Each file
// runs alone, one after the other, so its time is its own and two never fight over a port.
//
//   bun run test:integration             every integration test
//   bun run test:integration <filter>    only the files whose path contains the filter
import { listIntegrationTests, requirePinnedBun, ROOT } from "./lib/workspace.ts";

const TEST_TIMEOUT_MS = 60_000;
const FILE_BUDGET_MS = 60_000;

await requirePinnedBun();

const filters = process.argv.slice(2);
const all = await listIntegrationTests();
const files = all.filter(
  (path) => filters.length === 0 || filters.some((filter) => path.includes(filter)),
);

if (files.length === 0) {
  console.log(
    all.length === 0 ? "verify ok (no integration tests)" : "verify ok (no file matches)",
  );
  process.exit(0);
}

const failed: string[] = [];
const started = performance.now();

for (const path of files) {
  const fileStarted = performance.now();
  const child = Bun.spawn(["bun", "test", `--timeout=${TEST_TIMEOUT_MS}`, `./${path}`], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const ms = Math.round(performance.now() - fileStarted);
  const overBudget = ms > FILE_BUDGET_MS;
  const passed = code === 0 && !overBudget;
  console.log(`${passed ? "ok  " : "FAIL"} ${path} ${ms}ms`);
  if (code !== 0) console.log(stdout + stderr);
  if (overBudget) console.log(`${path}: ${ms}ms exceeds the ${FILE_BUDGET_MS}ms budget of a file`);
  if (!passed) failed.push(path);
}

if (failed.length > 0) {
  console.error(`\nverify failed: ${failed.join(", ")}`);
  process.exit(1);
}

console.log(`\nverify ok (${files.length} files) ${Math.round(performance.now() - started)}ms`);
