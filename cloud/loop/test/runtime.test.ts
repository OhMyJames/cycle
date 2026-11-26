import { afterEach, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectUnit } from "../src/assemble.ts";
import type { ConfigFile } from "../src/config-file.ts";
import { SqliteStore } from "../src/db/store.ts";
import { Pipeline } from "../src/pipeline.ts";
import { handleStopSignals, startPipelines, startServer, startupReason } from "../src/runtime.ts";
import { readStats } from "../src/stats.ts";
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

/** Writes the one loop.json: every key is a Project; those in `bare` lack the pipeline fields. */
const writeConfigs = async (keys: string[], bare: string[] = []) => {
  const loop = join(dir, "loop.json");
  await writeFile(
    loop,
    JSON.stringify({
      projects: keys.map((k) => ({
        name: k,
        projectKey: k,
        repo: { url: "https://github.com/o/r.git", forge: "github" },
        token: "tok-secret",
        ...(bare.includes(k)
          ? {}
          : { repoRoot: "/r", stateDir: join(dir, `state-${k}`), planKey: "k" }),
      })),
    }),
  );
  await chmod(loop, 0o600);
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

test("a Project in loop.json missing pipeline fields stops startup with the reason and opens no socket", async () => {
  await writeConfigs(["A", "B"], ["B"]);
  const setUp = async () => counting("x", []);
  const error = await startServer({ dataDir: dir, setUp, log: () => {} })
    .then(() => undefined)
    .catch((e: unknown) => e);
  const reason = startupReason(error);
  expect(reason).toContain("projects[1]");
  expect(reason).toContain("missing required repoRoot, stateDir, planKey");
  expect(reason).not.toContain("tok-secret");
  expect(await exists(join(dir, "loop.sock"))).toBe(false);
});

test("only an auto-loop.json is not a config: startup fails naming the missing loop.json", async () => {
  await writeFile(
    join(dir, "auto-loop.json"),
    JSON.stringify({ repoRoot: "/r", projectKey: "A", stateDir: "/s", planKey: "k" }),
    { mode: 0o600 },
  );
  const setUp = async () => counting("x", []);
  const reason = await startServer({ dataDir: dir, setUp, log: () => {} }).then(
    () => "started",
    startupReason,
  );
  expect(reason).toBe("config_missing");
});

test("a loose loop.json or a missing one is named by its fixed word", async () => {
  await writeConfigs(["A"]);
  await chmod(join(dir, "loop.json"), 0o644);
  const setUp = async () => counting("x", []);
  const reason = () =>
    startServer({ dataDir: dir, setUp, log: () => {} }).then(() => "started", startupReason);
  expect(await reason()).toBe("config_mode");
  await rm(join(dir, "loop.json"));
  expect(await reason()).toBe("config_missing");
});

test("a Project that cannot be set up fails startup, closes the others, and never opens the socket", async () => {
  await writeConfigs(["A", "B"]);
  const steps: string[] = [];
  const closed: string[] = [];
  const error = await startServer({
    dataDir: dir,
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
  await writeConfigs(["A", "B"]);
  const seen: boolean[] = [];
  const running = await startServer({
    dataDir: dir,
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
  await writeConfigs(["A", "B"]);
  const steps: string[] = [];
  const running = await startServer({
    dataDir: dir,
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
  await writeConfigs(["CYC"]);
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

/** A Project whose step is held open until `finish` is called, so a stop can land in the middle of it. */
const held = (released: string[]) => {
  const started: number[] = [];
  const finishes: (() => void)[] = [];
  const unit = (name: string): ProjectUnit => ({
    name,
    pipeline: {
      step: () => {
        started.push(started.length);
        return new Promise<{ status: string }>((resolve) => {
          finishes.push(() => resolve({ status: "worked" }));
        });
      },
      intervalSeconds: 0.001,
    } as unknown as ProjectUnit["pipeline"],
    release: async () => {
      released.push(name);
    },
    close: async () => {},
    workers: 1,
  });
  return {
    started,
    unit,
    finish: () => {
      for (const f of finishes.splice(0)) f();
    },
  };
};

test("the first stop signal lets the step in flight finish and starts no new one", {
  timeout: 5000,
}, async () => {
  const released: string[] = [];
  const h = held(released);
  const source = new EventEmitter();
  const exits: number[] = [];
  const logs: string[] = [];
  const running = await startPipelines(
    [file("A")],
    async () => h.unit("A"),
    () => {},
  );
  handleStopSignals({
    running,
    log: (l) => logs.push(l),
    exit: (c) => exits.push(c),
    source: { on: (s, f) => source.on(s, f) },
  });
  await waitFor(() => h.started.length === 1);
  source.emit("SIGTERM");
  let ended = false;
  void running.done.then(() => {
    ended = true;
  });
  await Bun.sleep(30);
  // The step is still running: the stop waits for it.
  expect(ended).toBe(false);
  expect(logs).toEqual(["stopping after this step (again to leave now)"]);
  h.finish();
  await running.done;
  expect(h.started).toHaveLength(1);
  expect(exits).toEqual([]);
});

test("the second stop signal releases every Project's lock and exits 130 at once", async () => {
  const released: string[] = [];
  const h = held(released);
  const source = new EventEmitter();
  const exits: number[] = [];
  const running = await startPipelines(
    [file("A"), file("B")],
    async (f) => h.unit(f.projectKey),
    () => {},
  );
  handleStopSignals({
    running,
    log: () => {},
    exit: (c) => exits.push(c),
    source: { on: (s, f) => source.on(s, f) },
  });
  await waitFor(() => h.started.length === 2);
  source.emit("SIGINT");
  expect(exits).toEqual([]);
  expect(released).toEqual([]);
  source.emit("SIGINT");
  await waitFor(() => exits.length > 0);
  // The steps never finished, yet the locks are released and the exit happens once.
  expect(released.sort()).toEqual(["A", "B"]);
  expect(exits).toEqual([130]);
  // A third signal while leaving exits again rather than being swallowed.
  source.emit("SIGINT");
  expect(exits).toEqual([130, 130]);
  h.finish();
  await running.done;
});

test("stop, then start again: the server comes back with the same Projects and steps run again", {
  timeout: 5000,
}, async () => {
  await writeConfigs(["A"]);
  const steps: string[] = [];
  const source = new EventEmitter();
  const boot = async () => {
    const running = await startServer({
      dataDir: dir,
      log: () => {},
      setUp: async () => counting("A", steps),
    });
    handleStopSignals({
      running,
      log: () => {},
      exit: () => {},
      source: { on: (s, f) => source.on(s, f) },
    });
    return running;
  };
  const first = await boot();
  await waitFor(() => steps.length >= 2);
  source.emit("SIGTERM");
  await first.done;
  expect(await exists(join(dir, "loop.sock"))).toBe(false);
  source.removeAllListeners();
  const before = steps.length;
  const second = await boot();
  await waitFor(() => steps.length >= before + 2);
  source.emit("SIGINT");
  await second.done;
});

test("stats reads loop.db when there is one, and the files otherwise", async () => {
  const at = () => new Date("2026-11-26T00:00:00Z");
  const files = new RunStore(dir, at);
  await files.event("CYC-1", "claimed");
  expect((await readStats(dir, at)).runs).toBe(1);

  const db = SqliteStore.open(dir, at);
  await db.event("CYC-7", "claimed");
  await db.event("CYC-8", "claimed");
  db.close();
  expect((await readStats(dir, at)).runs).toBe(2);
});
