import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface Tip {
  text: string;
  x: number;
  y: number;
  below: boolean;
}

/** How long the pointer rests on a control before its tip shows; none once one is showing. */
const REST_MS = 500;

/**
 * Cycle's own tips, for every control that carries a `title`: the platform's is slow, unstyled and
 * leaves the page's look. One listener takes a control's title while the pointer or the keyboard's
 * focus is on it, and gives it back after.
 */
export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const held = useRef<{ node: Element; title: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const warm = useRef(0);
  useEffect(() => {
    const release = () => {
      clearTimeout(timer.current);
      const old = held.current;
      if (!old) return;
      held.current = null;
      if (old.node.isConnected && !old.node.hasAttribute("title")) {
        old.node.setAttribute("title", old.title);
      }
      warm.current = performance.now();
      setTip(null);
    };
    const hold = (target: EventTarget | null, wait: number) => {
      const node = target instanceof Element ? target.closest("[title]") : null;
      if (held.current && node === null && target instanceof Node) {
        if (held.current.node.contains(target)) return;
      }
      release();
      const title = node?.getAttribute("title");
      if (!node || !title) return;
      held.current = { node, title };
      node.removeAttribute("title");
      const show = () => {
        if (held.current?.node !== node || !node.isConnected) return;
        const box = node.getBoundingClientRect();
        const below = box.top < 48;
        setTip({
          text: title,
          x: Math.min(Math.max(box.left + box.width / 2, 12), window.innerWidth - 12),
          y: below ? box.bottom + 6 : box.top - 6,
          below,
        });
      };
      const soon = performance.now() - warm.current < 300;
      timer.current = setTimeout(show, soon ? 0 : wait);
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      hold(event.target, REST_MS);
    };
    const focus = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Element && target.matches(":focus-visible")) hold(target, REST_MS);
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerdown", release, true);
    document.addEventListener("keydown", release, true);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", release);
    document.addEventListener("scroll", release, true);
    window.addEventListener("blur", release);
    return () => {
      release();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerdown", release, true);
      document.removeEventListener("keydown", release, true);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", release);
      document.removeEventListener("scroll", release, true);
      window.removeEventListener("blur", release);
    };
  }, []);
  // Kept inside the window: a tip for a control at an edge moves in rather than being cut.
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = box.current;
    if (!node || !tip) return;
    const half = node.offsetWidth / 2 + 6;
    const x = Math.min(Math.max(tip.x, half), window.innerWidth - half);
    node.style.left = `${x}px`;
  }, [tip]);
  if (!tip) return null;
  return (
    <div
      ref={box}
      className="tooltip"
      role="tooltip"
      data-below={tip.below}
      style={{ left: tip.x, top: tip.y }}
    >
      {tip.text}
    </div>
  );
}
