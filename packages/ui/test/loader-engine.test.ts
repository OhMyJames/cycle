import { describe, expect, test } from "bun:test";
import { CORE_INDEX, Engine, type Frame } from "../src/react/loader/engine.ts";
import { HOLD_MS, settle } from "../src/react/loader/hold.ts";
import { sample } from "../src/react/loader/sample.ts";
import { DOTS, SCENES, SLOTS } from "../src/react/loader/scenes.ts";
import { loaderStateOfKind } from "../src/react/loader/tool-state.ts";
import { recipe } from "../src/react/loader/transition.ts";

const positions = (frame: Frame, slot = 0): string[] =>
  frame.dots
    .slice(slot * DOTS, (slot + 1) * DOTS)
    .map((dot) => `${dot.x.toFixed(2)},${dot.y.toFixed(2)},${dot.r.toFixed(2)}`);

/** Steps an engine through `times` and gives the last frame. */
const run = (engine: Engine, times: number[]): Frame => {
  let frame: Frame | undefined;
  for (const time of times) frame = engine.step(time);
  if (frame === undefined) throw new Error("no times");
  return frame;
};
const every = (from: number, to: number, by = 16): number[] =>
  Array.from({ length: Math.floor((to - from) / by) + 1 }, (_, n) => from + n * by);

const all = (frame: Frame): string[] => [0, 1, 2].flatMap((slot) => positions(frame, slot));
const figure8 = (clock: number) => sample(SCENES.figure8, clock, 1, 2, false);

/** Where the swim scene rests, frozen at its first pose. */
const RESTING = [
  "70.80,42.70,18.23",
  "49.68,30.50,13.56",
  "31.97,38.50,11.56",
  "27.53,54.54,9.79",
  "35.85,66.62,8.33",
  "48.42,67.36,7.11",
];

describe("sample", () => {
  test("is the same at the same time, and the same one loop later", () => {
    expect(figure8(0.37)).toEqual(figure8(0.37));
    expect(figure8(1.37).x).toBeCloseTo(figure8(0.37).x, 9);
    expect(figure8(1.37).y).toBeCloseTo(figure8(0.37).y, 9);
    expect(figure8(0.37)).not.toEqual(figure8(0.62));
  });

  test("gives a chain the scene does not have an invisible place on the first one's track", () => {
    const first = sample(SCENES.swim, 0.3, 0, 0, false);
    const spare = sample(SCENES.swim, 0.3, 2, 0, false);
    expect([spare.x, spare.y, spare.o]).toEqual([first.x, first.y, 0]);
    expect(spare.r).toBeCloseTo(first.r * 0.55, 9);
  });
});

