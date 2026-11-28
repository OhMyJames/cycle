import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { FileContent, FileListing, SessionSnapshot, SessionSummary } from "../../src/api.ts";
import { applyUpdate, emptyConversation } from "../../src/model/index.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";
import { openPanel, openTab } from "./panel.ts";
import { renderApp } from "./render-app.tsx";

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
    diff?: boolean;
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
    capabilities: {
      queue: true,
      files: true,
      folders: true,
      fs: options.fs ?? true,
      diff: options.diff ?? false,
    },
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
  const store = await renderApp(script.bridge);
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
  await openTab(user, "Files");
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
    expect(panel().querySelector('[data-slot="files"]')?.textContent).toContain("let x = 1;"),
  );
  // Where it is, in the bar: the folder it is in leads back to the tree, its name is where the person is.
  const where = tab.getByRole("navigation", { name: "Where this file is" });
  expect(where.textContent).toBe("src/main.ts");
  expect(within(where).getByRole("button", { name: "src" })).toBeDefined();
  expect(within(where).getByText("main.ts").getAttribute("aria-current")).toBe("page");
  // The file's lines are numbered and drawn in the panel itself: no card around them, no head with its language.
  const body = panel().querySelector<HTMLElement>('[data-streamdown="code-block-body"]');
  expect(getComputedStyle(body as HTMLElement).borderTopWidth).toBe("0px");
  expect(
    getComputedStyle(body?.querySelector("pre > code > span") as HTMLElement, "::before").content,
  ).toBe("counter(files-line)");
  expect(
    getComputedStyle(panel().querySelector('[data-streamdown="code-block-header"]') as HTMLElement)
      .display,
  ).toBe("none");
  await user.click(tab.getByRole("button", { name: "Back to files" }));
  // Back where it was: the folder still open.
  expect(await tab.findByRole("button", { name: "main.ts" })).toBeDefined();
  // Opening a folder read that folder, not every folder again.
  expect(script.calls.filter(([n]) => n === "listFiles").map(([, p]) => p)).toEqual(["", "src"]);
  expect(tracked()).toEqual([["file_previewed", { kind: "text" }]]);
});

