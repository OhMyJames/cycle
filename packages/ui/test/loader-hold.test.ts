import { expect, test } from "bun:test";
import { HOLD_MS, type HoldClock, holdState } from "../src/react/loader/hold.ts";
import type { LoaderState } from "../src/react/loader/scenes.ts";

/** A clock the test winds: timers go off as `wind` passes them. */
function fakeClock() {
  let time = 0;
  let timers: { at: number; callback: () => void }[] = [];
  const clock: HoldClock = {
    now: () => time,
    after: (ms, callback) => {
      const timer = { at: time + ms, callback };
      timers.push(timer);
      return () => {
        timers = timers.filter((other) => other !== timer);
      };
    },
  };
  const wind = (ms: number) => {
    const end = time + ms;
    for (;;) {
      const next = timers.toSorted((a, b) => a.at - b.at)[0];
      if (next === undefined || next.at > end) break;
      timers = timers.filter((other) => other !== next);
      time = next.at;
      next.callback();
    }
    time = end;
  };
  return { clock, wind, pending: () => timers.length };
}

test("a run of quick changes shows the first until its time is up, then the latest, skipping those between", () => {
  const { clock, wind } = fakeClock();
  const shown: LoaderState[] = [];
  const hold = holdState(clock, "thinking", (state) => shown.push(state));
  wind(100);
  hold.want("searching");
  wind(100);
  hold.want("executing");
  wind(100);
  hold.want("responding");
  expect(shown).toEqual([]);
  wind(HOLD_MS);
  expect(shown).toEqual(["responding"]);
});

test("waiting for the person comes at once, and so does what follows it", () => {
  const { clock, wind } = fakeClock();
  const shown: LoaderState[] = [];
  const hold = holdState(clock, "thinking", (state) => shown.push(state));
  wind(10);
  hold.want("waiting");
  hold.want("thinking");
  expect(shown).toEqual(["waiting", "thinking"]);
});

test("going back to what is shown, before its time is up, changes nothing and leaves no timer", () => {
  const { clock, wind, pending } = fakeClock();
  const shown: LoaderState[] = [];
  const hold = holdState(clock, "thinking", (state) => shown.push(state));
  hold.want("executing");
  expect(pending()).toBe(1);
  hold.want("thinking");
  wind(HOLD_MS * 2);
  expect(shown).toEqual([]);
  expect(pending()).toBe(0);
  hold.want("executing");
  hold.stop();
  expect(pending()).toBe(0);
});
