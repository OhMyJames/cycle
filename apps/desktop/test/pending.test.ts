import { expect, test } from "bun:test";
import type { PermissionAnswer } from "@cycle/client";
import type { AppEvent } from "@cycle/ui";
import { type PendingRuntime, PendingStore } from "../src/main/pending.ts";
import type { Connection } from "../src/main/runtime.ts";

/** A connection as the store sees it: only what it holds of its sessions. */
const connection = (): Connection =>
  ({ watched: new Map(), status: { environmentId: "e", state: "connected" } }) as Connection;

const setup = () => {
  const events: AppEvent[] = [];
  let current: Connection | undefined;
  const runtime: PendingRuntime = {
    emit: (event) => void events.push(event),
    track: () => undefined,
    isCurrent: (_environmentId, c) => c === current,
  };
  return {
    store: new PendingStore(runtime),
    events,
    use: (c: Connection) => {
      current = c;
    },
  };
};

const request = { title: "Allow it?", options: [{ optionId: "allow", kind: "allow_once" }] };

test("a connection dropped late does not take the request asked again on the one that replaced it", async () => {
  const { store, use } = setup();
  const old = connection();
  const now = connection();
  use(old);
  const first = store.ask("e", old, "s", request, "r1");
  // Replaced: what the old one held is cancelled, and the daemon asks again on the new one, under the same key.
  use(now);
  store.release(old, { cancel: true });
  expect(await first).toEqual({ outcome: "cancelled" });
  let answered: PermissionAnswer | undefined;
  void store.ask("e", now, "s", request, "r1").then((a) => {
    answered = a;
  });
  // The old connection is let go again (its start failed late): the new one's request stays answerable.
  store.release(old, { cancel: false });
  await store.answer("e:s:r1", "allow");
  await Bun.sleep(0);
  expect(answered).toEqual({ outcome: "selected", optionId: "allow" });
});

test("a late ask on a replaced connection does not hide the current one's request", async () => {
  const { store, use, events } = setup();
  const old = connection();
  const now = connection();
  use(now);
  let answered: PermissionAnswer | undefined;
  void store.ask("e", now, "s", request, "r1").then((a) => {
    answered = a;
  });
  void store.ask("e", old, "s", request, "r1");
  await store.answer("e:s:r1", "allow");
  await Bun.sleep(0);
  expect(answered).toEqual({ outcome: "selected", optionId: "allow" });
  expect(events.filter((e) => e.type === "permission-closed")).toHaveLength(1);
});

test("a request whose connection is no longer the environment's is not answered", async () => {
  const { store, use, events } = setup();
  const old = connection();
  use(old);
  let answered: PermissionAnswer | undefined;
  void store.ask("e", old, "s", request, "r1").then((a) => {
    answered = a;
  });
  use(connection());
  await store.answer("e:s:r1", "allow");
  await Bun.sleep(0);
  expect(answered).toBeUndefined();
  expect(events.filter((e) => e.type === "permission-closed")).toEqual([]);
});
