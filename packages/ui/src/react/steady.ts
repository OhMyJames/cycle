import { useEffect, useRef, useState } from "react";

/** What is shown stays at least this long, so a run of quick calls does not flicker through their names. */
export const MIN_SHOWN_MS = 650;
/** And a change waits this long, so a call that is over at once is never shown. */
export const SWITCH_DELAY_MS = 150;

/**
 * `value`, held steady by `key`: a new key is shown only once the one shown has been up for `MIN_SHOWN_MS`, and never
 * sooner than `SWITCH_DELAY_MS` after it came; while the key stays, the value is the latest. A key that comes and goes
 * while one waits is never shown. An urgent key, coming or going (a question for the person, nothing left to show),
 * changes what is shown at once. Gives the value shown and its key. The timings are old-cycle's (`content/tail.tsx`,
 * `useSteadyText`).
 */
export const useSteady = <T>(
  value: T,
  key: string,
  urgent: (key: string) => boolean = () => false,
): [T, string] => {
  const [shownKey, setShownKey] = useState(key);
  const held = useRef(value);
  const since = useRef(Date.now());
  const now = key !== shownKey && (urgent(key) || urgent(shownKey));
  if (now) {
    // Set while drawing, so the urgent one is what this very render shows.
    since.current = Date.now();
    setShownKey(key);
  }
  const current = key === shownKey || now;
  if (current) held.current = value;
  useEffect(() => {
    if (key === shownKey) return undefined;
    const wait = Math.max(SWITCH_DELAY_MS, MIN_SHOWN_MS - (Date.now() - since.current));
    const timer = setTimeout(() => {
      since.current = Date.now();
      setShownKey(key);
    }, wait);
    return () => clearTimeout(timer);
  }, [key, shownKey]);
  return current ? [value, key] : [held.current, shownKey];
};
