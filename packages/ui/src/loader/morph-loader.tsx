import { useEffect, useLayoutEffect, useRef } from "react";
import { mount, paint, unmount } from "./paint";

const REDUCE_MOTION = "(prefers-reduced-motion: reduce)";
const subscribeReducedMotion = (notify: () => void): (() => void) => {
  const query = window.matchMedia(REDUCE_MOTION);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
};
const prefersReducedMotion = (): boolean => window.matchMedia(REDUCE_MOTION).matches;
import { type LoaderEnv, type Runner, runLoader } from "./runner";
import type { LoaderState } from "./scenes";
import { useHeldState } from "./use-held-state";

export type { LoaderState } from "./scenes";
export { loaderStateOfKind } from "./tool-state";

/**
 * The window, for a loader drawn in `element`: it counts as hidden while the window is, and while the element is off
 * screen or not laid out (in a closed group, `display: none`), so a loader no one can see asks for no frames.
 */
function browserEnv(element: Element): LoaderEnv {
  // Until the observer first reports, the loader is taken to be seen, so its first frames are not held back.
  let seen = true;
  const listeners = new Set<() => void>();
  const notify = (): void => listeners.forEach((callback) => callback());
  const observer = new IntersectionObserver((entries) => {
    const entry = entries.at(-1);
    if (entry === undefined || entry.isIntersecting === seen) return;
    seen = entry.isIntersecting;
    notify();
  });
  return {
    now: () => performance.now(),
    request: (callback) => requestAnimationFrame(callback),
    cancel: (id) => cancelAnimationFrame(id),
    hidden: () => document.hidden || !seen,
    onVisibility: (callback) => {
      if (listeners.size === 0) {
        observer.observe(element);
        document.addEventListener("visibilitychange", notify);
      }
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
        if (listeners.size > 0) return;
        observer.disconnect();
        document.removeEventListener("visibilitychange", notify);
      };
    },
    reducedMotion: prefersReducedMotion,
    onReducedMotion: subscribeReducedMotion,
  };
}

/**
 * Chains of dots that say what the agent is doing: one animation for each state, and a change from one to the next
 * that morphs and can be interrupted. A working state stays a moment before another replaces it (hold.ts), so a run of
 * quick calls does not keep it from settling. It takes the text's color (`currentColor`), is decoration (`aria-hidden`:
 * what it means is said beside it), and asks for frames only while something on it moves; `data-animating` says whether
 * that is so now, and `data-state` which state it shows. The animation is drawn straight into the SVG, not through
 * React, so a frame costs no render. With Reduce Motion it stands still.
 *
 * `className` sizes the box it takes in the layout, an icon's 16px as a rule; the drawing is always 24px, centred on that
 * box and spilling out of it, since its dots reach to within a pixel of its edges and would be lost at an icon's size.
 * Whatever holds it leaves 4px on each side unclipped.
 */
export function MorphLoader({
  state,
  className,
}: {
  state: LoaderState;
  className?: string;
}): React.ReactElement {
  const shown = useHeldState(state);
  const svg = useRef<SVGSVGElement>(null);
  const runner = useRef<Runner | undefined>(undefined);
  // The state a mounted loader starts in; after that, `shown` is passed on as it changes.
  const first = useRef(shown);

  useLayoutEffect(() => {
    const element = svg.current;
    if (element === null) return undefined;
    const canvas = mount(element);
    const run = runLoader(browserEnv(element), first.current, {
      paint: (frame) => paint(canvas, frame),
      animating: (on) => {
        element.dataset["animating"] = String(on);
      },
    });
    runner.current = run;
    return () => {
      run.dispose();
      runner.current = undefined;
      unmount(element);
    };
  }, []);

  useEffect(() => {
    runner.current?.setState(shown);
  }, [shown]);

  return (
    <span
      aria-hidden="true"
      data-slot="morph-loader"
      data-state={shown}
      className={className ? `morph-loader ${className}` : "morph-loader"}
    >
      <svg ref={svg} viewBox="0 0 100 100" />
    </span>
  );
}
