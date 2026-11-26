import { expect, test } from "bun:test";
import type { ProjectUnit } from "../src/assemble.ts";
import type { ConfigFile } from "../src/config-file.ts";
import { checkCovered, PipelineConfigError, startPipelines } from "../src/runtime.ts";

const file = (key: string) => ({ projectKey: key }) as ConfigFile;

const unit = (name: string, steps: string[], closed: string[]): ProjectUnit => ({
  name,
  pipeline: {
    step: async () => {
      steps.push(name);
      return { status: "idle" };
    },
    intervalSeconds: 0.001,
  } as unknown as ProjectUnit["pipeline"],
  release: async () => {},
  close: async () => {
    closed.push(name);
  },
  workers: 1,
});

test("a Project missing a pipeline config stops startup with the reason", () => {
  expect(() => checkCovered(["A", "B"], [file("A")])).toThrow(PipelineConfigError);
  expect(() => checkCovered(["A", "B"], [file("A")])).toThrow("B");
  expect(() => checkCovered(["A"], [file("A")])).not.toThrow();
});

test("every Project is set up before any step runs; a bad one closes the rest", async () => {
  const steps: string[] = [];
  const closed: string[] = [];
  await expect(
    startPipelines(
      [file("A"), file("B")],
      async (f) => {
        if (f.projectKey === "B") throw new Error("B: bad column");
        await Bun.sleep(5);
        return unit("A", steps, closed);
      },
      () => {},
    ),
  ).rejects.toThrow("B: bad column");
  expect(closed).toEqual(["A"]);
  expect(steps).toEqual([]);
});

test("each Project runs with no client connected, and stop closes them all", {
  timeout: 5000,
}, async () => {
  const steps: string[] = [];
  const closed: string[] = [];
  const running = await startPipelines(
    [file("A"), file("B")],
    async (f) => unit(f.projectKey, steps, closed),
    () => {},
  );
  while (!(steps.includes("A") && steps.includes("B"))) await Bun.sleep(2);
  running.stop();
  await running.done;
  expect(closed.sort()).toEqual(["A", "B"]);
});