describe("the engine", () => {
  test("rests when it starts as done, and has nothing more to draw", () => {
    const engine = new Engine("done", 0, false);
    const frame = engine.step(0);
    expect(positions(frame)).toEqual(RESTING);
    expect(engine.idle).toBe(true);
    expect(engine.step(5000)).toEqual(frame);
  });

  test("starts a change from the picture it had, and ends it in the new state's own", () => {
    const engine = new Engine("searching", 0, false);
    const straight = new Engine("thinking", 0, false);
    const before = run(engine, every(0, 1000));
    run(straight, every(0, 1000));
    engine.setState("thinking", 1008);
    expect(engine.idle).toBe(false);
    const middle = run(engine, every(1008, 1400));
    expect(middle.dots).not.toEqual(before.dots);
    expect(middle.dots).not.toEqual(run(straight, every(1008, 1400)).dots);
    expect(all(run(engine, every(1416, 2400)))).toEqual(all(run(straight, every(1416, 2400))));
  });

  test("goes on from what is on screen when the state changes again in the middle of a change", () => {
    const engine = new Engine("thinking", 0, false);
    run(engine, every(0, 1000));
    engine.setState("executing", 1008);
    const mid = run(engine, every(1008, 1400));
    engine.setState("searching", 1408);
    const again = engine.step(1408);
    again.dots.forEach((dot, n) => {
      const was = mid.dots[n];
      expect(Math.abs(dot.x - (was?.x ?? Number.NaN))).toBeLessThan(1.5);
      expect(Math.abs(dot.y - (was?.y ?? Number.NaN))).toBeLessThan(1.5);
    });
  });

  test("brings the core in on the way into executing and takes it out on the way out", () => {
    const engine = new Engine("thinking", 0, false);
    engine.step(0);
    engine.setState("executing", 16);
    expect(run(engine, every(16, 300)).core).toBeLessThan(1);
    const there = run(engine, every(316, 1000));
    expect(there.core).toBeGreaterThan(5);
    expect(there.core).toBeLessThan(7);
    engine.setState("responding", 1016);
    expect(run(engine, every(1016, 1100)).core).toBeLessThan(there.core);
    expect(run(engine, every(1116, 2100)).core).toBe(0);
  });

  test("brings the chains that split off out of the first one", () => {
    const engine = new Engine("waiting", 0, false);
    expect(
      engine
        .step(16)
        .dots.slice(DOTS)
        .every((dot) => dot.o === 0),
    ).toBe(true);
    engine.setState("thinking", 16);
    const settled = run(engine, every(32, 1300));
    expect(settled.dots.slice(DOTS).every((dot) => dot.o > 0)).toBe(true);
  });

  test("times each kind of change", () => {
    expect(recipe("thinking", "executing")).toMatchObject({ dur: 900, coreIn: true });
    expect(recipe("waiting", "thinking")).toMatchObject({ dur: 1100, split: true });
    expect(recipe("executing", "done")).toMatchObject({ dur: 1200, home: true, coreOut: true });
    expect(recipe("done", "waiting").dur).toBe(1000);
  });

  test("folds into its resting pose on the way to done, bounces once, and then stops", () => {
    const engine = new Engine("executing", 0, false);
    run(engine, every(0, 500));
    engine.setState("done", 512);
    const scales = every(528, 2400).map((time) => engine.step(time).scale);
    expect(Math.max(...scales)).toBeGreaterThan(1.03);
    expect(Math.max(...scales)).toBeLessThanOrEqual(1.06);
    const end = engine.step(2416);
    expect([end.scale, engine.idle]).toEqual([1, true]);
    expect(positions(end)).toEqual(RESTING);
  });

  // Cycle v1 differs from v2 here: with reduced motion nothing moves (DESIGN.md), where v2 kept the scenes going.
  test("stands still with reduced motion, in the state's resting pose, and cuts to the next state", () => {
    const engine = new Engine("thinking", 0, true);
    const first = engine.step(0);
    expect(engine.idle).toBe(true);
    expect(engine.step(400)).toEqual(first);
    engine.setState("searching", 400);
    expect(engine.idle).toBe(true);
    const cut = engine.step(416);
    expect(all(cut)).toEqual(all(new Engine("searching", 0, true).step(0)));
    expect(engine.step(5000)).toEqual(cut);
    engine.setState("done", 5000);
    expect([engine.step(5016).scale, engine.idle]).toEqual([1, true]);
  });

  test("comes to a stop, in the middle of a change, when reduced motion is turned on", () => {
    const engine = new Engine("thinking", 0, false);
    run(engine, every(0, 500));
    engine.setState("executing", 512);
    run(engine, every(528, 700));
    engine.setReducedMotion(true);
    expect(engine.idle).toBe(true);
    const still = engine.step(716);
    expect(all(still)).toEqual(all(new Engine("executing", 0, true).step(0)));
    expect(engine.step(2000)).toEqual(still);
  });

  test("ends a bounce that starts at time 0", () => {
    const engine = new Engine("thinking", -1200, false);
    engine.setState("done", -1200);
    run(engine, every(-1200, 0, 16).concat([0]));
    run(engine, every(16, 700));
    expect(engine.idle).toBe(true);
  });

  test("is drawn far to near, the core among the dots", () => {
    const frame = run(new Engine("executing", 0, false), every(0, 200));
    expect(frame.order.toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: SLOTS * DOTS + 1 }, (_, n) => n),
    );
    const depth = (n: number) =>
      n === CORE_INDEX ? 0.0005 : (frame.dots[n]?.z ?? 0) + (DOTS - (n % DOTS)) * 0.001;
    const depths = frame.order.map(depth);
    expect(depths).toEqual(depths.toSorted((a, b) => a - b));
  });

  test("does not run backwards when a frame's time is earlier than the one before", () => {
    const engine = new Engine("thinking", 100, false);
    const a = engine.step(100);
    expect(engine.step(90)).toEqual(a);
  });
});

describe("settle", () => {
  test("keeps a working state for its time before the next one comes", () => {
    expect(settle({ state: "thinking", since: 0 }, "searching", 200)).toEqual({
      shown: { state: "thinking", since: 0 },
      recheckIn: HOLD_MS - 200,
    });
    expect(settle({ state: "thinking", since: 0 }, "searching", HOLD_MS)).toEqual({
      shown: { state: "searching", since: HOLD_MS },
      recheckIn: undefined,
    });
  });

  test("lets waiting and done come and go at once", () => {
    expect(settle({ state: "thinking", since: 0 }, "waiting", 10).shown.state).toBe("waiting");
    expect(settle({ state: "waiting", since: 0 }, "executing", 10).shown.state).toBe("executing");
  });
});

test.each([
  ["read", "searching"],
  ["search", "searching"],
  ["list", "searching"],
  ["fetch", "searching"],
  ["think", "thinking"],
  ["execute", "executing"],
  ["edit", "executing"],
  ["other", "executing"],
  [undefined, "executing"],
] as const)("a tool of kind %p at work looks like %p", (kind, state) => {
  expect(loaderStateOfKind(kind)).toBe(state);
});
