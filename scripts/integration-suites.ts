// The integration suites, and what a suite's result means. No process is started here: the runner
// (integration.ts) uses it, and the tests call it directly.
//
// Every suite runs every time. The original six together took about 35 s on CI, so choosing among them by what a change
// touched would save less than it costs to keep the rules that choose right (see docs/testing.md).

export type Group = "agents" | "shell";
export const groups: Group[] = ["agents", "shell"];

export type Suite = {
  name: string;
  cwd: string;
  file: string;
  seconds: number;
  /**
   * Which CI job runs it (`--group`): "agents" needs no display, Electron or Chromium; "shell" needs all three. The two run
   * side by side so that neither job, on a 2-core, 4 GB runner, takes more than the 2 minutes a job may.
   */
  group: Group;
  /** What the machine must have for the suite to run at all; a run on a machine that should have it fails without it. */
  needs?: string;
};

/** The suites, in the order they run. */
export const suites: Suite[] = [
  {
    name: "node",
    group: "shell",
    cwd: "packages/client",
    file: "test/integration/node.integration.ts",
    seconds: 60,
    needs: "electron",
  },
  {
    name: "adapter",
    group: "agents",
    cwd: "harness/claude",
    file: "test/integration/adapter.integration.ts",
    seconds: 90,
  },
  {
    name: "codex",
    group: "agents",
    cwd: "harness/codex",
    file: "test/integration/adapter.integration.ts",
    seconds: 90,
  },
  {
    name: "agy",
    group: "agents",
    cwd: "harness/agy",
    file: "test/integration/adapter.integration.ts",
    seconds: 90,
  },
  {
    name: "ssh",
    group: "agents",
    cwd: "apps/daemon",
    file: "test/integration/ssh.integration.ts",
    seconds: 60,
    needs: "sshd, ssh and ssh-keygen",
  },
  {
    name: "backend",
    group: "agents",
    cwd: "apps/daemon",
    file: "test/integration/full.integration.ts",
    seconds: 120,
  },
  {
    name: "package",
    group: "shell",
    cwd: "apps/desktop",
    file: "test/integration/packaged.integration.ts",
    seconds: 90,
    needs: "xvfb on Linux",
  },
  {
    name: "web",
    group: "shell",
    cwd: "apps/desktop",
    file: "test/integration/web.integration.ts",
    // Above the test's own 120 s: a test that runs long is reported by bun, with where it was, not killed first.
    seconds: 150,
    needs: "a built page and Playwright's Chromium",
  },
];

/** What bun test says at the end: " 12 pass", " 1 skip", " 0 fail". */
export const parseSummary = (raw: string): { pass: number; skip: number; fail: number } => {
  // Colours, if the environment asked for them, and the last such line: it is bun's, after anything a test printed.
  const output = raw.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
  const count = (word: string) => {
    const all = [...output.matchAll(new RegExp(`^\\s*(\\d+) ${word}\\s*$`, "gm"))];
    const last = all[all.length - 1];
    return last ? Number(last[1]) : 0;
  };
  return { pass: count("pass"), skip: count("skip"), fail: count("fail") };
};

export type Outcome = { status: "ok" | "FAIL" | "skip"; reason?: string };

/**
 * The exit code alone is not the result: a suite whose tests were all skipped (no Electron, no xvfb, no sshd)
 * exits 0. Where the machine is meant to have what the suite needs (`strict`, on CI), that is a failure;
 * elsewhere it is reported as skipped, with what it was waiting for.
 */
export const outcome = (input: {
  suite: Suite;
  code: number;
  timedOut: boolean;
  output: string;
  strict: boolean;
}): Outcome => {
  const { suite, code, timedOut, output, strict } = input;
  if (timedOut) return { status: "FAIL", reason: `over its limit of ${suite.seconds}s` };
  if (code !== 0) return { status: "FAIL", reason: `exit ${code}` };
  const { pass, skip } = parseSummary(output);
  const waiting = suite.needs ? `needs ${suite.needs}` : "its tests were skipped";
  if (pass === 0)
    return strict || skip === 0
      ? { status: "FAIL", reason: skip === 0 ? "no test ran" : `nothing ran: ${waiting}` }
      : { status: "skip", reason: `all tests skipped: ${waiting}` };
  if (skip > 0)
    return strict
      ? { status: "FAIL", reason: `${skip} skipped, and this machine should not: ${waiting}` }
      : { status: "ok", reason: `${skip} skipped` };
  return { status: "ok" };
};

export type Row = {
  name: string;
  status: Outcome["status"] | "not run";
  seconds?: number | undefined;
  reason?: string | undefined;
};

export const markdown = (rows: Row[]): string =>
  [
    "| suite | result | time | reason |",
    "| --- | --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.name} | ${r.status} | ${r.seconds === undefined ? "" : `${r.seconds.toFixed(1)}s`} | ${r.reason ?? ""} |`,
    ),
  ].join("\n");
