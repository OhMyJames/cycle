import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/db/store.ts";
import { deadlineFor, recordHeartbeat, WORKER_BEAT_KEY } from "../src/engine/heartbeat.ts";
import { computeStats } from "../src/stats.ts";
import { installServiceFiles } from "../src/supervisor/install.ts";
import {
  type ManagedProcess,
  type ProcessControl,
  SupervisorWatchdog,
} from "../src/supervisor/watchdog.ts";
import { config } from "./helpers.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "loop-supervisor-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const makeFakeProc = () => {
  let nextPid = 1000;
  const alive = new Set<number>();
  const signals: { pid: number; sig: string }[] = [];
  const spawns: number[] = [];
  let ignoreSigterm = false;

  const proc: ProcessControl = {
    spawn(): ManagedProcess {
      const pid = nextPid++;
      alive.add(pid);
      spawns.push(pid);
      return { pid, exited: Promise.resolve(0) };
    },
    isAlive: (pid) => alive.has(pid),
    signal(pid, sig) {
      signals.push({ pid, sig });
      if (sig === "SIGKILL" || (sig === "SIGTERM" && !ignoreSigterm)) {
        alive.delete(pid);
      }
    },
  };

  return {
    proc,
    alive,
    signals,
    spawns,
    kill: (pid: number) => alive.delete(pid),
    setIgnoreSigterm: (v: boolean) => {
      ignoreSigterm = v;
    },
  };
};

const activeRun = (key: string, phase: "dev" | "blocked" = "dev") => ({
  key,
  kind: "dev" as const,
  issueId: 1,
  issueNumber: 1,
  title: "Test run",
  phase,
  round: 0,
  worktree: "/tmp/wt",
  localBranch: "worktree-auto/cyc-1",
  remoteBranch: "auto/cyc-1",
  devSessionId: "dev-1",
  qaSessionId: null,
  replacedSessions: [],
  blockedReason: phase === "blocked" ? "waiting" : null,
  resumeFrom: null,
  findings: null,
  cleanedAt: null,
  cleanupNote: null,
  startedAt: "2026-11-27T00:00:00.000Z",
  updatedAt: "2026-11-27T00:00:00.000Z",
  dev: {
    prUrl: null,
    ciRound: 0,
    ciFailedSha: null,
    nodeModulesReleased: false,
    conflictRound: 0,
    conflict: null,
    resolvedFiles: [],
    reviewSessionId: null,
    fullFlowDocs: [],
    bodyHash: null,
    bodyChanged: false,
    activeNodeId: null,
  },
});

test("restarts dead Work loop with backoff and halts after >5 restarts in 10 minutes with a Notice (CYC-484)", async () => {
  let nowMs = Date.parse("2026-11-27T10:00:00.000Z");
  const now = () => new Date(nowMs);
  const store = SqliteStore.open(dir, now);
  const fake = makeFakeProc();

  const wd = new SupervisorWatchdog({
    projects: [{ projectKey: "CYC", store }],
    proc: fake.proc,
    cancelRun: async () => true,
    now,
    sleep: async (ms) => {
      nowMs += ms;
    },
    baseBackoffMs: 1_000,
    maxRestartsInWindow: 5,
    crashWindowMs: 10 * 60_000,
  });

  wd.start();
  expect(fake.spawns).toEqual([1000]);

  // 5 crashes inside 10 minutes -> each is restarted once backoff elapses.
  for (let i = 0; i < 5; i++) {
    fake.kill(wd.pid as number);
    nowMs += 60_000;
    const res = await wd.tick();
    expect(res.action).toBe("restarted");
  }
  expect(fake.spawns).toHaveLength(6);

  // 6th crash inside 10 minutes -> halts auto-restart and writes a supervisor Notice.
  fake.kill(wd.pid as number);
  nowMs += 60_000;
  const halted = await wd.tick();
  expect(halted.action).toBe("halted");
  expect(wd.halted).toBe(true);
  expect(fake.spawns).toHaveLength(6);

  const notices = store.notices();
  expect(notices.some((n) => n.kind === "supervisor" && n.text.includes("超过 5 次"))).toBe(true);
  const stats = computeStats(await store.events());
  expect(stats.restarts).toBe(5);
});

