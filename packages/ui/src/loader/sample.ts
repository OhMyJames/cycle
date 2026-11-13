import { OPK, RK, type Scene } from "./scenes";

/** One dot as drawn: where, how big, how opaque, and how near (z, for the drawing order). */
export interface Dot {
  x: number;
  y: number;
  r: number;
  o: number;
  z: number;
}

export const clamp = (x: number, low = 0, high = 1): number => Math.min(high, Math.max(low, x));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const easeOut = (t: number): number => 1 - Math.pow(1 - t, 3);

/** `list[index]`, or an error: the data has been checked, so a miss is a bug here, not something to draw around. */
export function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new RangeError(`no item ${index} in a list of ${list.length}`);
  return value;
}

/**
 * Dot `i` (0 is the head) of chain `slot` in a scene at `clock` (loops so far; the fraction is the place in the loop).
 * A slot the scene has no chain for follows the first one, invisible and a little smaller, so that a chain that
 * splits off has somewhere to start from. `freeze` holds the scene at its resting pose: loop position 0, no breathing.
 */
export function sample(scene: Scene, clock: number, slot: number, i: number, freeze: boolean): Dot {
  const hidden = slot >= scene.chains.length;
  const [trackIndex, phase] = at(scene.chains, hidden ? 0 : slot);
  const track = at(scene.tracks, trackIndex);
  const n = track.length;
  const u = ((((freeze ? 0 : clock) + phase - at(scene.lags, i)) % 1) + 1) % 1;
  const place = u * n;
  const j = Math.floor(place) % n;
  const a = place - Math.floor(place);
  const p = at(track, j);
  const q = at(track, (j + 1) % n);
  let r = scene.headR * at(RK, i) * lerp(p[2], q[2], a);
  if (i === 0 && !freeze) r *= 1 + 0.04 * (1 - Math.cos(4 * Math.PI * clock)); // the head breathes
  return {
    x: lerp(p[0], q[0], a),
    y: lerp(p[1], q[1], a),
    r: hidden ? r * 0.55 : r,
    o: hidden ? 0 : at(OPK, i) * lerp(p[3], q[3], a),
    z: lerp(p[4], q[4], a),
  };
}
