import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFiles, parseConfigFiles } from "../src/config-file.ts";
import {
  effectiveWorkers,
  type LoopSpec,
  parseWorkers,
  runLoops,
  workerSpecs,
} from "../src/loop.ts";

const p = (key: string, stateDir: string) => ({
  repoRoot: "/r",
  projectKey: key,
  stateDir,
  planKey: "k",
});

test("a Project stuck in a step does not hold up the other", { timeout: 5000 }, async () => {
  let stop = false;
  let b = 0;
  const logs: string[] = [];
  const base = { once: false, intervalMs: 1, log: (l: string) => logs.push(l) };
  const never = new Promise<{ status: string }>(() => {});
  const specs: LoopSpec[] = [
    { ...base, name: "A", step: () => never, stopped: () => stop },
    {
      ...base,
      name: "B",
      step: async () => {
        b += 1;
        if (b === 2) throw new Error("boom");
        if (b >= 4) stop = true;
        return { status: "idle" };
      },
      stopped: () => stop,
    },
  ];
  // A never returns, so only B can finish; race against it by not awaiting A.
  const done = runLoops(specs.slice(1));
  void runLoops(specs.slice(0, 1));
  await done;
  expect(b).toBe(4);
  expect(logs.some((l) => l.includes("[B] step failed: boom"))).toBe(true);
});

test("with once, every loop runs and the first error is raised", async () => {
  let ran = 0;
  const base = { once: true, intervalMs: 1, log: () => {}, stopped: () => false };
  const specs: LoopSpec[] = [
    {
      ...base,
      name: "A",
      step: async () => {
        throw new Error("bad");
      },
    },
    {
      ...base,
      name: "B",
      step: async () => {
        ran += 1;
        return { status: "idle" };
      },
    },
  ];
  await expect(runLoops(specs)).rejects.toThrow("bad");
  expect(ran).toBe(1);
});

test("a list of Projects is parsed; a single-Project file is a list of one", () => {
  const two = parseConfigFiles(JSON.stringify({ projects: [p("A", "/sa"), p("B", "/sb")] }));
  expect(two.map((x) => x.projectKey)).toEqual(["A", "B"]);
  expect(parseConfigFiles(JSON.stringify(p("A", "/sa")))).toHaveLength(1);
  expect(() => parseConfigFiles(JSON.stringify({ projects: [] }))).toThrow("non-empty");
});

test("two Projects with the same stateDir fail at start", async () => {
  const raw = JSON.stringify({ projects: [p("A", "/same"), p("B", "/same/")] });
  expect(() => parseConfigFiles(raw)).toThrow("share stateDir");
  const dir = await mkdtemp(join(tmpdir(), "al-multi-"));
  const path = join(dir, "c.json");
  await writeFile(path, raw, { mode: 0o600 });
  await expect(loadConfigFiles(path)).rejects.toThrow("share stateDir");
});

test("a bad Project is named by its position", () => {
  const { planKey: _, ...bad } = p("B", "/sb");
  expect(() => parseConfigFiles(JSON.stringify({ projects: [p("A", "/sa"), bad] }))).toThrow(
    "projects[1]: missing required planKey",
  );
});

test("parseWorkers: absent is 1, only positive integers pass", () => {
  expect(parseWorkers(undefined)).toBe(1);
  expect(parseWorkers("3")).toBe(3);
  for (const bad of ["0", "-1", "1.5", "abc", ""]) expect(() => parseWorkers(bad)).toThrow();
});

test("effective workers: once and dry-run give 1, then flag over file over 1", () => {
  const o = { once: false, dryRun: false, flag: undefined, file: undefined };
  expect(effectiveWorkers({ ...o, once: true, flag: 3, file: 3 })).toBe(1);
  expect(effectiveWorkers({ ...o, dryRun: true, flag: 3 })).toBe(1);
  expect(effectiveWorkers({ ...o, flag: 2, file: 5 })).toBe(2);
  expect(effectiveWorkers({ ...o, file: 5 })).toBe(5);
  expect(effectiveWorkers(o)).toBe(1);
});

test("workerSpecs: names carry #1, #2 only when there is more than one", () => {
  const base = {
    step: async () => ({ status: "idle" }),
    once: false,
    intervalMs: 1,
    log: () => {},
    stopped: () => false,
  };
  expect(workerSpecs(base, "CYC", 2).map((s) => s.name)).toEqual(["CYC#1", "CYC#2"]);
  expect(workerSpecs(base, "CYC", 1).map((s) => s.name)).toEqual(["CYC"]);
});

test("two workers: one stuck in step, the other goes on; each leaves after its current step", {
  timeout: 5000,
}, async () => {
  let stop = false;
  let release: (v: { status: string }) => void = () => {};
  let fast = 0;
  let calls = 0;
  const logs: string[] = [];
  const specs = workerSpecs(
    {
      step: () => {
        calls += 1;
        if (calls === 1)
          return new Promise<{ status: string }>((r) => {
            release = r;
          });
        fast += 1;
        if (fast === 3) stop = true;
        return Promise.resolve({ status: "idle" });
      },
      once: false,
      intervalMs: 1,
      log: (l) => logs.push(l),
      stopped: () => stop,
    },
    "P",
    2,
  );
  const all = runLoops(specs);
  while (!stop) await Bun.sleep(1);
  expect(fast).toBe(3);
  let finished = false;
  void all.then(() => {
    finished = true;
  });
  await Bun.sleep(20);
  expect(finished).toBe(false);
  release({ status: "idle" });
  await all;
  expect(calls).toBe(4);
  expect(logs.some((l) => l.startsWith("[P#1]"))).toBe(true);
  expect(logs.some((l) => l.startsWith("[P#2]"))).toBe(true);
});
