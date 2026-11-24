import { expect, test } from "bun:test";
import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { type LedgerEntry, type Listed, TaskLedger } from "../src/task-ledger.ts";
import { BackgroundTasks } from "../src/tasks.ts";

type Entry = LedgerEntry & { background: boolean };
type Row = { task_id: string; run_id?: string; background?: boolean };

const told = (id: string, what: string) => ({ id, what }) as unknown as SessionUpdate;

const ledger = () => {
  const known = new TaskLedger<Entry>((entry) => entry.background);
  const reconcile = (rows: Row[]) =>
    known.reconcile(
      rows,
      (task: Listed): task is Row => typeof task.task_id === "string",
      (task) => {
        known.set(task.task_id, {
          run: task.run_id,
          unknown: false,
          background: task.background ?? true,
        });
        return told(task.task_id, "running");
      },
      (id) => told(id, "unknown"),
    );
  return { known, reconcile };
};

test("a listed task is announced once per run, and again for a later run", () => {
  const { reconcile } = ledger();
  expect(reconcile([{ task_id: "a", run_id: "1" }])).toEqual([told("a", "running")]);
  expect(reconcile([{ task_id: "a", run_id: "1" }])).toEqual([]);
  expect(reconcile([{ task_id: "a" }])).toEqual([]);
  expect(reconcile([{ task_id: "a", run_id: "2" }])).toEqual([told("a", "running")]);
  // An earlier run, listed late, is stale.
  expect(reconcile([{ task_id: "a", run_id: "1" }])).toEqual([]);
});

test("a listed task that leaves the list with no end is lost once, and comes back when listed again", () => {
  const { reconcile } = ledger();
  reconcile([{ task_id: "a", run_id: "1" }]);
  expect(reconcile([])).toEqual([told("a", "unknown")]);
  expect(reconcile([])).toEqual([]);
  expect(reconcile([{ task_id: "a", run_id: "1" }])).toEqual([told("a", "running")]);
});

test("only the tasks the ledger lists are lost from the list or kept from being told again", () => {
  const { known, reconcile } = ledger();
  known.set("fg", { run: undefined, unknown: false, background: false });
  expect(reconcile([])).toEqual([]);
  expect(known.some((entry) => !entry.background)).toBe(true);
  // Not listed, so its being listed does not count as told already.
  expect(reconcile([{ task_id: "fg", background: true }])).toEqual([told("fg", "running")]);
});

test("stale and ofRun tell an earlier or another run apart from the known one", () => {
  const { known } = ledger();
  known.set("a", { run: "5", unknown: false, background: true });
  expect(known.stale("a", "4")).toBe(true);
  expect(known.stale("a", "5")).toBe(false);
  expect(known.stale("a", undefined)).toBe(false);
  expect(known.stale("b", "1")).toBe(false);
  expect(known.ofRun("a", "5")).toBeDefined();
  expect(known.ofRun("a", undefined)).toBeDefined();
  expect(known.ofRun("a", "6")).toBeUndefined();
});

test("endAll ends the tasks still told as running, not the lost ones, and forgets all", () => {
  const { known, reconcile } = ledger();
  reconcile([
    { task_id: "a", run_id: "1" },
    { task_id: "b", run_id: "1" },
  ]);
  reconcile([{ task_id: "a", run_id: "1" }]);
  expect(known.endAll()).toEqual(["a"]);
  expect(known.has("a") || known.has("b")).toBe(false);
  expect(known.some()).toBe(false);
});

test("a background task told as ended is not brought back by a list that lags behind", () => {
  const tasks = new BackgroundTasks();
  const row = { task_id: "t", run_id: "1", task_type: "local_bash", description: "build" };
  expect(tasks.reconcile([row])).toHaveLength(1);
  expect(tasks.hasRunning).toBe(true);
  const end = tasks.update({ subtype: "task_notification", task_id: "t", status: "completed" });
  expect((end as { state?: string }).state).toBe("completed");
  expect(tasks.reconcile([row])).toEqual([]);
  expect(tasks.hasRunning).toBe(false);
  // A later run of it is new.
  expect(tasks.reconcile([{ ...row, run_id: "2" }])).toHaveLength(1);
  expect(tasks.endAll().map((u) => (u as { state?: string }).state)).toEqual(["stopped"]);
});