test("restarts Work loop with SIGTERM then SIGKILL when all worker heartbeats stall >10m (CYC-484)", async () => {
  let nowMs = Date.parse("2026-11-27T10:00:00.000Z");
  const now = () => new Date(nowMs);
  const store = SqliteStore.open(dir, now);
  const fake = makeFakeProc();
  fake.setIgnoreSigterm(true);

  const wd = new SupervisorWatchdog({
    projects: [{ projectKey: "CYC", store }],
    proc: fake.proc,
    cancelRun: async () => true,
    now,
    sleep: async (ms) => {
      nowMs += ms;
    },
    staleMs: 10 * 60_000,
    killGraceMs: 30_000,
  });

  wd.start();
  const initialPid = wd.pid as number;
  recordHeartbeat(store, WORKER_BEAT_KEY, { phase: "idle", waitingOn: "idle", deadline: null });

  // Advance 11 minutes with no new heartbeat.
  nowMs += 11 * 60_000;
  const res = await wd.tick();
  expect(res.action).toBe("stale_restarted");
  expect(fake.signals).toContainEqual({ pid: initialPid, sig: "SIGTERM" });
  expect(fake.signals).toContainEqual({ pid: initialPid, sig: "SIGKILL" });
  expect(wd.pid).not.toBe(initialPid);
  expect(wd.pid).not.toBeNull();
});

test("overdue run cancels once with action, escalates with stuck Notice on second overdue; person-waiting runs are never stuck (CYC-484)", async () => {
  let nowMs = Date.parse("2026-11-27T10:00:00.000Z");
  const now = () => new Date(nowMs);
  const store = SqliteStore.open(dir, now);
  const fake = makeFakeProc();
  const cancelledCalls: [string, string][] = [];

  await store.save(activeRun("CYC-1", "dev"));
  await store.save(activeRun("CYC-2", "dev"));
  await store.save(activeRun("CYC-3", "blocked"));

  const cfg = config({ stateDir: dir, turnTimeoutMs: 30 * 60_000 });
  const deadline1 = deadlineFor("session", now(), cfg);
  expect(deadline1).toBe("2026-11-27T10:35:00.000Z");

  recordHeartbeat(store, "CYC-1", { phase: "dev", waitingOn: "session", deadline: deadline1 });
  // CYC-2 is waiting on a person: no deadline and never considered stuck.
  recordHeartbeat(store, "CYC-2", {
    phase: "dev",
    waitingOn: "person",
    deadline: deadlineFor("person", now(), cfg),
  });
  // CYC-3 is Blocked.
  recordHeartbeat(store, "CYC-3", { phase: "blocked", waitingOn: "person", deadline: null });

  const wd = new SupervisorWatchdog({
    projects: [{ projectKey: "CYC", store }],
    proc: fake.proc,
    cancelRun: async (proj, key) => {
      cancelledCalls.push([proj, key]);
      return true;
    },
    now,
  });
  wd.start();

  // Keep global worker heartbeat fresh while advancing past CYC-1's deadline.
  nowMs = Date.parse("2026-11-27T10:36:00.000Z");
  recordHeartbeat(store, WORKER_BEAT_KEY, { phase: "dev", waitingOn: "session", deadline: null });

  const first = await wd.tick();
  expect(first.action).toBe("ok");
  expect(first.cancelled).toEqual(["CYC-1"]);
  expect(first.escalated).toEqual([]);
  expect(cancelledCalls).toEqual([["CYC", "CYC-1"]]);
  expect(
    store
      .actions("CYC-1")
      .some(
        (a) =>
          a.kind === "cancel_turn" && (a.data as { actorKind?: string }).actorKind === "supervisor",
      ),
  ).toBe(true);

  // Second overdue detection for CYC-1 -> writes stuck Notice & stuck_escalated event, does NOT cancel again.
  nowMs += 60_000;
  recordHeartbeat(store, WORKER_BEAT_KEY, { phase: "dev", waitingOn: "session", deadline: null });
  const second = await wd.tick();
  expect(second.cancelled).toEqual([]);
  expect(second.escalated).toEqual(["CYC-1"]);
  expect(cancelledCalls).toHaveLength(1);

  const notices = store.notices();
  expect(notices.some((n) => n.runKey === "CYC-1" && n.kind === "stuck")).toBe(true);
  expect(notices.some((n) => n.runKey === "CYC-2" || n.runKey === "CYC-3")).toBe(false);
  const stats = computeStats(await store.events());
  expect(stats.stuck).toBe(1);
});

