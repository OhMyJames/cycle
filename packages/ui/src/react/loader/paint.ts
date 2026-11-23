// Ported whole from Cycle v2 (packages/ui/src/loader/paint.ts), by the owner's decision for CYCL-215; see index.ts.
import { CORE_INDEX, type Frame } from "./engine.ts";
import { at } from "./sample.ts";
import { CENTER, DOTS, OPK, SCENE_NAMES, SCENES, type SceneName, SLOTS } from "./scenes.ts";

const NS = "http://www.w3.org/2000/svg";

/** What a picture of the loader is drawn on: the circles and guide lines inside one <svg>. */
export interface Canvas {
  root: SVGGElement;
  layer: SVGGElement;
  /** The dots, then the core (CORE_INDEX). */
  circles: SVGCircleElement[];
  guides: Record<SceneName, SVGGElement>;
  /** The order the circles are in now, so that the nodes are only moved when it changes. */
  order: string;
}

const make = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] =>
  document.createElementNS(NS, tag);

/**
 * Builds the loader in `svg` (which has the 100 × 100 viewBox and its color from the page; the dots and the guide lines
 * take that color) and nothing else: it has no timer and no state of its own.
 */
export function mount(svg: SVGSVGElement): Canvas {
  const root = make("g");
  const guideLayer = make("g");
  guideLayer.setAttribute("fill", "none");
  guideLayer.setAttribute("stroke", "currentColor");
  guideLayer.setAttribute("stroke-width", "0.4");
  const layer = make("g");
  root.append(guideLayer, layer);
  svg.append(root);

  const guideOf = (name: SceneName): SVGGElement => {
    const g = make("g");
    g.setAttribute("opacity", "0");
    for (const d of SCENES[name].guides) {
      const path = make("path");
      path.setAttribute("d", d);
      g.append(path);
    }
    guideLayer.append(g);
    return g;
  };
  const guides: Record<SceneName, SVGGElement> = {
    swim: guideOf("swim"),
    orbit: guideOf("orbit"),
    figure8: guideOf("figure8"),
    trefoil: guideOf("trefoil"),
    seam: guideOf("seam"),
  };
  const circles: SVGCircleElement[] = [];
  for (let n = 0; n < SLOTS * DOTS; n++) {
    const circle = make("circle");
    circle.setAttribute("fill", "currentColor");
    // As the brand's loader has it: the dot's own opacity steps are in its fill, and the frame brings the rest.
    circle.setAttribute("fill-opacity", String(at(OPK, n % DOTS)));
    circle.dataset.dot = String(n % DOTS);
    circles.push(circle);
    layer.append(circle);
  }
  const core = make("circle");
  core.setAttribute("fill", "currentColor");
  core.setAttribute("cx", String(CENTER));
  core.setAttribute("cy", String(CENTER));
  circles.push(core);
  layer.append(core);
  return { root, layer, circles, guides, order: "" };
}

/** Takes the loader out of `svg` again. */
export function unmount(svg: SVGSVGElement): void {
  svg.replaceChildren();
}

/** Draws a frame: writes what changed in it into the circles, and moves them when the drawing order changed. */
export function paint(canvas: Canvas, frame: Frame): void {
  frame.dots.forEach((dot, n) => {
    const circle = at(canvas.circles, n);
    circle.setAttribute("cx", dot.x.toFixed(2));
    circle.setAttribute("cy", dot.y.toFixed(2));
    circle.setAttribute("r", Math.max(0, dot.r).toFixed(2));
    circle.setAttribute("opacity", dot.o.toFixed(3));
  });
  at(canvas.circles, CORE_INDEX).setAttribute("r", frame.core.toFixed(2));
  for (const name of SCENE_NAMES)
    canvas.guides[name].setAttribute("opacity", frame.guides[name].toFixed(3));
  canvas.root.setAttribute(
    "transform",
    frame.scale === 1
      ? ""
      : `translate(${CENTER} ${CENTER}) scale(${frame.scale}) translate(${-CENTER} ${-CENTER})`,
  );
  const order = frame.order.join(",");
  if (order !== canvas.order) {
    canvas.order = order;
    for (const n of frame.order) canvas.layer.append(at(canvas.circles, n));
  }
}
