import { expect, test } from "bun:test";
import type { Frame } from "../src/react/loader/engine.ts";
import { type LoaderEnv, runLoader } from "../src/react/loader/runner.ts";

/** A window the test winds by hand: frames wait until `frame()` runs them. */
function fakeWindow(options: { hidden?: boolean; reduced?: boolean } = {}) {
  let time = 0;
  let nextId = 1;
  const waiting = new Map<number, (time: number) => void>();
  const visibility = new Set<() => void>();
  const motion = new Set<() => void>();
  const state = {
    hidden: options.hidden ?? false,
    reduced: options.reduced ?? false,
    requested: 0,
  };
  const env: LoaderEnv = {
    now: () => time,
    request: (callback) => {
      state.requested++;
      waiting.set(nextId, callback);
      return nextId++;
    },
    cancel: (id) => void waiting.delete(id),
    hidden: () => state.hidden,
    onVisibility: (callback) => {
      visibility.add(callback);
      return () => visibility.delete(callback);
    },
    reducedMotion: () => state.reduced,
    onReducedMotion: (callback) => {
      motion.add(callback);
      return () => motion.delete(callback);
    },
  };
  return {
    env,
    state,
    get waiting() {
      return waiting.size;
    },
    /** Runs the frame that was asked for, `ms` later; false when none was asked for. */
    frame(ms = 16): boolean {
      time += ms;
      const [first] = [...waiting];
      if (first === undefined) return false;
      waiting.delete(first[0]);
      first[1](time);
      return true;
    },
    advance(ms: number) {
      time += ms;
    },
    hide(hidden: boolean) {
      state.hidden = hidden;
      for (const callback of visibility) callback();
    },
    reduce(reduced: boolean) {
      state.reduced = reduced;
      for (const callback of motion) callback();
    },
    listeners: () => visibility.size + motion.size,
  };
}

function output() {
  const log: { frames: Frame[]; animating: boolean[] } = { frames: [], animating: [] };
  return {
    log,
    out: {
      paint: (frame: Frame) => void log.frames.push(frame),
      animating: (on: boolean) => void log.animating.push(on),
    },
  };
}

/** Runs frames until none is asked for; the number of them, with a stop in case it never ends. */
function drain(window: ReturnType<typeof fakeWindow>, limit = 1000): number {
  let n = 0;
  while (window.frame() && n < limit) n++;
  return n;
}

test("draws the first picture at once and asks for no frame while it rests as done", () => {
  const window = fakeWindow();
  const { log, out } = output();
  runLoader(window.env, "done", out);
  expect(log.frames).toHaveLength(1);
  expect(window.state.requested).toBe(0);
  expect(log.animating.at(-1)).toBe(false);
});

test("asks for frames while it moves", () => {
  const window = fakeWindow();
  const { log, out } = output();
  runLoader(window.env, "thinking", out);
  expect(window.waiting).toBe(1);
  expect(log.animating.at(-1)).toBe(true);
  for (let n = 0; n < 50; n++) expect(window.frame()).toBe(true);
  expect(log.frames).toHaveLength(51);
});

test("stops asking for frames once it has come to rest, and starts again when the state changes", () => {
  const window = fakeWindow();
  const { log, out } = output();
  const runner = runLoader(window.env, "executing", out);
  drain(window, 30);
  runner.setState("done");
  drain(window);
  expect(window.waiting).toBe(0);
  expect(log.animating.at(-1)).toBe(false);
  const before = window.state.requested;
  window.advance(60_000);
  expect(window.state.requested).toBe(before);
  runner.setState("thinking");
  expect(window.waiting).toBe(1);
  expect(log.animating.at(-1)).toBe(true);
});

test("asks for no frame while the window is hidden, and for one again when it is shown", () => {
  const window = fakeWindow();
  const { out, log } = output();
  runLoader(window.env, "thinking", out);
  window.hide(true);
  expect(window.waiting).toBe(0);
  expect(log.animating.at(-1)).toBe(false);
  window.hide(false);
  expect(window.waiting).toBe(1);
});

test("starts hidden without asking for a frame", () => {
  const window = fakeWindow({ hidden: true });
  runLoader(window.env, "thinking", output().out);
  expect(window.state.requested).toBe(0);
});

test("with reduced motion asks for no frame: each state is drawn once, still, as it comes", () => {
  const window = fakeWindow({ reduced: true });
  const { out, log } = output();
  const runner = runLoader(window.env, "thinking", out);
  expect(window.state.requested).toBe(0);
  expect(log.animating.at(-1)).toBe(false);
  expect(log.frames).toHaveLength(1);
  runner.setState("executing");
  expect(window.state.requested).toBe(0);
  expect(log.frames).toHaveLength(2);
  expect(log.frames[1]?.core).toBeGreaterThan(5);
  // The setting turned off, it moves again; on again, it stops where the state rests, drawn once more.
  window.reduce(false);
  expect(window.waiting).toBe(1);
  expect(log.animating.at(-1)).toBe(true);
  window.reduce(true);
  expect(window.waiting).toBe(0);
  expect(log.animating.at(-1)).toBe(false);
  expect(log.frames).toHaveLength(3);
});

test("lets go of the window when it is disposed", () => {
  const window = fakeWindow();
  const { out, log } = output();
  const runner = runLoader(window.env, "thinking", out);
  expect(window.listeners()).toBe(2);
  runner.dispose();
  expect(window.waiting).toBe(0);
  expect(window.listeners()).toBe(0);
  expect(log.animating.at(-1)).toBe(false);
  runner.setState("searching");
  expect(window.waiting).toBe(0);
});