test("installServiceFiles writes launchd plist and systemd unit to temp dir without touching real home or launchd (CYC-484)", async () => {
  const plist = installServiceFiles({
    os: "darwin",
    targetPath: join(dir, "com.cycle.loop-supervisor.plist"),
    bunPath: "/usr/local/bin/bun",
    entryPath: "/repo/cloud/loop/src/supervisor/main.ts",
    dataDir: join(dir, "data"),
    logDir: join(dir, "logs"),
  });
  const plistText = await readFile(plist.path, "utf8");
  expect(plistText).toContain("com.cycle.loop-supervisor");
  expect(plistText).toContain("<key>KeepAlive</key>");
  expect(plistText).toContain("<key>EnvironmentVariables</key>");
  expect(plistText).toContain("/opt/homebrew/bin");

  const unit = installServiceFiles({
    os: "linux",
    targetPath: join(dir, "cycle-loop-supervisor.service"),
    bunPath: "/usr/local/bin/bun",
    entryPath: "/repo/cloud/loop/src/supervisor/main.ts",
    dataDir: join(dir, "data"),
    logDir: join(dir, "logs"),
  });
  expect(await readFile(unit.path, "utf8")).toContain("Restart=always");
});

test("stale pre-restart heartbeat does not immediately kill freshly started Work loop, and overdue count resets after progress (CYC-484)", async () => {
  let nowMs = Date.parse("2026-11-27T10:00:00.000Z");
  const now = () => new Date(nowMs);
  const store = SqliteStore.open(dir, now);
  const fake = makeFakeProc();

  // Write an old heartbeat from an hour before supervisor starts.
  recordHeartbeat(store, WORKER_BEAT_KEY, { phase: "idle", waitingOn: "idle", deadline: null });
  nowMs = Date.parse("2026-11-27T11:00:00.000Z");

  const wd = new SupervisorWatchdog({
    projects: [{ projectKey: "CYC", store }],
    proc: fake.proc,
    cancelRun: async () => true,
    now,
    staleMs: 10 * 60_000,
  });
  wd.start();
  const initialPid = wd.pid;
  nowMs += 60_000;
  const first = await wd.tick();
  expect(first.action).toBe("ok");
  expect(wd.pid).toBe(initialPid);

  // Overdue once, then advances to a fresh deadline -> overdue count resets instead of escalating next time.
  await store.save(activeRun("CYC-9", "dev"));
  recordHeartbeat(store, "CYC-9", {
    phase: "dev",
    waitingOn: "session",
    deadline: "2026-11-27T10:59:00.000Z",
  });
  expect((await wd.tick()).cancelled).toEqual(["CYC-9"]);

  recordHeartbeat(store, "CYC-9", {
    phase: "qa",
    waitingOn: "session",
    deadline: "2026-11-27T11:30:00.000Z",
  });
  expect((await wd.tick()).escalated).toEqual([]);

  nowMs = Date.parse("2026-11-27T11:35:00.000Z");
  recordHeartbeat(store, WORKER_BEAT_KEY, { phase: "qa", waitingOn: "session", deadline: null });
  const later = await wd.tick();
  expect(later.cancelled).toEqual(["CYC-9"]);
  expect(later.escalated).toEqual([]);
});
