import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectUnit } from "../src/assemble.ts";
import type { ConfigFile } from "../src/config-file.ts";
import { Pipeline } from "../src/pipeline.ts";
import {
  checkCovered,
  PipelineConfigError,
  startPipelines,
  startServer,
  startupReason,
} from "../src/runtime.ts";
import { RunStore } from "../src/store.ts";
import {
  config,
  done,
  FakeSessions,
  FakeTracker,
  issue,
  makeExec,
  PASS,
  REVIEW_MERGE,
  readyDescription,
  type World,
} from "./helpers.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "loop-rt-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = (key: string) => ({ projectKey: key }) as ConfigFile;

const counting = (name: string, steps: string[], closed: string[] = []): ProjectUnit => ({
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

/** Writes loop.json (Projects) and auto-loop.json (pipelines) for these keys. */
const writeConfigs = async (loopKeys: string[], pipelineKeys: string[]) => {
  const loop = join(dir, "loop.json");
  await writeFile(
    loop,
    JSON.stringify({
      projects: loopKeys.map((k) => ({
        name: k,
        projectKey: k,
        repo: { url: "https://github.com/o/r.git", forge: "github" },
        token: "tok",
      })),
    }),
  );
  await chmod(loop, 0o600);
  const pipelines = join(dir, "auto-loop.json");
  await writeFile(
    pipelines,
    JSON.stringify({
      projects: pipelineKeys.map((k) => ({
        repoRoot: "/r",
        projectKey: k,
        stateDir: join(dir, `state-${k}`),
        planKey: "k",
      })),
    }),
  );
  await chmod(pipelines, 0o600);
  return pipelines;
};

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const waitFor = async (what: () => boolean | Promise<boolean>) => {
  while (!(await what())) await Bun.sleep(2);
};

const listProjects = (socketPath: string): Promise<unknown> =>
  new Promise((resolve) => {
    const socket = connect(socketPath);
    socket.once("data", (data) => {
      resolve(JSON.parse(data.toString()).result);
      // Not a clean end: the client just goes away.
      socket.destroy();
    });
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "projects/list" })}\n`);
  });

test("a Project in loop.json without a pipeline entry stops startup with the reason and opens no socket", async () => {
  const pipelines = await writeConfigs(["A", "B"], ["A"]);
  const setUp = async () => counting("x", []);
  const error = await startServer({ dataDir: dir, pipelinesPath: pipelines, setUp, log: () => {} })
    .then(() => undefined)
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(PipelineConfigError);
  expect(startupReason(error)).toBe("no pipeline config for Project B");
  expect(await exists(join(dir, "loop.sock"))).toBe(false);
});

test("a loose loop.json or a missing one is named by its fixed word", async () => {
  const pipelines = await writeConfigs(["A"], ["A"]);
  await chmod(join(dir, "loop.json"), 0o644);
  const setUp = async () => counting("x", []);
  const reason = (p: string) =>
    startServer({ dataDir: dir, pipelinesPath: p, setUp, log: () => {} }).then(
      () => "started",
      startupReason,
    );
  expect(await reason(pipelines)).toBe("config_mode");
  await rm(join(dir, "loop.json"));
  expect(await reason(pipelines)).toBe("config_missing");
});

test("a Project that cannot be set up fails startup, closes the others, and never opens the socket", async () => {
  const pipelines = await writeConfigs(["A", "B"], ["A", "B"]);
  const steps: string[] = [];
  const closed: string[] = [];
  const error = await startServer({
    dataDir: dir,
    pipelinesPath: pipelines,
    log: () => {},
    setUp: async (f) => {
      if (f.projectKey === "B") throw new Error("B: no such column");
      return counting("A", steps, closed);
    },
  }).catch((e: unknown) => e);
  expect(startupReason(error)).toBe("B: no such column");
  expect(closed).toEqual(["A"]);
  expect(steps).toEqual([]);
  expect(await exists(join(dir, "loop.sock"))).toBe(false);
});

test("the socket opens only after every Project is set up", async () => {
  const pipelines = await writeConfigs(["A", "B"], ["A", "B"]);
  const seen: boolean[] = [];
  const running = await startServer({
    dataDir: dir,
    pipelinesPath: pipelines,
    log: () => {},
    setUp: async (f) => {
      seen.push(await exists(join(dir, "loop.sock")));
      return counting(f.projectKey, []);
    },
  });
  expect(seen).toEqual([false, false]);
  expect(await exists(join(dir, "loop.sock"))).toBe(true);
  running.stop();
  await running.done;
});

test("steps run with no client ever connected, and keep running through a client that connects and drops", {
  timeout: 5000,
}, async () => {
  const pipelines = await writeConfigs(["A", "B"], ["A", "B"]);
  const steps: string[] = [];
  const running = await startServer({
    dataDir: dir,
    pipelinesPath: pipelines,
    log: () => {},
    setUp: async (f) => counting(f.projectKey, steps),
  });
  const count = (name: string) => steps.filter((s) => s === name).length;
  // No client yet.
  await waitFor(() => count("A") >= 3 && count("B") >= 3);
  // A client lists the Projects and vanishes without ending the stream.
  const result = (await listProjects(join(dir, "loop.sock"))) as { projects: unknown[] };
  expect(result.projects).toHaveLength(2);
  const [a, b] = [count("A"), count("B")];
  await waitFor(() => count("A") >= a + 3 && count("B") >= b + 3);
  running.stop();
  await running.done;
  expect(await exists(join(dir, "loop.sock"))).toBe(false);
});

test("a restart picks the run up from run.json: only the unfinished step runs", {
  timeout: 10_000,
}, async () => {
  const pipelines = await writeConfigs(["CYC"], ["CYC"]);
  const stateDir = join(dir, "state-CYC");
  const cfg = config({ stateDir });
  const clock = { now: () => new Date("2026-11-25T00:00:00Z") };
  const store = new RunStore(stateDir, clock.now);
  const tracker = new FakeTracker([issue({ description: readyDescription })]);
  const world: World = {
    fail: new Set(),
    calls: [],
    dirty: false,
    qaWrites: false,
    headSha: "abc",
    ciResponses: [],
    ciLogs: {},
    prState: "OPEN",
    prMerge: [["MERGED", "UNKNOWN"]],
    mergeTreeOutput: "",
    ignoredDirs: "",
  };
  const make = (sessions: FakeSessions, exec = makeExec(world)) =>
    new Pipeline({
      config: cfg,
      tracker,
      sessions,
      exec,
      store,
      clock,
      log: () => {},
      env: { PATH: "/bin", GH_TOKEN: "secret" },
      sleep: async () => {},
    });

  // First process: Dev and QA finish, then it is killed while waiting for CI.
  const base = makeExec(world);
  const first = new FakeSessions({ dev: [done()], qa: [done(PASS)] });
  await expect(
    make(first, async (argv, o) => {
      if (argv.some((a) => a.includes("statusCheckRollup"))) throw new Error("killed");
      return base(argv, o);
    }).step(),
  ).rejects.toThrow("killed");
  expect((await store.load("CYC-1"))?.phase).toBe("ci");

  // Second process: the real startup path, with the same state directory.
  const second = new FakeSessions({ dev: [], qa: [], review: [done(REVIEW_MERGE)] });
  const pipeline = make(second);
  const running = await startServer({
    dataDir: dir,
    pipelinesPath: pipelines,
    log: () => {},
    setUp: async () => ({
      name: "CYC",
      pipeline: { step: () => pipeline.step(), intervalSeconds: 0.01 },
      release: async () => {},
      close: async () => {},
      workers: 1,
    }),
  });
  await waitFor(async () => (await store.events()).some((e) => e.kind === "delivered"));
  running.stop();
  await running.done;
  expect(second.prompts.map((p) => p.role)).toEqual(["review"]);
  expect(second.created.every((id) => id.startsWith("review"))).toBe(true);
});

test("a Project that fails setup in startPipelines closes the ones already up", async () => {
  const closed: string[] = [];
  await expect(
    startPipelines(
      [file("A"), file("B")],
      async (f) => {
        if (f.projectKey === "B") throw new Error("bad");
        return counting("A", [], closed);
      },
      () => {},
    ),
  ).rejects.toThrow("bad");
  expect(closed).toEqual(["A"]);
});

test("checkCovered names the missing Project", () => {
  expect(() => checkCovered(["A", "B"], [file("A")])).toThrow("B");
  expect(() => checkCovered(["A"], [file("A")])).not.toThrow();
});