test("Markdown is drawn, an image is shown, and a file with no preview says so", async () => {
  const { user, tracked } = await mount();
  await openTab(user, "Files");
  // Open, not still sliding open: till then the panel's left edge, where "Back to files" is, is cut off.
  await waitFor(() => expect(document.querySelector("[data-slot=split][data-animate]")).toBeNull());
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
  await openTab(user, "Files");
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
  const { user } = await mount({
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
  expect(within(log).queryByRole("button", { name: "src/main.ts" })).toBeNull();
  // Neither a tab of the panel nor a choice in its menu of tabs.
  const tab = within(await openPanel(user));
  expect(tab.getByRole("tab", { name: "Diff" })).toBeDefined();
  expect(tab.queryByRole("tab", { name: "Files" })).toBeNull();
  await user.click(tab.getByRole("button", { name: "Open a tab" }));
  expect(await screen.findByRole("menuitem", { name: "Diff" })).toBeDefined();
  expect(screen.queryByRole("menuitem", { name: "Files" })).toBeNull();
});

test("what git says changed is marked in the tree, and the box finds a file by name wherever it is", async () => {
  const { user, script, tracked } = await mount({ diff: true });
  script.bridge.workspaceStatus = async () => ({
    state: "ok",
    head: "0123456789abcdef0123456789abcdef01234567",
    truncated: false,
    files: [
      { path: "src/main.ts", status: "modified", additions: 3, deletions: 1 },
      { path: "README.md", status: "untracked", additions: 2, deletions: 0 },
      // A repository inside that git does not track: one entry, the folder itself.
      { path: "dist", status: "untracked", folder: true },
    ],
  });
  script.bridge.searchFiles = async (_e, _where, query) => {
    script.calls.push(["searchFiles", query]);
    return query === "zzz"
      ? { root: "/work", entries: [], truncated: false }
      : {
          root: "/work",
          entries: [
            { path: "src/main.ts", kind: "file" },
            { path: "src", kind: "folder" },
          ],
          truncated: false,
        };
  };
  await openTab(user, "Files");
  const tab = within(panel());
  // A file that changed says how, and how much; the folder it is in says something inside did; the rest say nothing.
  const readme = await tab.findByRole("button", { name: /README\.md/ });
  await waitFor(() => expect(readme.textContent).toContain("untracked"));
  expect(readme.textContent).toContain("+2");
  expect(tab.getByRole("button", { name: /^src/ }).textContent).toContain("has changes inside");
  expect(tab.getByRole("button", { name: /^dist/ }).textContent).toContain("has changes inside");
  expect(tab.getByRole("button", { name: /logo\.png/ }).textContent).toBe("logo.png");

  // What is typed is asked of the daemon once the typing stops, and what fits is a row each in place of the tree.
  const box = tab.getByRole("searchbox", { name: "Find a file by name" });
  await user.type(box, "main");
  const found = await tab.findByRole("button", { name: /src\/main\.ts/ });
  expect(found.textContent).toContain("+3");
  expect(tab.queryByRole("button", { name: /README\.md/ })).toBeNull();
  expect(script.calls.filter(([n]) => n === "searchFiles")).toEqual([["searchFiles", "main"]]);
  await user.click(found);
  await waitFor(() =>
    expect(panel().querySelector('[data-slot="files"]')?.textContent).toContain("let x = 1;"),
  );
  // Back, the box is as it was left, and so is what it found. A folder found goes to the tree with it open, and a
  // folder of the file's path does too: what was typed is let go, since the tree is what was asked for.
  await user.click(tab.getByRole("button", { name: "Back to files" }));
  expect((box as HTMLInputElement).value).toBe("main");
  await user.click(await tab.findByRole("button", { name: "src" }));
  expect((box as HTMLInputElement).value).toBe("");
  expect((await tab.findByRole("button", { name: /^src/ })).getAttribute("aria-expanded")).toBe(
    "true",
  );
  await user.type(box, "main");
  await user.click(await tab.findByRole("button", { name: /src\/main\.ts/ }));
  await user.click(
    within(await tab.findByRole("navigation", { name: "Where this file is" })).getByRole("button", {
      name: "src",
    }),
  );
  await waitFor(() => expect((box as HTMLInputElement).value).toBe(""));
  expect(await tab.findByRole("button", { name: /README\.md/ })).toBeDefined();
  await user.type(box, "zzz");
  expect(await tab.findByText("No file or folder has that in its name")).toBeDefined();
  await user.clear(box);
  expect(await tab.findByRole("button", { name: /README\.md/ })).toBeDefined();
  // Counted that the box was used, never what was typed.
  expect(tracked()).toEqual([
    ["files_found", {}],
    ["file_previewed", { kind: "text" }],
    ["files_folder_revealed", { from: "found" }],
    ["file_previewed", { kind: "text" }],
    ["files_folder_revealed", { from: "crumb" }],
  ]);
});

test("each session's Files tab is its own: another session shows its own folder, not this one's", async () => {
  const { user } = await mount({
    sessions: [
      { ...summary("s1"), title: "first" },
      { ...summary("s2"), title: "second" },
    ],
  });
  await openTab(user, "Files");
  expect(await within(panel()).findByRole("button", { name: "src" })).toBeDefined();
  await user.click(await screen.findByRole("option", { name: /second/ }));
  await openTab(user, "Files");
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
  const head = panel().querySelector('[data-slot="files"] > [data-slot="panel-bar"]');
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
    // Opened from the tree first: shown from its top, whole (a file is never shown in part), nothing marked.
    await openTab(user, "Files");
    const tab = within(panel());
    await user.click(await tab.findByRole("button", { name: "src" }));
    await user.click(await tab.findByRole("button", { name: "long.ts" }));
    await waitFor(() => expect(lineOf(1)).toBeDefined());
    expect(panel().querySelector('[data-slot="code-fold"][data-folded]')).toBeNull();
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

const review = (rawInput: unknown) => {
  const u = (update: object) => update as SessionUpdate;
  return [
    u({
      sessionUpdate: "user_message",
      messageId: "m1",
      content: [{ type: "text", text: "review" }],
    }),
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "r1",
      name: "ReportFindings",
      status: "pending",
    }),
    u({ sessionUpdate: "tool_call_update", toolCallId: "r1", status: "completed", rawInput }),
  ];
};

test("a code review the agent reported is a card: the tally, the agent's order, a row opens to when it goes wrong, a path opens in Files", async () => {
  const { user, tracked } = await mount({
    updates: review({
      level: "high",
      findings: [
        {
          file: "/etc/hosts",
          summary: "Outside the folder.",
          failure_scenario: "Never shown in Files.",
          verdict: "PLAUSIBLE",
        },
        {
          file: "src/main.ts",
          line: 1,
          summary: "x is never read, so the assignment is dead and the build warns about it.",
          short_summary: "x is never read",
          failure_scenario: "Build with warnings as errors: it fails.",
          verdict: "CONFIRMED",
          category: "correctness",
        },
        { file: "../up.ts", summary: "Climbs out.", failure_scenario: "<b>loud</b>" },
      ],
    }),
  });
  const log = await screen.findByRole("log", { name: "Conversation" });
  const card = await within(log).findByRole("region", { name: "Code review" });
  expect(card.textContent).toContain("3 findings · 1 confirmed · 1 plausible");
  const rows = within(card).getAllByRole("listitem");
  expect(rows.map((r) => r.querySelector('[data-slot="review-summary"]')?.textContent)).toEqual([
    "Outside the folder.",
    "x is never read",
    "Climbs out.",
  ]);
  // The agent's text is text: nothing in it is markup.
  expect(card.querySelector("b")).toBeNull();
  // Only a path inside the folder is a link.
  expect(within(card).getAllByRole("button", { name: /^Show .* in Files$/ })).toHaveLength(1);
  await user.click(within(card).getByRole("button", { name: /x is never read/ }));
  expect(await within(card).findByText("Build with warnings as errors: it fails.")).toBeDefined();
  expect(within(card).getByText(/assignment is dead/)).toBeDefined();
  await user.click(within(card).getByRole("button", { name: "Show src/main.ts:1 in Files" }));
  await waitFor(() => expect(panel().textContent).toContain("let x = 1;"));
  expect(tracked()[0]).toEqual([
    "file_shown_from_conversation",
    { target: "file", from: "review", line: true },
  ]);
});

test("a review that found nothing says so, and a call that is not a review in shape is a call", async () => {
  await mount({ updates: review({ findings: [] }) });
  const log = await screen.findByRole("log", { name: "Conversation" });
  const card = await within(log).findByRole("region", { name: "Code review" });
  expect(card.textContent).toContain("No issues found");
  expect(within(card).queryAllByRole("listitem")).toHaveLength(0);
  cleanup();
  await mount({ updates: review({ findings: [{ file: "a.ts" }] }) });
  const again = await screen.findByRole("log", { name: "Conversation" });
  await within(again).findByText("review");
  expect(within(again).queryByRole("region", { name: "Code review" })).toBeNull();
  expect(again.querySelector('[data-kind="tool"]')).not.toBeNull();
});

/**
 * The code-review skill, as a session records it (CYCL-216): the Skill call with its input, then its result, whose
 * findings are a bare array in a ```json block after the skill tool's own line. The words are made up.
 */
const skillReview = (result: string | undefined) => {
  const u = (update: object) => update as SessionUpdate;
  return [
    u({
      sessionUpdate: "user_message",
      messageId: "m1",
      content: [{ type: "text", text: "review" }],
    }),
    u({ sessionUpdate: "tool_call_update", toolCallId: "s1", name: "Skill", status: "pending" }),
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "s1",
      name: "Skill",
      kind: "other",
      status: "in_progress",
      rawInput: { skill: "code-review", args: "high main...HEAD" },
    }),
    ...(result === undefined
      ? []
      : [
          u({
            sessionUpdate: "tool_call_update",
            toolCallId: "s1",
            status: "completed",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: `Skill "code-review" completed (forked execution).\n\nResult:\n${result}`,
                },
              },
            ],
          }),
        ]),
  ];
};

