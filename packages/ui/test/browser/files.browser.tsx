import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { FileContent, FileListing, SessionSnapshot, SessionSummary } from "../../src/api.ts";
import { applyUpdate, emptyConversation } from "../../src/model/index.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const FOLDERS: Record<string, FileListing["entries"]> = {
  "": [
    { name: "src", kind: "folder" },
    { name: "dist", kind: "folder", ignored: true },
    { name: "README.md", kind: "file", size: 20 },
    { name: "logo.png", kind: "file", size: 4 },
    { name: "app.bin", kind: "file", size: 4 },
    { name: "away", kind: "other", link: true },
  ],
  src: [
    { name: "main.ts", kind: "file", size: 11 },
    { name: "long.ts", kind: "file", size: 4000 },
  ],
};

/** Long enough to be shown in part (`code-fold`), and to scroll in the panel. */
const LONG = `${Array.from({ length: 120 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join("\n")}\n`;

const FILES: Record<string, FileContent> = {
  "README.md": {
    path: "README.md",
    size: 20,
    mtimeMs: 1,
    kind: "text",
    text: "# Hello\n\nSome *words*.\n",
    offset: 0,
    next: null,
  },
  "src/main.ts": {
    path: "src/main.ts",
    size: 11,
    mtimeMs: 1,
    kind: "text",
    text: "let x = 1;\n",
    offset: 0,
    next: null,
  },
  "src/long.ts": {
    path: "src/long.ts",
    size: LONG.length,
    mtimeMs: 1,
    kind: "text",
    text: LONG,
    offset: 0,
    next: null,
  },
  "logo.png": {
    path: "logo.png",
    size: 4,
    mtimeMs: 1,
    kind: "image",
    mimeType: "image/png",
    data: "iVBORw==",
  },
  "app.bin": { path: "app.bin", size: 4, mtimeMs: 1, kind: "binary" },
};

const mount = async (
  options: {
    fs?: boolean;
    updates?: SessionUpdate[];
    failList?: boolean;
    sessions?: SessionSummary[];
  } = {},
) => {
  const updates = options.updates ?? [];
  const snapshot = (): SessionSnapshot => ({
    conversation: updates.reduce((c, u) => applyUpdate(c, u), emptyConversation()),
    permissions: [],
    version: updates.length,
  });
  const script = fakeBridge({
    connected: true,
    snapshot,
    capabilities: { queue: true, files: true, folders: true, fs: options.fs ?? true },
  });
  if (options.sessions !== undefined) {
    const sessions = options.sessions;
    script.bridge.sessions = async () => sessions;
  }
  let failing = options.failList === true;
  script.bridge.listFiles = async (_e, sessionId, path) => {
    script.calls.push(["listFiles", path]);
    if (failing) throw new Error("EACCES: permission denied");
    if (sessionId === "s2")
      return {
        root: "/other",
        path,
        entries: [{ name: "two.txt", kind: "file" }],
        truncated: false,
      };
    return { root: "/work", path, entries: FOLDERS[path] ?? [], truncated: false };
  };
  script.bridge.readFile = async (_e, _s, path) => {
    script.calls.push(["readFile", path]);
    const file = FILES[path];
    if (file === undefined) throw new Error("No such file or folder");
    return file;
  };
  const store = new AppStore(script.bridge);
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole("option", { name: options.sessions !== undefined ? /first/ : /work/ }),
  );
  const tracked = () =>
    script.calls
      .filter(([name, event]) => name === "track" && String(event).startsWith("file"))
      .map(([, event, props]) => [event, props]);
  return { store, user, script, tracked, stopFailing: () => (failing = false) };
};

const panel = () => document.querySelector('[data-slot="side-panel"]') as HTMLElement;

