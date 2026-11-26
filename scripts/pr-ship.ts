// `bun run pr-ship`: check, push, open a PR, wait for CI, squash-merge, then prune the worktree.
//
//   bun scripts/pr-ship.ts [--title text] [--body text]
//
// Steps run in order and the first failing one stops the run with its exit code (1 if it could not start):
// a failed check pushes nothing and opens no PR; failed CI merges nothing and prunes nothing.
// CI is awaited with `gh pr checks --watch`, not by polling. Worktree removal is `bun run worktree:prune`.

export type Step = { name: string; cmd: string[] };
export type Runner = (cmd: string[]) => Promise<number>;

export const steps = (
  opts: { title?: string | undefined; body?: string | undefined } = {},
): Step[] => [
  { name: "check", cmd: ["bun", "run", "check"] },
  { name: "push", cmd: ["git", "push", "-u", "origin", "HEAD"] },
  {
    name: "pr create",
    cmd: [
      "gh",
      "pr",
      "create",
      ...(opts.title === undefined
        ? ["--fill"]
        : ["--title", opts.title, "--body", opts.body ?? ""]),
    ],
  },
  { name: "ci", cmd: ["gh", "pr", "checks", "--watch"] },
  { name: "merge", cmd: ["gh", "pr", "merge", "--squash"] },
  { name: "prune", cmd: ["bun", "run", "worktree:prune"] },
];

/** Run the steps in order; returns 0, or the exit code of the first step that failed. */
export const ship = async (
  run: Runner,
  opts: { title?: string | undefined; body?: string | undefined } = {},
  log: (line: string) => void = () => {},
): Promise<number> => {
  for (const step of steps(opts)) {
    log(`pr-ship: ${step.name}: ${step.cmd.join(" ")}`);
    const code = await run(step.cmd);
    if (code !== 0) {
      log(`pr-ship: ${step.name} failed (exit ${code}); stopping`);
      return code;
    }
  }
  return 0;
};

const spawnRunner: Runner = async (cmd) => {
  try {
    const proc = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return (await proc.exited) || 0;
  } catch {
    return 1;
  }
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  process.exit(
    await ship(spawnRunner, { title: value("--title"), body: value("--body") }, console.log),
  );
}
