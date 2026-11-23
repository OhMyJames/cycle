import { act, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MIN_SHOWN_MS, SWITCH_DELAY_MS, useSteady } from "../../src/react/steady.ts";

afterEach(() => vi.useRealTimers());

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

function Shown({ value, id }: { value: string; id: string }) {
  return <p>{useSteady(value, id, (key) => key === "now")[0]}</p>;
}

test("a new step waits until the one shown has been up a while; a step over at once is never shown", async () => {
  vi.useFakeTimers();
  const { container, rerender } = render(<Shown value="Reading a.ts" id="a" />);
  const text = () => container.textContent;
  // The same step, said anew: at once.
  rerender(<Shown value="Reading a.ts, line 4" id="a" />);
  expect(text()).toBe("Reading a.ts, line 4");
  // A quick call comes and goes: the first stays.
  rerender(<Shown value="Searching" id="b" />);
  await advance(SWITCH_DELAY_MS);
  expect(text()).toBe("Reading a.ts, line 4");
  rerender(<Shown value="Running tests" id="c" />);
  await advance(MIN_SHOWN_MS - SWITCH_DELAY_MS - 10);
  expect(text()).toBe("Reading a.ts, line 4");
  await advance(20);
  expect(text()).toBe("Running tests");
  // Up long enough: the next waits only the switch delay.
  await advance(MIN_SHOWN_MS);
  rerender(<Shown value="Editing" id="d" />);
  await advance(SWITCH_DELAY_MS - 10);
  expect(text()).toBe("Running tests");
  await advance(20);
  expect(text()).toBe("Editing");
});

test("an urgent step is shown at once, and the one after it does not wait on it", async () => {
  vi.useFakeTimers();
  const { container, rerender } = render(<Shown value="Reading" id="a" />);
  rerender(<Shown value="Waiting for your answer" id="now" />);
  expect(container.textContent).toBe("Waiting for your answer");
  rerender(<Shown value="Running" id="b" />);
  expect(container.textContent).toBe("Running");
});