test("the Files button opens the session's folder; folders open in place, a file opens in place of the tree", async () => {
  const { user, script, tracked } = await mount();
  await user.click(await screen.findByRole("button", { name: "Show files" }));
  await waitFor(() => expect(panel()).not.toBeNull());
  const tab = within(panel());
  expect(tab.getByRole("tab", { name: "Files", selected: true })).toBeDefined();
  const src = await tab.findByRole("button", { name: "src" });
  expect(src.getAttribute("aria-expanded")).toBe("false");
  // Ignored by git: there, and said, but quieter.
  expect(tab.getByRole("button", { name: /dist/ }).hasAttribute("data-ignored")).toBe(true);
  // A link out of the folder is listed, not a button.
  expect(tab.queryByRole("button", { name: "away" })).toBeNull();
  expect(tab.getByText("away")).toBeDefined();

  await user.click(src);
  expect(await tab.findByRole("button", { name: "main.ts" })).toBeDefined();
  expect(src.getAttribute("aria-expanded")).toBe("true");
  await user.click(tab.getByRole("button", { name: "main.ts" }));
  await waitFor(() =>
    expect(tab.getByText("src/main.ts").closest('[data-slot="files"]')?.textContent).toContain(
      "let x = 1;",
    ),
  );
  expect(tab.getByText("src/main.ts")).toBeDefined();
  await user.click(tab.getByRole("button", { name: "Back to files" }));
  // Back where it was: the folder still open.
  expect(await tab.findByRole("button", { name: "main.ts" })).toBeDefined();
  // Opening a folder read that folder, not every folder again.
  expect(script.calls.filter(([n]) => n === "listFiles").map(([, p]) => p)).toEqual(["", "src"]);
  expect(tracked()).toEqual([["file_previewed", { kind: "text" }]]);
});

test("Markdown is drawn, an image is shown, and a file with no preview says so", async () => {
  const { user, tracked } = await mount();
  await user.click(await screen.findByRole("button", { name: "Show files" }));
  const tab = within(panel());
  await user.click(await tab.findByRole("button", { name: "README.md" }));
  expect(await tab.findByRole("heading", { name: "Hello" })).toBeDefined();
  await user.click(tab.getByRole("button", { name: "Back to files" }));
  await user.click(await tab.findByRole("button", { name: "logo.png" }));
  const image = (await tab.findByRole("img", { name: "logo.png" })) as HTMLImageElement;
  expect(image.src.startsWith("data:image/png;base64,")).toBe(true);
  await user.click(tab.getByRole("button", { name: "Back to files" }));
  await user.click(await tab.findByRole("button", { name: "app.bin" }));
  expect(await tab.findByText("No preview for this kind of file")).toBeDefined();
  expect(tracked().map(([, props]) => props)).toEqual([
    { kind: "markdown" },
    { kind: "image" },
    { kind: "binary" },
  ]);
});

test("a folder that cannot be read says why, in the daemon's words, and can be read again", async () => {
  const { user, stopFailing } = await mount({ failList: true });
  await user.click(await screen.findByRole("button", { name: "Show files" }));
  const tab = within(panel());
  expect(await tab.findByRole("alert")).toBeDefined();
  expect(tab.getByText("The folder could not be read")).toBeDefined();
  expect(tab.getByText("EACCES: permission denied")).toBeDefined();
  stopFailing();
  await user.click(tab.getByRole("button", { name: "Retry" }));
  expect(await tab.findByRole("button", { name: "src" })).toBeDefined();
});

test("a file the agent read, and a file named with @, are shown in Files from the conversation", async () => {
  const u = (update: object) => update as SessionUpdate;
  const { user, tracked } = await mount({
    updates: [
      u({
        sessionUpdate: "user_message",
        messageId: "m1",
        content: [
          { type: "text", text: "Look at @src/main.ts please" },
          {
            type: "resource_link",
            name: "main.ts",
            uri: "file:///work/src/main.ts",
            _meta: { "cycle/mention": "src/main.ts" },
          },
        ],
      }),
      u({ sessionUpdate: "tool_call_update", toolCallId: "t1", name: "Read", status: "pending" }),
      u({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        kind: "read",
        rawInput: { file_path: "/work/README.md" },
        locations: [{ path: "/work/README.md" }],
      }),
    ],
  });
  const log = await screen.findByRole("log", { name: "Conversation" });
  await user.click(await within(log).findByRole("button", { name: "src/main.ts" }));
  await waitFor(() => expect(panel()).not.toBeNull());
  await waitFor(() => expect(panel().textContent).toContain("let x = 1;"));
  // The tool's line opens to a link to what it read.
  await user.click(within(log).getByRole("button", { name: /README\.md/ }));
  await user.click(await within(log).findByRole("button", { name: "Show in Files" }));
  expect(await within(panel()).findByRole("heading", { name: "Hello" })).toBeDefined();
  expect(tracked()).toEqual([
    ["file_shown_from_conversation", { target: "file", from: "mention", line: false }],
    ["file_previewed", { kind: "text" }],
    ["file_shown_from_conversation", { target: "file", from: "tool", line: false }],
    ["file_previewed", { kind: "markdown" }],
  ]);
});

