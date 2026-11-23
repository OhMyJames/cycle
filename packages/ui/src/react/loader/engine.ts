// Ported whole from Cycle v2 (packages/ui/src/loader/engine.ts), by the owner's decision for CYCL-215; see index.ts.
import { at, clamp, type Dot, easeInOut, easeOut, lerp, sample } from "./sample.ts";
import {
  DOTS,
  type LoaderState,
  SCENE_NAMES,
  SCENES,
  type SceneName,
  SLOTS,
  STATES,
} from "./scenes.ts";
import { delayOf, MAX_DELAY, mixDot, type Recipe, recipe } from "./transition.ts";

/** Everything one picture of the loader is made of. */
export interface Frame {
  /** SLOTS × DOTS dots, chain after chain, head first. */
  dots: readonly Dot[];
  /** Radius of the core in the middle; 0 when there is none. */
  core: number;
  /** How visible each scene's guide lines are. */
  guides: Readonly<Record<SceneName, number>>;
  /** The bounce when the dots settle into their resting pose; 1 when there is none. */
  scale: number;
  /** The drawing order of the dots and the core (indexes into `dots`; the core is CORE_INDEX), farthest first. */
  order: readonly number[];
}

/** What the picture was when the state was changed, which the new state is mixed in from. */
interface Leaving {
  state: LoaderState;
  /** The picture on screen when this state was left in the middle of another change; otherwise the state's own scene is sampled live. */
  snapshot: readonly Dot[] | undefined;
  core: number;
  guides: Readonly<Record<SceneName, number>>;
}

/** How long the bounce after going home takes, in milliseconds. */
const SETTLE_MS = 600;
/** Where the core is in `Frame.order`: after the dots. */
export const CORE_INDEX = SLOTS * DOTS;
const NO_GUIDES: Readonly<Record<SceneName, number>> = {
  swim: 0,
  orbit: 0,
  figure8: 0,
  trefoil: 0,
  seam: 0,
};

/**
 * The loader's animation, without a screen: it knows nothing of the DOM or of frames. Tell it the state and ask it for
 * the picture at a time (milliseconds, from any clock that only goes forward); the same times give the same pictures.
 * A change of state while another is under way starts from the picture on screen, so nothing jumps.
 */
export class Engine {
  state: LoaderState;
  private reduced: boolean;
  private leaving: Leaving | undefined;
  private recipe: Recipe | undefined;
  private startedAt = 0;
  private settledAt = -1;
  private last: number;
  private clocks: Record<SceneName, number> = {
    swim: 0,
    orbit: 0,
    figure8: 0,
    trefoil: 0,
    seam: 0,
  };
  private shown: readonly Dot[] | undefined;
  private shownCore = 0;
  private shownGuides: Readonly<Record<SceneName, number>> = NO_GUIDES;

  constructor(state: LoaderState, now: number, reducedMotion: boolean) {
    this.state = state;
    this.last = now;
    this.reduced = reducedMotion;
  }

  /**
   * With reduced motion nothing moves (Cycle's DESIGN.md: everything stands still): each state is drawn in its resting
   * pose, and a change of state is a cut to the next one, with no morph and no bounce. v2 kept the scenes moving, as a
   * spinner; Cycle v1 does not, so the picture says which state it is and the words beside it say the work goes on.
   */
  setReducedMotion(reduced: boolean): void {
    this.reduced = reduced;
    if (reduced) {
      this.leaving = undefined;
      this.settledAt = -1;
    }
  }

  setState(next: LoaderState, now: number): void {
    if (next === this.state) return;
    // Start from what is on screen now, if it is a change in the middle: the old scene is not just where it was.
    const mid = this.leaving !== undefined && this.shown !== undefined;
    this.leaving = {
      state: this.state,
      snapshot: mid ? [...(this.shown ?? [])] : undefined,
      core: this.shownCore,
      guides: this.shownGuides,
    };
    this.recipe = recipe(this.state, next);
    this.state = next;
    this.startedAt = now;
    // Standing still, the change is a cut.
    if (this.reduced) this.leaving = undefined;
  }

