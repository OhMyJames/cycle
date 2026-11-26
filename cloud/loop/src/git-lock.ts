// Worktrees share the main repository's `.git`, so two concurrent `git fetch` can collide on
// FETCH_HEAD or ref locks. One chain per repository root (not per Project: two Projects may
// point at the same repository) keeps them one at a time.
const tails = new Map<string, Promise<unknown>>();

export async function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(repoRoot) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  tails.set(repoRoot, tail);
  try {
    return await run;
  } finally {
    if (tails.get(repoRoot) === tail) tails.delete(repoRoot);
  }
}
