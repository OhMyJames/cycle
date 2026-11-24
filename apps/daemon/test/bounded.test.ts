import { expect, test } from "bun:test";
import { mapBounded } from "../src/bounded.ts";

test("maps in order, never more than the limit at once", async () => {
  let running = 0;
  let most = 0;
  const out = await mapBounded([5, 1, 4, 2, 3], 2, async (n, i) => {
    running++;
    most = Math.max(most, running);
    await Bun.sleep(n);
    running--;
    return `${i}:${n}`;
  });
  expect(out).toEqual(["0:5", "1:1", "2:4", "3:2", "4:3"]);
  expect(most).toBe(2);
});

test("the first failure is the call's", async () => {
  await expect(
    mapBounded([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("two");
      return n;
    }),
  ).rejects.toThrow("two");
});

test("nothing to map is nothing", async () => {
  expect(await mapBounded([], 4, async () => 1)).toEqual([]);
});
