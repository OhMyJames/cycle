import { requirePinnedBun, ROOT } from "./lib/workspace.ts";

// The single gate. `--changed` runs only the unit tests affected by the working
// tree; the pre-commit hook uses it. Every other step always covers the whole repo.
const changedOnly = process.argv.includes("--changed");

const UNIT_TEST_BUDGET_MS = 30_000;

await requirePinnedBun();

type StepResult = { name: string; code: number; ms: number; output: string };

async function run(name: string, command: readonly string[]): Promise<StepResult> {
  const started = performance.now();
  const child = Bun.spawn([...command], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { name, code, ms: Math.round(performance.now() - started), output: stdout + stderr };
}

// Output stays quiet unless a step fails, so a passing gate costs an agent almost no context.
function report({ name, code, ms, output }: StepResult): void {
  console.log(`${code === 0 ? "ok  " : "FAIL"} ${name} ${ms}ms`);
  if (code !== 0) console.log(output);
}

const reported = async (step: Promise<StepResult>): Promise<StepResult> => {
  const result = await step;
  report(result);
  return result;
};

const started = performance.now();

// The lockfile step can touch node_modules, so it finishes before anything reads them.
const lockfile = await reported(
  run("lockfile", ["bun", "install", "--frozen-lockfile", "--ignore-scripts"]),
);

const others = await Promise.all(
  [
    run("boundaries", ["bun", "run", "boundaries"]),
    run("format", ["bun", "run", "format:check"]),
    run("typecheck", ["bun", "run", "typecheck"]),
    run("lint", ["bun", "run", "lint"]),
  ].map(reported),
);

// Alone, because each test's time limit should measure the test, not a CPU shared with the
// compiler and the linter.
const testResult = await reported(
  run("test", ["bun", "run", "test", ...(changedOnly ? ["--changed"] : [])]),
);

// A single slow test is caught by the per-test timeout. This catches slow growth.
if (testResult.ms > UNIT_TEST_BUDGET_MS) {
  testResult.code = 1;
  console.log(
    `FAIL test budget: ${testResult.ms}ms exceeds ${UNIT_TEST_BUDGET_MS}ms. ` +
      "Delete redundant tests or move slow ones to test/integration/.",
  );
}

const failed = [lockfile, ...others, testResult].filter((result) => result.code !== 0);
const total = Math.round(performance.now() - started);

if (failed.length > 0) {
  console.error(`\ncheck failed: ${failed.map((result) => result.name).join(", ")}`);
  process.exit(1);
}

console.log(`\ncheck ok ${total}ms`);