test("a daemon that cannot show files is not offered Files, and a mention stays words", async () => {
  const u = (update: object) => update as SessionUpdate;
  await mount({
    fs: false,
    updates: [
      u({
        sessionUpdate: "user_message",
        messageId: "m1",
        content: [
          { type: "text", text: "Look at @src/main.ts" },
          {
            type: "resource_link",
            name: "main.ts",
            uri: "file:///work/src/main.ts",
            _meta: { "cycle/mention": "src/main.ts" },
          },
        ],
      }),
    ],
  });
  const log = await screen.findByRole("log", { name: "Conversation" });
  expect(await within(log).findByText(/Look at @src\/main\.ts/)).toBeDefined();
  expect(screen.queryByRole("button", { name: "Show files" })).toBeNull();
  expect(within(log).queryByRole("button", { name: "src/main.ts" })).toBeNull();
});

test("each session's Files tab is its own: another session shows its own folder, not this one's", async () => {
  const { user } = await mount({
    sessions: [
      { ...summary("s1"), title: "first" },
      { ...summary("s2"), title: "second" },
    ],
  });
  await user.click(await screen.findByRole("button", { name: "Show files" }));
  expect(await within(panel()).findByRole("button", { name: "src" })).toBeDefined();
  await user.click(await screen.findByRole("option", { name: /second/ }));
  await user.click(await screen.findByRole("button", { name: "Show files" }));
  await waitFor(() => expect(panel()).not.toBeNull());
  expect(await within(panel()).findByRole("button", { name: "two.txt" })).toBeDefined();
  expect(within(panel()).queryByRole("button", { name: "src" })).toBeNull();
});

const say = (text: string) =>
  ({
    sessionUpdate: "agent_message",
    messageId: "a1",
    content: [{ type: "text", text }],
  }) as SessionUpdate;

/** Line `n` of the file shown (Shiki's lines are an element each). */
const lineOf = (n: number) =>
  panel().querySelector('[data-streamdown="code-block-body"] pre > code')?.children[n - 1] as
    | HTMLElement
    | undefined;
/** The mark over the lines gone to. */
const markOf = () => panel().querySelector<HTMLElement>('[data-slot="files-line-mark"]');

/** Seen in the panel, below the file's sticky head. */
const seen = (element: HTMLElement | undefined) => {
  if (element === undefined) return false;
  const at = element.getBoundingClientRect();
  const head = panel().querySelector('[data-slot="files"] > [data-slot="files-head"]');
  const top = head?.getBoundingClientRect().bottom ?? panel().getBoundingClientRect().top;
  return at.top >= top - 1 && at.bottom <= panel().getBoundingClientRect().bottom + 1;
};

const scrollerOf = (element: HTMLElement): HTMLElement => {
  for (let at = element.parentElement; at !== null; at = at.parentElement)
    if (at.scrollHeight > at.clientHeight && getComputedStyle(at).overflowY !== "visible")
      return at;
  throw new Error("Nothing scrolls the file");
};

const topOf = (element: HTMLElement | null | undefined) =>
  element?.getBoundingClientRect().top ?? Number.NaN;

/** The window's height, as #root has it in the app: the panel scrolls inside it, not the page. */
const fitWindow = () => {
  const root = document.querySelector('[data-slot="app"]')?.parentElement;
  if (root instanceof HTMLElement) root.style.height = "100%";
};

