import { Engine, type Frame } from "./engine";
import type { LoaderState } from "./scenes";

/** What the runner needs of the window; a test gives it a clock it winds itself. */
export interface LoaderEnv {
  now(): number;
  request(callback: (time: number) => void): number;
  cancel(id: number): void;
  hidden(): boolean;
  /** Calls back when the window is hidden or shown; returns how to stop listening. */
  onVisibility(callback: () => void): () => void;
  reducedMotion(): boolean;
  /** Calls back when the setting for reduced motion changes; returns how to stop listening. */
  onReducedMotion(callback: () => void): () => void;
}

/** What the runner is run for: draw a frame, and say whether frames are being asked for. */
export interface LoaderOutput {
  paint(frame: Frame): void;
  animating(on: boolean): void;
}

export interface Runner {
  setState(next: LoaderState): void;
  dispose(): void;
}

/**
 * Drives an engine with the window's frames, and only while there is something to draw: no frame is asked for once the
 * loader has settled in its resting pose, nor while it is hidden. The first
 * picture is drawn at once, so there is no empty moment.
 */
export function runLoader(env: LoaderEnv, initial: LoaderState, out: LoaderOutput): Runner {
  const engine = new Engine(initial, env.now(), env.reducedMotion());
  let pending = 0;
  let disposed = false;
  let reported: boolean | undefined;

  const tick = (time: number): void => {
    pending = 0;
    out.paint(engine.step(time));
    schedule();
  };
  const schedule = (): void => {
    const want = !disposed && !engine.idle && !env.hidden();
    if (want && pending === 0) pending = env.request(tick);
    if (!want && pending !== 0) {
      env.cancel(pending);
      pending = 0;
    }
    // Said when it changes, not with every frame.
    if (reported !== (pending !== 0)) out.animating((reported = pending !== 0));
  };

  out.paint(engine.step(env.now()));
  schedule();
  const stopVisibility = env.onVisibility(schedule);
  const stopReduced = env.onReducedMotion(() => {
    engine.setReducedMotion(env.reducedMotion());
    schedule();
  });

  return {
    setState(next) {
      engine.setState(next, env.now());
      schedule();
    },
    dispose() {
      disposed = true;
      stopVisibility();
      stopReduced();
      schedule();
    },
  };
}
