import { SCENE_DATA } from "./scene-data";

// The loader's data: what each state looks like. Ported from shrimpdot-durable's packages/ui/src/loader, which ported
// it from the brand group's shrimpdot-loader.js; the scenes themselves are in scene-data.ts, unchanged.

export type SceneName = "swim" | "orbit" | "figure8" | "trefoil" | "seam";
export type LoaderState =
  | "waiting"
  | "thinking"
  | "searching"
  | "executing"
  | "responding"
  | "done";

/** A point of a track: x, y, a factor for the radius, a factor for the opacity, and depth (higher is nearer). */
export type Knot = readonly [x: number, y: number, r: number, o: number, z: number];

export interface Scene {
  /** Seconds for one loop at speed 1. */
  readonly dur: number;
  /** Radius of the head, in the 100 × 100 box; the other dots are smaller by RK. */
  readonly headR: number;
  /** How far each dot trails the head along its track, as a share of a loop: one for each of the DOTS. */
  readonly lags: readonly [number, number, number, number, number, number];
  readonly tracks: readonly (readonly Knot[])[];
  /** One chain of dots per entry, one to three: the track it follows and where on it it starts (a share of a loop). */
  readonly chains: readonly (readonly [track: number, phase: number])[];
  /** Radius of the core in the middle; 0 when there is none. */
  readonly core: number;
  /** Faint lines the dots travel along, as SVG path data. */
  readonly guides: readonly string[];
  readonly guideOp: number;
}

export const SCENE_NAMES: readonly SceneName[] = ["swim", "orbit", "figure8", "trefoil", "seam"];

/** How the dots shrink and fade from the head to the tail. */
export const RK: readonly number[] = [1, 0.744, 0.634, 0.537, 0.457, 0.39];
export const OPK: readonly number[] = [1, 0.9, 0.8, 0.7, 0.6, 0.5];
/** Chains at most (the scenes have one to three), dots in each, and the middle of the 100 × 100 box. */
export const SLOTS = 3;
export const DOTS = 6;
export const CENTER = 50;

export interface StateLook {
  readonly scene: SceneName;
  /** How fast the scene's clock runs in this state. */
  readonly speed: number;
  /** The scene stands still at its resting pose. */
  readonly freeze?: true;
}

export const STATES: Readonly<Record<LoaderState, StateLook>> = {
  waiting: { scene: "swim", speed: 0.6 },
  thinking: { scene: "figure8", speed: 1 },
  searching: { scene: "seam", speed: 1 },
  executing: { scene: "orbit", speed: 1 },
  responding: { scene: "trefoil", speed: 1 },
  done: { scene: "swim", speed: 0, freeze: true },
};

export const SCENES: Readonly<Record<SceneName, Scene>> = SCENE_DATA;
