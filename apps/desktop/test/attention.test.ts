import { expect, test } from "bun:test";
import { type AppEvent, createTranslator, enUS } from "@cycle/ui";
import {
  heldNotifications,
  MAX_TITLE,
  type NotifyWindow,
  notifyAttention,
} from "../src/main/attention.ts";
import type { AttentionNotice } from "../src/main/manager.ts";

const notice = (over: Partial<AttentionNotice> = {}): AttentionNotice => ({
  locationId: "local",
  locationName: "Local",
  kind: "needs-you",
  session: {
    locationId: "local",
    sessionId: "s1",
    cwd: "/home/dev/cycle-v1",
    archived: false,
    agent: "claude",
    state: "requires_action",
    lastSeq: 3,
    title: "Approve the deploy",
  },
  ...over,
});

const rig = (
  options: {
    focused?: boolean;
    supported?: boolean;
    destroyed?: boolean;
    minimized?: boolean;
  } = {},
) => {
  const calls: string[] = [];
  const shown: { title: string; subtitle?: string; body: string }[] = [];
  const emitted: AppEvent[] = [];
  const listeners = new Map<string, () => void>();
  const window: NotifyWindow = {
    isFocused: () => options.focused ?? false,
    isDestroyed: () => options.destroyed ?? false,
    isMinimized: () => options.minimized ?? false,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };
  const notify = notifyAttention({
    window: () => window,
    supported: () => options.supported ?? true,
    create: (n) => {
      shown.push(n);
      return {
        show: () => calls.push("notify"),
        on: (event, listener) => {
          listeners.set(event, listener);
        },
      };
    },
    activate: () => calls.push("activate"),
    translator: () => createTranslator("en-US", enUS),
    emit: (event) => emitted.push(event),
  });
  const fire = (event: string) => listeners.get(event)?.();
  return { notify, calls, shown, emitted, press: () => fire("click"), fire };
};

test("a session that asks is a notification with its title and what it wants", () => {
  const { notify, shown, calls } = rig();
  notify(notice());
  expect(shown).toEqual([{ title: "Approve the deploy", body: "Waiting for your answer" }]);
  expect(calls).toEqual(["notify"]);
});

test("what is done and what stopped say so, in words (and not that it went well: the list does not know)", () => {
  const finished = rig();
  finished.notify(notice({ kind: "finished" }));
  expect(finished.shown[0]?.body).toBe("Waiting for your next message");
  const stopped = rig();
  stopped.notify(notice({ kind: "stopped" }));
  expect(stopped.shown[0]?.body).toBe("The agent stopped unexpectedly");
});

test("a session with no title is named by its folder, and one on another machine says which", () => {
  const { notify, shown } = rig();
  const { title: _gone, ...untitled } = notice().session;
  notify(
    notice({
      locationId: "build",
      locationName: "build-1",
      session: { ...untitled, locationId: "build" },
    }),
  );
  expect(shown).toEqual([
    { title: "cycle-v1", subtitle: "build-1", body: "Waiting for your answer" },
  ]);
});

test("while the app is in front nothing is shown, and nor when the system cannot", () => {
  const front = rig({ focused: true });
  front.notify(notice());
  expect(front.shown).toEqual([]);
  const unsupported = rig({ supported: false });
  unsupported.notify(notice());
  expect(unsupported.shown).toEqual([]);
  const closed = rig({ destroyed: true });
  closed.notify(notice());
  expect(closed.shown).toEqual([]);
});

test("pressing it brings the window back and asks the page to show that session", () => {
  const { notify, press, calls, emitted } = rig();
  notify(notice());
  press();
  expect(calls).toEqual(["notify", "show", "focus", "activate"]);
  expect(emitted).toEqual([{ type: "focus-session", locationId: "local", sessionId: "s1" }]);
});

test("a title is one line of a length a notification can use, and a title that says nothing is the folder", () => {
  const long = rig();
  long.notify(notice({ session: { ...notice().session, title: "x".repeat(500) } }));
  expect(long.shown[0]?.title).toHaveLength(MAX_TITLE);
  expect(long.shown[0]?.title.endsWith("…")).toBe(true);
  const lines = rig();
  lines.notify(notice({ session: { ...notice().session, title: "  Two\n\n lines\t here " } }));
  expect(lines.shown[0]?.title).toBe("Two lines here");
  const blank = rig();
  blank.notify(notice({ session: { ...notice().session, title: " \n " } }));
  expect(blank.shown[0]?.title).toBe("cycle-v1");
});

test("a minimized window is restored when the notification is pressed", () => {
  const { notify, press, calls } = rig({ minimized: true });
  notify(notice());
  press();
  expect(calls).toEqual(["notify", "restore", "show", "focus", "activate"]);
});

test("a notification is held until it is pressed, closed or fails, so that it is not collected before its click", () => {
  const held = heldNotifications();
  const pressed = rig();
  pressed.notify(notice());
  expect(heldNotifications()).toBe(held + 1);
  pressed.press();
  expect(heldNotifications()).toBe(held);
  const closed = rig();
  closed.notify(notice());
  closed.fire("close");
  expect(heldNotifications()).toBe(held);
  const failed = rig();
  failed.notify(notice());
  failed.fire("failed");
  expect(heldNotifications()).toBe(held);
});
