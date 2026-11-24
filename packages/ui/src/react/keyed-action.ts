import { useCallback, useState } from "react";

/** What an action that did not happen answers with: anything else it answers is that it did. */
type Refusal = { problem: unknown };

/**
 * Actions on the rows of a list, each row by its key: which rows have one under way, and why the last one on a row
 * did not happen. Running one on a row takes back what its last one said went wrong, and says it again only if this
 * one also goes wrong.
 */
export function useKeyedAsyncAction<P extends Refusal>() {
  const [busy, setBusy] = useState<Readonly<Record<string, boolean>>>({});
  const [problems, setProblems] = useState<Readonly<Record<string, P>>>({});
  const run = useCallback(async <T extends object>(key: string, action: () => Promise<T | P>) => {
    setBusy((b) => ({ ...b, [key]: true }));
    setProblems(({ [key]: _gone, ...rest }) => rest);
    try {
      const answer = await action();
      if ("problem" in answer) setProblems((p) => ({ ...p, [key]: answer as P }));
      return answer;
    } finally {
      setBusy(({ [key]: _gone, ...rest }) => rest);
    }
  }, []);
  return { busy, problems, run };
}