  /** Nothing moves any more: the last picture asked for is the picture there will be until the state changes. */
  get idle(): boolean {
    return (
      this.leaving === undefined &&
      this.settledAt < 0 &&
      (this.reduced || STATES[this.state].freeze === true)
    );
  }

  private dotsOf(state: LoaderState): Dot[] {
    const look = STATES[state];
    const scene = SCENES[look.scene];
    const dots: Dot[] = [];
    for (let slot = 0; slot < SLOTS; slot++) {
      for (let i = 0; i < DOTS; i++)
        dots.push(
          sample(scene, this.clocks[look.scene], slot, i, this.reduced || look.freeze === true),
        );
    }
    return dots;
  }

  /** The picture at `now`. */
  step(now: number): Frame {
    const look = STATES[this.state];
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    for (const name of SCENE_NAMES) {
      let speed = 1;
      if (this.leaving !== undefined && STATES[this.leaving.state].scene === name)
        speed = STATES[this.leaving.state].speed;
      if (look.scene === name) speed = look.speed;
      this.clocks[name] += (dt * speed) / SCENES[name].dur;
    }

    let p = 1;
    if (this.leaving !== undefined && this.recipe !== undefined) {
      p = clamp((now - this.startedAt) / this.recipe.dur);
      if (p >= 1) {
        if (this.recipe.home && !this.reduced) this.settledAt = now;
        this.leaving = undefined;
      }
    }
    const rc = this.recipe;
    const from = p < 1 ? this.leaving : undefined;

    const target = this.dotsOf(this.state);
    const origin = from === undefined ? undefined : (from.snapshot ?? this.dotsOf(from.state));
    const dots = target.map((b, n) => {
      if (from === undefined || rc === undefined || origin === undefined) return b;
      const slot = Math.floor(n / DOTS);
      const w = easeInOut(clamp((p - delayOf(rc, slot, n % DOTS) * 0.9) / (1 - MAX_DELAY * 0.9)));
      return mixDot(at(origin, n), b, w);
    });
    this.shown = dots;

    // The core condenses after the rings form and dissolves before they leave.
    const coreTarget = SCENES[look.scene].core;
    let core = coreTarget;
    if (from !== undefined && rc !== undefined) {
      const w = rc.coreIn
        ? easeOut(clamp((p - 0.45) / 0.55))
        : rc.coreOut
          ? easeInOut(clamp(p / 0.4))
          : p;
      core = lerp(from.core, coreTarget, w);
    }
    if (coreTarget !== 0 && !this.reduced)
      core *= 1 + 0.05 * (1 - Math.cos(2 * Math.PI * this.clocks.orbit));
    this.shownCore = core;

    // The old scene's guide lines fade out fast, the new one's fade in late.
    const guides = { ...NO_GUIDES };
    for (const name of SCENE_NAMES) {
      const goal = look.scene === name ? SCENES[name].guideOp : 0;
      let v = goal;
      if (from !== undefined) {
        const before = from.guides[name];
        v =
          goal > before
            ? lerp(before, goal, clamp((p - 0.5) / 0.5))
            : lerp(before, goal, clamp(p / 0.4));
      }
      guides[name] = v;
    }
    this.shownGuides = guides;

    let scale = 1;
    if (this.settledAt >= 0) {
      const q = (now - this.settledAt) / SETTLE_MS;
      if (q < 1) scale = 1 + 0.06 * Math.sin(Math.PI * q);
      else this.settledAt = -1;
    }
    return { dots, core: Math.max(0, core), guides, scale, order: drawingOrder(dots) };
  }
}

/** Far first, and a head above its own tail; the core, when it is there, under everything of the same depth. */
function drawingOrder(dots: readonly Dot[]): number[] {
  const keys = dots.map((dot, n) => dot.z + (DOTS - (n % DOTS)) * 0.001);
  keys.push(0.0005);
  return keys
    .map((key, n) => ({ key, n }))
    .toSorted((a, b) => a.key - b.key)
    .map(({ n }) => n);
}
