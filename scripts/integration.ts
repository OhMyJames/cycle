// `bun run test:integration`: the tests that start real processes (Claude, a daemon, Electron: under xvfb on
// Linux, hidden and out of the Dock on macOS; and the page in headless Chromium). They are not in the gate: each takes seconds to a minute and the heaviest holds about 1.5 GB.
//
// Serial on purpose: the target is a 2-core, 4 GB machine, where running two Electron stacks at once
// would not finish sooner and could be killed for memory. Each suite has a deadline of its own, so a
// hang costs that, not the 10 minutes of a default.
//   bun run test:integration          all of them
//   bun run test:integration web      only those whose name contains "web"
// Options: --strict (a suite that was skipped, or ran no test, fails: for a machine that is meant to have
// Electron, sshd, Chromium and, on Linux, xvfb), --summary <file> (a markdown table of the result: CI's step summary).
// The list of suites, and what a suite's result means, are in integration-suites.ts.

import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markdown, outcome, type Row, suites } from "./integration-suites.ts";

const root = new URL("..", import.meta.url).pathname;

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const summaryAt = args.indexOf("--summary");
const summaryFile = summaryAt === -1 ? undefined : args[summaryAt + 1];
if (summaryAt !== -1 && (summaryFile === undefined || summaryFile.startsWith("--"))) {
  console.error("--summary needs a value");
  process.exit(2);
}
const isValue = (i: number) => summaryAt !== -1 && i === summaryAt + 1;
const unknown = args.find(
  (a, i) => a.startsWith("--") && a !== "--strict" && a !== "--summary" && !isValue(i),
);
if (unknown !== undefined) {
  console.error(`unknown option ${unknown}: the options are --strict and --summary <file>`);
  process.exit(2);
}
const only = args.find((a, i) => !a.startsWith("--") && !isValue(i));
const chosen = suites.filter((s) => only === undefined || s.name.includes(only));
if (chosen.length === 0) {
  console.error(`no suite matches "${only}"; they are: ${suites.map((s) => s.name).join(", ")}`);
  process.exit(2);
}

// Every temporary directory a suite makes is under this run's own: a process that a killed suite leaves
// behind has it in its command line, so it is found by that and by nothing else. Another checkout's run, or
// the person's own app, is not matched by a pattern that happens to look like it.
// The name is short: a unix socket's path has about 100 characters on macOS, and a suite's temporary directory is under this.
const scratch = mkdtempSync(join(tmpdir(), "cv1-r-"));
let running: ReturnType<typeof Bun.spawn> | undefined;
const cleanUp = () => {
  // The suite itself has this directory in its environment, not on its command line.
  running?.kill(9);
  Bun.spawnSync(["pkill", "-9", "-f", scratch]);
  try {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
};
for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const)
  process.on(signal, () => {
    cleanUp();
    process.exit(code);
  });

/** Passes the output on as it comes, and keeps it: bun test says at the end how many tests it skipped. */
const run = async (
  cmd: string[],
  cwd: string,
  seconds: number,
): Promise<{ code: number; timedOut: boolean; output: string }> => {
  const proc = Bun.spawn(cmd, {
    cwd: `${root}${cwd}`,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TMPDIR: scratch, CYCLE_TEST_REAL_AGENTS: "1" },
  });
  running = proc;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill(9);
    // What it started shares its output pipes: until those end, reading them would not.
    Bun.spawnSync(["pkill", "-9", "-f", scratch]);
  }, seconds * 1000);
  let output = "";
  const pass = async (stream: ReadableStream<Uint8Array>, to: (text: string) => void) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      output += text;
      to(text);
    }
  };
  await Promise.all([
    pass(proc.stdout as ReadableStream<Uint8Array>, (t) => process.stdout.write(t)),
    pass(proc.stderr as ReadableStream<Uint8Array>, (t) => process.stderr.write(t)),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  running = undefined;
  return { code, timedOut, output };
};

const rows: Row[] = [];
const finish = () => {
  cleanUp();
  console.log(
    `\n${rows
      .map(
        (r) =>
          `${r.status.padEnd(8)} ${r.name.padEnd(8)} ${r.seconds === undefined ? "" : `${r.seconds.toFixed(1)}s`}${r.reason ? `  ${r.reason}` : ""}`,
      )
      .join("\n")}`,
  );
  if (summaryFile !== undefined) appendFileSync(summaryFile, `${markdown(rows)}\n`);
  process.exit(rows.some((r) => r.status === "FAIL") ? 1 : 0);
};

// The web suite opens the built page, in Playwright's Chromium (installed here if it is not: half a second if it is).
if (chosen.some((s) => s.name === "web")) {
  console.log("== build the desktop app, and have Chromium");
  const ready =
    (await run(["bun", "run", "build"], "apps/desktop", 60)).code === 0 &&
    (await run(["bunx", "playwright", "install", "chromium-headless-shell"], "apps/desktop", 300))
      .code === 0;
  if (!ready) {
    for (const suite of chosen)
      rows.push(
        suite.name === "web"
          ? {
              name: suite.name,
              status: "FAIL",
              reason: "the desktop app did not build, or Chromium could not be installed",
            }
          : { name: suite.name, status: "not run", reason: "the build before the suites failed" },
      );
    finish();
  }
}

for (const suite of chosen) {
  const started = Date.now();
  console.log(`\n== ${suite.name} (limit ${suite.seconds}s)`);
  const { code, timedOut, output } = await run(
    ["bun", "test", `./${suite.file}`],
    suite.cwd,
    suite.seconds,
  );
  rows.push({
    name: suite.name,
    ...outcome({ suite, code, timedOut, output, strict }),
    seconds: (Date.now() - started) / 1000,
  });
  // A suite that was killed can leave processes behind: this run's directory says whose they are.
  Bun.spawnSync(["pkill", "-9", "-f", scratch]);
}
finish();
