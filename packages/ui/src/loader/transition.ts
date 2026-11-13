import { clamp, type Dot, easeOut, lerp } from "./sample";
import { CENTER, DOTS, type LoaderState, SCENES, SLOTS, STATES } from "./scenes";

/**
 * How the loader gets from one state to another. Every pair of states has a way, made of these moves:
 *   split   : more chains than before (new ones peel off the first, one by one)
 *   merge   : fewer (the extra ones chase the first and melt into it)
 *   coreIn  : into executing (they swirl into rings, then the core condenses)
 *   coreOut : out of executing (the core dissolves first, then they spin out)
 *   home    : into done (all fold into the resting pose and settle with one small bounce)
 * With none of them it is a plain re-route: the head turns to the new track and the body follows, on arcs around the centre.
 */
export interface Recipe {
  /** Milliseconds. */
  dur: number;
  split: boolean;
  merge: boolean;
  coreIn: boolean;
  coreOut: boolean;
  home: boolean;
}

export function recipe(from: LoaderState, to: LoaderState): Recipe {
  const a = SCENES[STATES[from].scene];
  const b = SCENES[STATES[to].scene];
  const split = b.chains.length > a.chains.length;
  const merge = b.chains.length < a.chains.length;
  const home = to === "done";
  let dur = 900;
  if (split || merge) dur = 1100;
  if (home) dur = 1200;
  if (from === "done") dur = 1000;
  return {
    dur,
    split,
    merge,
    coreIn: a.core === 0 && b.core !== 0,
    coreOut: a.core !== 0 && b.core === 0,
    home,
  };
}

/** The head leads and the tail follows; chains go one after another when they split, merge or go home. */
export function delayOf(rc: Recipe, slot: number, i: number): number {
  const chainGap = rc.split || rc.merge || rc.home ? 0.16 : 0.06;
  return i * 0.035 + slot * chainGap;
}

/** The longest delay there is: the last dot of the third chain. */
export const MAX_DELAY = (DOTS - 1) * 0.035 + (SLOTS - 1) * 0.16;

/** A dot a share `w` of the way from `a` to `b`: on an arc around the centre, not a straight line. */
export function mixDot(a: Dot, b: Dot, w: number): Dot {
  const ra = Math.hypot(a.x - CENTER, a.y - CENTER);
  const rb = Math.hypot(b.x - CENTER, b.y - CENTER);
  const aa = Math.atan2(a.y - CENTER, a.x - CENTER);
  const ab = Math.atan2(b.y - CENTER, b.x - CENTER);
  // The short way round.
  const turn = ((((ab - aa + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
  const angle = aa + turn * w;
  const radius = lerp(ra, rb, w) * (1 - 0.12 * Math.sin(Math.PI * w));
  // A chain that appears fades in early; one that goes away fades out late.
  let wo = w;
  if (a.o === 0 && b.o > 0) wo = easeOut(clamp(w * 1.6));
  if (b.o === 0 && a.o > 0) wo = Math.pow(w, 3);
  return {
    x: CENTER + radius * Math.cos(angle),
    y: CENTER + radius * Math.sin(angle),
    r: lerp(a.r, b.r, w),
    o: lerp(a.o, b.o, wo),
    z: lerp(a.z, b.z, w),
  };
}
