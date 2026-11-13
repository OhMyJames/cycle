import { useLayoutEffect, useRef, useState } from "react";
import { type Hold, holdState } from "./hold";
import type { LoaderState } from "./scenes";

/** What the loader shows when the agent is doing `target`: `target`, once the state before it has had its time (hold.ts). */
export function useHeldState(target: LoaderState): LoaderState {
  const [shown, setShown] = useState(target);
  const hold = useRef<Hold | undefined>(undefined);
  const first = useRef(target);
  useLayoutEffect(() => {
    const clock = {
      now: () => performance.now(),
      after: (ms: number, callback: () => void) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    };
    const current = holdState(clock, first.current, setShown);
    hold.current = current;
    return () => {
      current.stop();
      hold.current = undefined;
    };
  }, []);
  useLayoutEffect(() => hold.current?.want(target), [target]);
  return shown;
}
