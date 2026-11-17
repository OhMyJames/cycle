import { expect, test } from "bun:test";
import type { EventFrame, SessionInfo, Settings } from "@cycle/protocol";
import {
  Git,
  JsonStore,
  type MetaFile,
  SessionHub,
  type UsageFile,
  UsageLedger,
} from "../src/index.ts";
import { FakeHarness, manualSchedule } from "./fake-harness.ts";

const memory = () => ({ read: async () => null, write: async () => {} });

async function setup(stored: MetaFile = { sessions: {} }) {
  const harness = new FakeHarness();
  const timers = manualSchedule();
  const frames: EventFrame[] = [];
  const infos: SessionInfo[] = [];
  const settings: Settings = {
    model: null,
    effort: null,
    modes: {},
    worktree: false,
    projects: [],
  };
  const meta = await JsonStore.open<MetaFile>(memory(), stored, timers.schedule);
  const usageFile = await JsonStore.open<UsageFile>(memory(), { days: {} }, timers.schedule);
  const hub = new SessionHub({
    harness: harness.asAgents(),
    meta,
    settings: () => settings,
    usage: new UsageLedger(usageFile, () => 0),
    git: new Git((argv, options) => harness.exec(argv, options)),
    worktreeParent: "/home/worktrees",
    schedule: timers.schedule,
    now: () => 1000,
    log: () => {},
    viewers: () => 0,
    publish: {
      frame: (frame) => frames.push(frame),
      sessions: (list) => infos.push(...list),
      removed: () => {},
      usage: () => {},
    },
  });
  return { harness, hub };
}

test("a tag goes to the agent that keeps it, trimmed and cut, and shows on the session", async () => {
  const { harness, hub } = await setup();
  const info = await hub.create({ cwd: "/project" });
  const set = await hub.update({ sessionId: info.id, tag: "  later  " });
  expect(set.tag).toBe("later");
  expect(hub.info(info.id).tag).toBe("later");
  const long = await hub.update({ sessionId: info.id, tag: "x".repeat(100) });
  expect(long.tag).toHaveLength(40);
  const cleared = await hub.update({ sessionId: info.id, tag: null });
  expect(cleared).not.toHaveProperty("tag");
  expect(harness.calls.filter((call) => call.startsWith("tag "))).toEqual([
    `tag ${info.id} later`,
    `tag ${info.id} ${"x".repeat(40)}`,
    `tag ${info.id} none`,
  ]);
});
