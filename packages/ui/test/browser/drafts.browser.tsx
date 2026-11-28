import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { SessionSummary } from "../../src/api.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";
import { boxText, press, ready, write } from "./box.ts";
import { mountApp } from "./mount.tsx";
import { renderApp } from "./render-app.tsx";

afterEach(() => {
  cleanup();
  // Text is kept in the page's storage; each test starts with none.
  localStorage.clear();
});

const sessions: SessionSummary[] = [
  { ...summary("s1"), title: "alpha", lastSeq: 2 },
  { ...summary("s2"), title: "beta", lastSeq: 1 },
];

const mount = async () => {
  const app = await mountApp(
    { capabilities: { queue: true, files: true, folders: true, sessionMentions: true } },
    {
      configure: (script) => {
        script.bridge.sessions = async () => sessions;
        script.bridge.searchFiles = async (_host, _session, query) => ({
          root: "/work",
          entries: query.startsWith("s")
            ? [
                { path: "src/main.ts", kind: "file" as const },
                { path: "src/lib", kind: "folder" as const },
              ]
            : [],
          truncated: false,
        });
        script.bridge.agents = async () => [
          {
            id: "fake",
            name: "Fake",
            available: true,
            configSchema: {},
            promptCapabilities: { image: {} },
          },
        ];
      },
    },
  );
  const open = async (title: string) => {
    await app.user.click(await screen.findByRole("option", { name: new RegExp(title) }));
    const box = await screen.findByRole("textbox", { name: "Message" });
    await ready(box);
    return box;
  };
  return { ...app, open };
};

const png = (name: string) =>
  new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: "image/png" });
const picker = () => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("no file input");
  return input;
};

test("what is written in one session is there when the person comes back to it, and not in another", async () => {
  const { open } = await mount();
  await write(await open("alpha"), "half a sentence");
  const beta = await open("beta");
  expect(boxText(beta)).toBe("");
  await write(beta, "something else");
  expect(boxText(await open("alpha"))).toBe("half a sentence");
  expect(boxText(await open("beta"))).toBe("something else");
});

test("sending clears the draft of that session only", async () => {
  const { open, named } = await mount();
  await write(await open("alpha"), "to send");
  await write(await open("beta"), "to keep");
  await press(await open("alpha"), "Enter");
  await waitFor(() => expect(named("prompt")).toHaveLength(1));
  expect(boxText(await open("alpha"))).toBe("");
  expect(boxText(await open("beta"))).toBe("to keep");
});

test("the images attached to a session stay with it while another is open", async () => {
  const { user, open } = await mount();
  await open("alpha");
  await user.upload(picker(), png("one.png"));
  expect(await screen.findByRole("button", { name: "Remove one.png" })).toBeTruthy();
  await open("beta");
  expect(screen.queryByRole("button", { name: "Remove one.png" })).toBeNull();
  await open("alpha");
  expect(await screen.findByRole("button", { name: "Remove one.png" })).toBeTruthy();
});

test("an image still being read when the person goes to another session lands in the one it was added to", async () => {
  const { user, open } = await mount();
  await open("alpha");
  // A file that is read when the test says so.
  let finish: (bytes: ArrayBuffer) => void = () => {};
  const slow = png("slow.png");
  Object.defineProperty(slow, "arrayBuffer", {
    value: () =>
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      }),
  });
  await user.upload(picker(), slow);
  await open("beta");
  await act(async () => finish(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer));
  // It is not in the session that is open now...
  expect(screen.queryByRole("button", { name: "Remove slow.png" })).toBeNull();
  // ...but in the one it was added to.
  await open("alpha");
  expect(await screen.findByRole("button", { name: "Remove slow.png" })).toBeTruthy();
});

test("an image still being read when its session is deleted does not bring the draft back", async () => {
  const { store, user, open } = await mount();
  await open("alpha");
  let finish: (bytes: ArrayBuffer) => void = () => {};
  const slow = png("slow.png");
  Object.defineProperty(slow, "arrayBuffer", {
    value: () =>
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      }),
  });
  await user.upload(picker(), slow);
  await act(() => store.deleteSession("s1"));
  await act(async () => finish(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer));
  expect(store.drafts.get("local:s1").attachments).toEqual([]);
});

test("a message that could not be sent is put back in the box, with the failure shown", async () => {
  const { open, bridge } = await mount();
  bridge.prompt = async () => {
    throw new Error("The daemon is not reachable");
  };
  const box = await open("alpha");
  await write(box, "do not lose me");
  await press(box, "Enter");
  // The failure is shown, and the text is in the box again.
  await screen.findByText(/The daemon is not reachable/);
  await waitFor(() => expect(boxText(box)).toBe("do not lose me"));
});

test("what was written is still there when the app starts again", async () => {
  const first = await mount();
  await write(await first.open("alpha"), "half a sentence");
  cleanup();
  const second = await mount();
  expect(boxText(await second.open("alpha"))).toBe("half a sentence");
});

const chips = (box: HTMLElement) => [...box.querySelectorAll('[data-slot="mention-chip"]')];

/** Types `@query`, takes the `row`th option of the menu. */
const pickAt = async (box: HTMLElement, query: string, row: RegExp) => {
  await write(box, `@${query}`);
  const menu = await screen.findByRole("listbox", { name: "Files, folders and sessions" });
  await userEvent.click(await within(menu).findByRole("option", { name: row }));
};

