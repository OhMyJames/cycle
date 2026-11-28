import { expect, test } from "bun:test";
import type { DraftStorage } from "../src/draft.ts";
import { CLOSED, REMEMBERED, SidePanelStore } from "../src/side-panel.ts";

const memoryStorage = (initial: Record<string, string> = {}): DraftStorage => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
};

test("a session whose panel was never opened has it closed, on the Overview", () => {
  const panels = new SidePanelStore(memoryStorage());
  expect(panels.get("local:a")).toBe(CLOSED);
  expect(CLOSED).toEqual({
    open: false,
    tabs: ["overview", "files", "diff"],
    active: "overview",
  });
});

test("each session keeps its own panel, and a restart finds it again", () => {
  const storage = memoryStorage();
  const panels = new SidePanelStore(storage);
  panels.setOpen("local:a", true);
  expect(panels.get("local:a").open).toBe(true);
  expect(panels.get("local:b").open).toBe(false);
  const again = new SidePanelStore(storage);
  expect(again.get("local:a")).toEqual({ ...CLOSED, open: true });
  again.setOpen("local:a", false);
  expect(new SidePanelStore(storage).get("local:a").open).toBe(false);
});

test("the state is the same object until it changes, and a change is told", () => {
  const panels = new SidePanelStore(memoryStorage());
  let told = 0;
  panels.subscribe(() => told++);
  panels.setOpen("local:a", true);
  const first = panels.get("local:a");
  expect(panels.get("local:a")).toBe(first);
  panels.setOpen("local:a", true);
  panels.show("local:a", "overview");
  expect(told).toBe(1);
});

test("showing a tab opens the panel on it", () => {
  const panels = new SidePanelStore(memoryStorage());
  panels.show("local:a", "overview");
  expect(panels.get("local:a")).toEqual({ ...CLOSED, open: true });
});

test("only the sessions used last are remembered", () => {
  const storage = memoryStorage();
  const panels = new SidePanelStore(storage);
  for (let i = 0; i <= REMEMBERED; i++) panels.setOpen(`local:${i}`, true);
  const again = new SidePanelStore(storage);
  expect(again.get("local:0").open).toBe(false);
  expect(again.get("local:1").open).toBe(true);
  expect(again.get(`local:${REMEMBERED}`).open).toBe(true);
});

test("a session that is used again is the last one to be forgotten", () => {
  const panels = new SidePanelStore(memoryStorage());
  for (let i = 0; i < REMEMBERED; i++) panels.setOpen(`local:${i}`, true);
  panels.setOpen("local:0", false);
  panels.setOpen("local:0", true);
  panels.setOpen("local:new", true);
  expect(panels.get("local:0").open).toBe(true);
  expect(panels.get("local:1").open).toBe(false);
});

test("a deleted session's panel goes, and a removed location's panels go with it", () => {
  const storage = memoryStorage();
  const panels = new SidePanelStore(storage);
  panels.setOpen("local:a", true);
  panels.setOpen("ssh-box:b", true);
  panels.setOpen("ssh-box:c", true);
  panels.forget("local:a");
  panels.forgetLocation("ssh-box");
  expect(panels.get("local:a").open).toBe(false);
  expect(panels.get("ssh-box:b").open).toBe(false);
  expect(storage.getItem("cycle:side-panel")).toBeNull();
});

test("what storage holds and is not understood is left out, not thrown on", () => {
  const panels = new SidePanelStore(
    memoryStorage({
      "cycle:side-panel": JSON.stringify([
        ["local:a", { open: true, tabs: ["overview", "gone"], active: "gone" }],
        ["local:b", { open: true, tabs: ["gone"] }],
        ["local:c", "nonsense"],
        42,
      ]),
    }),
  );
  expect(panels.get("local:a")).toEqual({ open: true, tabs: ["overview"], active: "overview" });
  // Every view closed is a state (the session's terminals are its tabs); tabs that are no list at all is not one.
  expect(panels.get("local:b")).toEqual({ open: true, tabs: [], active: "overview" });
  expect(panels.get("local:c")).toBe(CLOSED);
  expect(new SidePanelStore(memoryStorage({ "cycle:side-panel": "{" })).get("local:a")).toBe(
    CLOSED,
  );
});

test("a terminal's tab is remembered as the one shown, but not kept among the tabs: the daemon lists terminals", () => {
  const storage = memoryStorage();
  const panels = new SidePanelStore(storage);
  panels.show("local:a", "terminal:t1");
  expect(panels.get("local:a")).toEqual({ ...CLOSED, open: true, active: "terminal:t1" });
  expect(new SidePanelStore(storage).get("local:a").active).toBe("terminal:t1");
});

test("a stored tab shown that is neither a kind nor a terminal falls back to the first tab", () => {
  const storage = memoryStorage({
    "cycle:side-panel": JSON.stringify([
      ["local:a", { open: true, tabs: ["diff"], active: "browser" }],
    ]),
  });
  expect(new SidePanelStore(storage).get("local:a").active).toBe("diff");
});

test("a closed view's tab leaves the strip, the tab named shown in its place; shown again, it is put back at the end", () => {
  const storage = memoryStorage();
  const panels = new SidePanelStore(storage);
  panels.show("local:a", "files");
  panels.close("local:a", "files", "diff");
  expect(panels.get("local:a")).toEqual({ open: true, tabs: ["overview", "diff"], active: "diff" });
  // One that was not the one shown: what is shown stays.
  panels.close("local:a", "overview", "diff");
  expect(panels.get("local:a")).toEqual({ open: true, tabs: ["diff"], active: "diff" });
  // The last view, with a terminal to show in its place: no view is left, and a restart finds it so.
  panels.close("local:a", "diff", "terminal:t1");
  expect(new SidePanelStore(storage).get("local:a")).toEqual({
    open: true,
    tabs: [],
    active: "terminal:t1",
  });
  panels.show("local:a", "files");
  panels.show("local:a", "overview");
  expect(panels.get("local:a").tabs).toEqual(["files", "overview"]);
  // A tab that is not in the strip: nothing changes, and nobody is told.
  let told = 0;
  panels.subscribe(() => told++);
  panels.close("local:a", "diff");
  expect(told).toBe(0);
});
