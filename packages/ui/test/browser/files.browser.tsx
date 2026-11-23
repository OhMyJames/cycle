import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
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
  src: [{ name: "main.ts", kind: "file", size: 11 }],
};

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
    ["file_shown_from_conversation", { target: "file", from: "mention" }],
    ["file_previewed", { kind: "text" }],
    ["file_shown_from_conversation", { target: "file", from: "tool" }],
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
    { target: "file", from: "review" },
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
