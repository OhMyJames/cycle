/*
 * Fades instead of ellipses and rules (.agents/designs/design-system.md, "Fades").
 *
 * `fade-x` clips a line and fades its end, and `fade-x-start` keeps the end of a path in view and
 * fades its start. Either fades only while its text overflows, which CSS cannot tell, so this marks
 * each one with `data-overflowing`. `fade-y` fades a scroll container's edges by
 * the distance actually hidden there, at most 24px, through `--fade-top` and `--fade-bottom`.
 *
 * One watcher covers the page, so components only add a class. Work is batched to one frame, and a
 * mutation rechecks only the faded line and the scroller it falls in, so streamed text costs one
 * scroller's measure a frame.
 */

const FADE = 24;
const LINES = ".fade-x, .fade-x-start";
const SCROLLERS = ".fade-y";

function measureLine(line: HTMLElement): void {
  const overflowing = line.scrollWidth > line.clientWidth + 0.5;
  line.toggleAttribute("data-overflowing", overflowing);
  // An overflowing path shows its end, which holds the file or folder name.
  if (line.classList.contains("fade-x-start")) line.scrollLeft = overflowing ? line.scrollWidth : 0;
}

function measureScroller(scroller: HTMLElement): void {
  const top = Math.min(FADE, Math.max(0, scroller.scrollTop));
  const bottom = Math.min(
    FADE,
    Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop),
  );
  scroller.style.setProperty("--fade-top", `${top}px`);
  scroller.style.setProperty("--fade-bottom", `${bottom}px`);
}

/** Watches every fade under `root` until the returned function is called. */
export function watchFades(root: HTMLElement): () => void {
  const lines = new Set<HTMLElement>();
  const scrollers = new Set<HTMLElement>();
  let everything = false;
  let frame = 0;

  const flush = () => {
    frame = 0;
    if (everything) {
      for (const line of root.querySelectorAll<HTMLElement>(LINES)) lines.add(line);
      for (const scroller of root.querySelectorAll<HTMLElement>(SCROLLERS)) scrollers.add(scroller);
      everything = false;
    }
    for (const line of lines) if (line.isConnected) measureLine(line);
    lines.clear();
    for (const scroller of scrollers) if (scroller.isConnected) measureScroller(scroller);
    scrollers.clear();
  };
  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(flush);
  };

  const resized = new ResizeObserver((entries) => {
    for (const { target } of entries) {
      if (!(target instanceof HTMLElement)) continue;
      if (target.matches(LINES)) lines.add(target);
      if (target.matches(SCROLLERS)) scrollers.add(target);
    }
    schedule();
  });

  const adopt = (node: Node) => {
    if (!(node instanceof HTMLElement)) return;
    const found = [
      ...(node.matches(`${LINES}, ${SCROLLERS}`) ? [node] : []),
      ...node.querySelectorAll<HTMLElement>(`${LINES}, ${SCROLLERS}`),
    ];
    for (const element of found) {
      resized.observe(element);
      if (element.matches(LINES)) lines.add(element);
    }
  };

  // Unobserved, a removed element would stay referenced for the life of the page.
  const release = (node: Node) => {
    if (!(node instanceof HTMLElement)) return;
    if (node.matches(`${LINES}, ${SCROLLERS}`)) resized.unobserve(node);
    for (const element of node.querySelectorAll(`${LINES}, ${SCROLLERS}`)) {
      resized.unobserve(element);
    }
  };

  const mutated = new MutationObserver((records) => {
    for (const record of records) {
      record.removedNodes.forEach(release);
      record.addedNodes.forEach(adopt);
      const element =
        record.target instanceof HTMLElement ? record.target : record.target.parentElement;
      const line = element?.closest<HTMLElement>(LINES);
      if (line) lines.add(line);
      // Content that grows changes what its scroller hides without resizing it.
      const scroller = element?.closest<HTMLElement>(SCROLLERS);
      if (scroller) scrollers.add(scroller);
      // A class change can turn an element into a fade, or out of one.
      if (record.type === "attributes" && element) adopt(element);
    }
    schedule();
  });

  // A web font that finishes loading changes how wide every line is, with no resize or mutation.
  const fontsLoaded = () => {
    everything = true;
    schedule();
  };

  const scrolled = (event: Event) => {
    if (event.target instanceof HTMLElement && event.target.matches(SCROLLERS)) {
      scrollers.add(event.target);
      schedule();
    }
  };

  adopt(root);
  everything = true;
  schedule();
  document.fonts.addEventListener("loadingdone", fontsLoaded);
  void document.fonts.ready.then(fontsLoaded);
  mutated.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  root.addEventListener("scroll", scrolled, { capture: true, passive: true });

  return () => {
    cancelAnimationFrame(frame);
    resized.disconnect();
    mutated.disconnect();
    root.removeEventListener("scroll", scrolled, { capture: true });
    document.fonts.removeEventListener("loadingdone", fontsLoaded);
  };
}