test("the code-review skill's result is a card, its words above; a finding's line opens the file there", async () => {
  const findings = [
    {
      file: "src/long.ts",
      line: 90,
      summary: "line90 is exported but never read.",
      failure_scenario: "Tree-shaking keeps it anyway.",
    },
    { file: "src/main.ts", summary: "x is never read.", failure_scenario: "<b>loud</b>" },
  ];
  const { user, tracked } = await mount({
    updates: skillReview(
      `Reviewed **two files** on the branch; see \`src/long.ts:40\`.\n\n\`\`\`json\n${JSON.stringify(findings, null, 2)}\n\`\`\``,
    ),
  });
  fitWindow();
  const log = await screen.findByRole("log", { name: "Conversation" });
  const card = await within(log).findByRole("region", { name: "Code review" });
  expect(card.textContent).toContain("2 findings");
  // What the skill said, as a reply says it; none of the skill tool's own line, nor the JSON.
  const prose = card.querySelector('[data-slot="review-prose"]') as HTMLElement;
  expect(prose.querySelector('[data-streamdown="strong"]')?.textContent).toBe("two files");
  expect(card.textContent).not.toContain("forked execution");
  expect(card.textContent).not.toContain("failure_scenario");
  expect(card.querySelector("b")).toBeNull();
  // Not drawn as the call as well.
  expect(log.querySelector('[data-kind="tool"]')).toBeNull();

  await user.click(within(card).getByRole("button", { name: "Show src/long.ts:90 in Files" }));
  await waitFor(() => expect(seen(lineOf(90))).toBe(true));
  await waitFor(() => expect(markOf()).not.toBeNull());
  expect(Math.abs(topOf(markOf()) - topOf(lineOf(90)))).toBeLessThan(1);
  // No line: the file from its top, nothing marked.
  await user.click(within(card).getByRole("button", { name: "Show src/main.ts in Files" }));
  await waitFor(() => expect(panel().textContent).toContain("let x = 1;"));
  expect(markOf()).toBeNull();
  // A file the words name opens there too, counted as the review's.
  await user.click(within(prose).getByRole("link", { name: "src/long.ts:40" }));
  await waitFor(() => expect(seen(lineOf(40))).toBe(true));
  expect(tracked().filter(([event]) => event === "file_shown_from_conversation")).toEqual([
    ["file_shown_from_conversation", { target: "file", from: "review", line: true }],
    ["file_shown_from_conversation", { target: "file", from: "review", line: false }],
    ["file_shown_from_conversation", { target: "file", from: "review", line: true }],
  ]);
});

test("the code-review skill shows nothing while it runs; a result with no findings block is its call", async () => {
  await mount({ updates: skillReview(undefined) });
  const log = await screen.findByRole("log", { name: "Conversation" });
  await within(log).findByText("review");
  expect(log.querySelector('[data-kind="tool"]')).toBeNull();
  expect(within(log).queryByRole("region", { name: "Code review" })).toBeNull();
  cleanup();

  await mount({ updates: skillReview("I found nothing to report.\n\n```json\n[]\n```") });
  const none = await screen.findByRole("log", { name: "Conversation" });
  const card = await within(none).findByRole("region", { name: "Code review" });
  expect(card.textContent).toContain("No issues found");
  expect(card.textContent).toContain("I found nothing to report.");
  cleanup();

  for (const result of ["(none)\n\nOnly the version changed.", "```json\n[{ broken\n```"]) {
    await mount({ updates: skillReview(result) });
    const again = await screen.findByRole("log", { name: "Conversation" });
    await within(again).findByText("review");
    await waitFor(() => expect(again.querySelector('[data-kind="tool"]')).not.toBeNull());
    expect(within(again).queryByRole("region", { name: "Code review" })).toBeNull();
    cleanup();
  }
});
