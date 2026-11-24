import { expect, test } from "bun:test";
import { attach, JsonlLogStore, type LogRecord } from "../src/index.ts";
import { eachTempDir } from "./support.ts";

let dir: string;
eachTempDir((made) => {
  dir = made;
});

const open = () => new JsonlLogStore({ dir }).open("s1");
const seqs = (records: LogRecord[]) => records.map((r) => r.seq);

test("replays everything after a point, then the live records", async () => {
  const log = await open();
  for (let i = 0; i < 5; i++) await log.append({ kind: "update", data: i });
  const got: LogRecord[] = [];
  const { replayedTo, detach } = await attach(log, 2, (r) => {
    got.push(r);
  });
  expect(replayedTo).toBe(5);
  expect(seqs(got)).toEqual([3, 4, 5]);
  await log.append({ kind: "update", data: 5 });
  expect(seqs(got)).toEqual([3, 4, 5, 6]);
  detach();
  await log.append({ kind: "update", data: 6 });
  expect(seqs(got)).toEqual([3, 4, 5, 6]);
  await log.close();
});

test("loses and repeats nothing when records are appended during the replay", async () => {
  const log = await open();
  for (let i = 0; i < 20; i++) await log.append({ kind: "update", data: i });
  const got: number[] = [];
  let appending: Promise<unknown> = Promise.resolve();
  let live = 0;
  const attached = attach(log, 0, async (r) => {
    got.push(r.seq);
    // A slow client: while it takes the first records, the session keeps going.
    if (live++ < 10) appending = appending.then(() => log.append({ kind: "update", data: "live" }));
    await Bun.sleep(1);
  });
  await attached;
  await appending;
  await Bun.sleep(20);
  const final = log.lastSeq();
  expect(got).toEqual(Array.from({ length: final }, (_, i) => i + 1).slice(0, got.length));
  expect(new Set(got).size).toBe(got.length);
  expect(got.at(-1)).toBe(final);
  await log.close();
});

test("an empty history replays to nothing and then goes live", async () => {
  const log = await open();
  const got: LogRecord[] = [];
  await attach(log, 0, (r) => {
    got.push(r);
  });
  await log.append({ kind: "update", data: 1 });
  expect(seqs(got)).toEqual([1]);
  await log.close();
});

test("refuses a point past the end of the history", async () => {
  const log = await open();
  await log.append({ kind: "update", data: 1 });
  await expect(attach(log, 2, () => {})).rejects.toMatchObject({ code: -32602 });
  await expect(attach(log, -1, () => {})).rejects.toMatchObject({ code: -32602 });
  await log.close();
});

test("a client that fails while being sent the history stops receiving", async () => {
  const log = await open();
  await log.append({ kind: "update", data: 1 });
  await expect(
    attach(log, 0, () => {
      throw new Error("client gone");
    }),
  ).rejects.toThrow("client gone");
  await log.append({ kind: "update", data: 2 });
  await log.close();
});

test("a record appended at any point of the hand-over to live is sent once, in order", async () => {
  // The log tells its subscriber of record 3 a few turns of the event loop after its history was
  // read, which is where the replay changes over from the held records to the live ones. A different
  // number of turns for each try, so the whole span of that step is covered.
  for (let turns = 0; turns < 8; turns++) {
    const record = (seq: number) => ({ seq, ts: "now", kind: "update", data: seq }) as LogRecord;
    const records = [record(1), record(2)];
    const listeners = new Set<(record: LogRecord) => void>();
    const log = {
      sessionId: "s",
      lastSeq: () => 2,
      updatedAt: () => 0,
      subscribe: (listener: (record: LogRecord) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      read: async () => {
        let later = Promise.resolve();
        for (let i = 0; i < turns; i++) later = later.then(() => undefined);
        void later.then(() => {
          for (const listener of listeners) listener(record(3));
        });
        return records;
      },
      append: async () => record(1),
      close: async () => undefined,
    };
    const got: number[] = [];
    await attach(log as never, 0, (r) => {
      got.push(r.seq);
    });
    await Bun.sleep(5);
    expect({ turns, got }).toEqual({ turns, got: [1, 2, 3] });
  }
});