test("a file, a folder and a session picked with @ are each one block in the box", async () => {
  const { open, store } = await mount();
  const box = await open("alpha");
  await pickAt(box, "s", /main\.ts/);
  await waitFor(() => expect(chips(box)).toHaveLength(1));
  await pickAt(box, "s", /lib/);
  await waitFor(() => expect(chips(box)).toHaveLength(2));
  await pickAt(box, "bet", /beta/);
  await waitFor(() => expect(chips(box)).toHaveLength(3));
  expect(chips(box).map((c) => [c.getAttribute("data-kind"), c.textContent])).toEqual([
    ["file", "src/main.ts"],
    ["folder", "src/lib/"],
    ["session", "beta"],
  ]);
  expect(chips(box).every((c) => c.querySelector("svg") !== null)).toBe(true);
  // The draft's words are as they were: `@path` and a space for each.
  expect(boxText(box)).toBe("@src/main.ts @src/lib/ @beta ");
  expect(store.drafts.get("local:s1").mentions).toHaveLength(3);
});

test("one key takes a whole block out: its @name leaves the text, and its link is not sent; the other blocks' are", async () => {
  const { open, named, store } = await mount();
  const box = await open("alpha");
  await pickAt(box, "s", /main\.ts/);
  await pickAt(box, "bet", /beta/);
  await waitFor(() => expect(chips(box)).toHaveLength(2));
  // The caret is after the session's block and the space; one Backspace takes the space, the next the whole block.
  await userEvent.keyboard("{Backspace}{Backspace}");
  await waitFor(() => expect(chips(box)).toHaveLength(1));
  expect(boxText(box)).toBe("@src/main.ts ");
  expect(store.drafts.get("local:s1").text).toBe("@src/main.ts ");
  await write(box, "please");
  await press(box, "Enter");
  await waitFor(() => expect(named("prompt")).toHaveLength(1));
  const blocks = named("prompt")[0]?.[3] as { type: string; uri?: string }[];
  expect(blocks.map((b) => [b.type, b.uri])).toEqual([
    ["text", undefined],
    ["resource_link", "file:///work/src/main.ts"],
  ]);
});

test("a draft that comes back shows the mentions it holds as blocks, and other @words as words", async () => {
  const { open } = await mount();
  const box = await open("alpha");
  await pickAt(box, "s", /main\.ts/);
  await write(box, "and @nobody");
  await waitFor(() => expect(chips(box)).toHaveLength(1));
  await open("beta");
  const again = await open("alpha");
  await waitFor(() => expect(chips(again)).toHaveLength(1));
  expect(boxText(again)).toBe("@src/main.ts and @nobody");
});

test("a long @ session picked in the composer truncates to 20 chars with ... and shows its full name on hover", async () => {
  const longTitle =
    "帮我看一下 咱们现在 itsaplan 里面，有哪些 workitem 过期了或者 现在状态已经不对了的 workitem";
  const script = fakeBridge({
    connected: true,
    capabilities: { queue: true, files: true, folders: true, sessionMentions: true },
  });
  script.bridge.sessions = async () => [
    { ...summary("s1"), title: "alpha", lastSeq: 2 },
    { ...summary("s2"), title: longTitle, lastSeq: 1 },
  ];
  script.bridge.searchFiles = async () => ({ root: "/work", entries: [], truncated: false });
  await renderApp(script.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: /alpha/ }));
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await pickAt(box, "itsaplan", /itsaplan/);
  await waitFor(() => expect(chips(box)).toHaveLength(1));
  const chip = chips(box)[0] as HTMLElement;
  expect(chip.getAttribute("data-kind")).toBe("session");
  expect(chip.textContent).toBe("帮我看一下 咱们现在 itsaplan...");
  // A non-interactive chip inside the editor carries neither button type nor ARIA-prohibited aria-labelledby.
  expect(chip.hasAttribute("type")).toBe(false);
  expect(chip.hasAttribute("aria-labelledby")).toBe(false);
  // Full session name (> 60 chars) appears in the tooltip on hover.
  await user.hover(chip);
  const tip = await screen.findByRole("tooltip");
  expect(tip.textContent).toBe(longTitle);
  // Draft text still carries the full @label for sending.
  expect(boxText(box)).toContain("workitem");
  // Switching sessions and coming back keeps the full session name on the restored chip, and Backspace deletes it whole.
  await user.click(await screen.findByRole("option", { name: /itsaplan/ }));
  await user.click(await screen.findByRole("option", { name: /alpha/ }));
  const restoredBox = await screen.findByRole("textbox", { name: "Message" });
  await ready(restoredBox);
  await waitFor(() => expect(chips(restoredBox)).toHaveLength(1));
  const restoredChip = chips(restoredBox)[0] as HTMLElement;
  expect(restoredChip.textContent).toBe("帮我看一下 咱们现在 itsaplan...");
  await user.hover(restoredChip);
  await waitFor(() => expect(screen.getByRole("tooltip").textContent).toBe(longTitle));
  await user.click(restoredBox);
  await userEvent.keyboard("{End}{Backspace}{Backspace}");
  await waitFor(() => expect(chips(restoredBox)).toHaveLength(0));
});
