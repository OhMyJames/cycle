// What a process the loop starts may see of the loop's own environment. The loop holds a tracker key and a GitHub
// token; commands that run code a session wrote (tests, builds) get neither (AGENTS.md: environment variables go
// by an explicit allowlist, and no token reaches an agent).

const BASE = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ"] as const;
/** What `git fetch`, `git push` and `gh` commands (PR / CI) need to authenticate, and only those commands get it. */
const DELIVER = ["SSH_AUTH_SOCK", "GH_TOKEN", "GITHUB_TOKEN", "GH_HOST"] as const;

const pick = (
  source: Record<string, string | undefined>,
  names: readonly string[],
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
};

/** For git, bun and the tests: no credentials. */
export const verifyEnv = (source: Record<string, string | undefined>): Record<string, string> => ({
  ...pick(source, BASE),
  CI: "1",
});

/** For `git fetch`, `git push` and `gh` commands (PR creation/update and CI status/logs) only. */
export const deliverEnv = (source: Record<string, string | undefined>): Record<string, string> => ({
  ...pick(source, BASE),
  ...pick(source, DELIVER),
});

/**
 * git's own switches that make it run what is in the worktree: hooks (`core.hooksPath` is a path inside the
 * worktree, which the session can edit). Every git the loop runs after a session has touched the worktree has these.
 */
export const GIT_SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"] as const;
