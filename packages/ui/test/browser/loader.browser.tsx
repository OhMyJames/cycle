import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { cdp } from "vitest/browser";
import { createTranslator, SOURCE_LOCALE } from "../../src/i18n.ts";
import { enUS } from "../../src/messages/en-US.ts";
import { I18nProvider } from "../../src/react/i18n.tsx";
import { InlineAiStatus } from "../../src/react/inline-ai-status.tsx";
import { HOLD_MS, MorphLoader } from "../../src/react/loader/index.ts";

/** Asks the browser itself for less motion, as the system setting would: the stylesheet and the loader both hear it. */
const reduceMotion = (on: boolean) =>
  cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "no-preference" }],
  });

afterEach(async () => {
  cleanup();
  await reduceMotion(false);
});

const svgOf = (container: HTMLElement) =>
  container.querySelector<SVGSVGElement>('[data-slot="morph-loader"] svg');
/** Where the dots are now. */
const picture = (container: HTMLElement) =>
  [...(svgOf(container)?.querySelectorAll("circle") ?? [])]
    .map((circle) => `${circle.getAttribute("cx")},${circle.getAttribute("cy")}`)
    .join(" ");
const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("moves while it is seen, at 24px over a 16px box, decoration only", async () => {
  const { container } = render(<MorphLoader state="thinking" />);
  const box = container.querySelector<HTMLElement>('[data-slot="morph-loader"]');
  expect(box?.getAttribute("aria-hidden")).toBe("true");
  expect(box?.getBoundingClientRect().width).toBe(16);
  expect(svgOf(container)?.getBoundingClientRect().width).toBe(24);
  expect(svgOf(container)?.dataset.animating).toBe("true");
  const first = picture(container);
  await later(100);
  expect(picture(container)).not.toBe(first);
});

test("asks for no frames where it cannot be seen, and none once it is gone", async () => {
  const { container, rerender, unmount } = render(
    <div>
      <MorphLoader state="thinking" />
    </div>,
  );
  await waitFor(() => expect(svgOf(container)?.dataset.animating).toBe("true"));
  rerender(
    <div style={{ display: "none" }}>
      <MorphLoader state="thinking" />
    </div>,
  );
  await waitFor(() => expect(svgOf(container)?.dataset.animating).toBe("false"));
  const svg = svgOf(container);
  unmount();
  expect(svg?.childElementCount).toBe(0);
});

test("with reduced motion it stands still, and a new state is a still picture of its own", async () => {
  await reduceMotion(true);
  const { container, rerender } = render(<MorphLoader state="thinking" />);
  expect(svgOf(container)?.dataset.animating).toBe("false");
  const still = picture(container);
  await later(150);
  expect(picture(container)).toBe(still);
  rerender(<MorphLoader state="responding" />);
  // Held a moment first, as a working state is.
  await waitFor(
    () =>
      expect(
        container.querySelector('[data-slot="morph-loader"]')?.getAttribute("data-state"),
      ).toBe("responding"),
    { timeout: HOLD_MS + 500 },
  );
  await waitFor(() => expect(picture(container)).not.toBe(still));
  expect(svgOf(container)?.dataset.animating).toBe("false");
});

test("with reduced motion the step line's words do not fade in either", async () => {
  await reduceMotion(true);
  const { container } = render(
    <I18nProvider translator={createTranslator(SOURCE_LOCALE, enUS)}>
      <InlineAiStatus kind="thinking" label="Thinking…" since={Date.now()} />
    </I18nProvider>,
  );
  const label = container.querySelector('[data-slot="step-label"]') as Element;
  expect(getComputedStyle(label).animationName).toBe("none");
  await reduceMotion(false);
  await waitFor(() => expect(getComputedStyle(label).animationName).toBe("cycle-step-in"));
});