test("a file named with lines opens at them, marked for a moment; named again while it is shown, it is gone to again", async () => {
  const { user, script, tracked } = await mount({
    updates: [
      say("See [the end](src/long.ts#L100-L102), `src/long.ts:40` and [main](src/main.ts)."),
    ],
  });
  fitWindow();
  const log = await screen.findByRole("log", { name: "Conversation" });
  await user.click(await within(log).findByRole("link", { name: "the end" }));
  await waitFor(() => expect(panel()).not.toBeNull());
  // The file is long enough to be shown in part; shown at a line, it is shown whole, and the lines are in view.
  await waitFor(() => expect(seen(lineOf(100))).toBe(true));
  expect(seen(lineOf(1))).toBe(false);
  expect(panel().querySelector('[data-slot="code-fold"][data-folded]')).toBeNull();
  // The mark covers lines 100 to 102, not more.
  await waitFor(() => expect(markOf()).not.toBeNull());
  expect(Math.abs(topOf(markOf()) - topOf(lineOf(100)))).toBeLessThan(1);
  const bottom =
    (markOf()?.getBoundingClientRect().bottom ?? 0) -
    (lineOf(102)?.getBoundingClientRect().bottom ?? 0);
  expect(Math.abs(bottom)).toBeLessThan(1);
  expect(markOf()?.getAttribute("aria-hidden")).toBe("true");

  // The file already shown, scrolled away: the keyboard names another line, and the file is not read again.
  const scroller = scrollerOf(lineOf(1) as HTMLElement);
  scroller.scrollTo({ top: 0, behavior: "instant" });
  await waitFor(() => expect(seen(lineOf(100))).toBe(false));
  const before = markOf();
  within(log).getByRole("link", { name: "src/long.ts:40" }).focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(seen(lineOf(40))).toBe(true));
  // Marked again: a new mark, over line 40.
  await waitFor(() => expect(markOf()).not.toBe(before));
  expect(Math.abs(topOf(markOf()) - topOf(lineOf(40)))).toBeLessThan(1);
  // The same lines again, scrolled away: gone to again.
  scroller.scrollTo({ top: 0, behavior: "instant" });
  await user.click(within(log).getByRole("link", { name: "the end" }));
  await waitFor(() => expect(seen(lineOf(100))).toBe(true));
  expect(script.calls.filter(([n, p]) => n === "readFile" && p === "src/long.ts")).toHaveLength(1);
  // The mark goes after a moment.
  await waitFor(() => expect(markOf()).toBeNull(), { timeout: 3000 });

  // Without a line, as before: the file shown from its top, nothing marked.
  await user.click(within(log).getByRole("link", { name: "main" }));
  await waitFor(() => expect(panel().textContent).toContain("let x = 1;"));
  expect(markOf()).toBeNull();
  expect(tracked().filter(([event]) => event === "file_shown_from_conversation")).toEqual([
    ["file_shown_from_conversation", { target: "file", from: "message", line: true }],
    ["file_shown_from_conversation", { target: "file", from: "message", line: true }],
    ["file_shown_from_conversation", { target: "file", from: "message", line: true }],
    ["file_shown_from_conversation", { target: "file", from: "message", line: false }],
  ]);
});

test("a file already shown from its top, named with a line, scrolls there; with reduced motion, at once", async () => {
  const reduce = vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        onchange: null,
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
  const scrolls = vi.spyOn(HTMLElement.prototype, "scrollTo");
  try {
    const { user } = await mount({ updates: [say("Look at `src/long.ts:90`.")] });
    fitWindow();
    // Opened from the tree first: shown from its top, in part, nothing marked.
    await user.click(await screen.findByRole("button", { name: "Show files" }));
    const tab = within(panel());
    await user.click(await tab.findByRole("button", { name: "src" }));
    await user.click(await tab.findByRole("button", { name: "long.ts" }));
    await waitFor(() => expect(lineOf(1)).toBeDefined());
    expect(panel().querySelector('[data-slot="code-fold"][data-folded]')).not.toBeNull();
    expect(markOf()).toBeNull();
    const log = await screen.findByRole("log", { name: "Conversation" });
    await user.click(within(log).getByRole("link", { name: "src/long.ts:90" }));
    await waitFor(() => expect(seen(lineOf(90))).toBe(true));
    expect(markOf()).not.toBeNull();
    expect(scrolls).toHaveBeenCalledWith(expect.objectContaining({ behavior: "instant" }));
    expect(scrolls).not.toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
  } finally {
    reduce.mockRestore();
    scrolls.mockRestore();
  }
});
