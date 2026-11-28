import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { SessionSnapshot, WorkspaceStatus } from "../../src/api.ts";
import { applyUpdate, emptyConversation } from "../../src/model/index.ts";
import { fakeBridge } from "../fake-bridge.ts";
import { openTab } from "./panel.ts";
import { renderApp } from "./render-app.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const u = (update: object) => update as SessionUpdate;
const PATCH = "@@ -1,1 +1,2 @@\n-old line\n+new line\n+another\n";
const edit = (id: string, path: string) => [
  u({ sessionUpdate: "tool_call_update", toolCallId: id, name: "Edit", status: "pending" }),
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: id,
    status: "completed",
    content: [
      {
        type: "diff",
        changes: [{ operation: "modify", path }],
        patch: { format: "git_patch", text: PATCH },
      },
    ],
  }),
];
const ask = (id: string, text: string) =>
  u({ sessionUpdate: "user_message", messageId: id, content: [{ type: "text", text }] });

const mount = async (
  options: {
    updates?: SessionUpdate[];
    diff?: boolean;
    status?: () => Promise<WorkspaceStatus>;
  } = {},
) => {
  const updates = options.updates ?? [];
  const snapshot = (): SessionSnapshot => ({
    conversation: updates.reduce((c, x) => applyUpdate(c, x), emptyConversation()),
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
      fs: true,
      diff: options.diff ?? false,
    },
  });
  if (options.status !== undefined) script.bridge.workspaceStatus = options.status;
  script.bridge.workspaceFile = async (_e, _s, path) => ({
    path,
    patch: `diff --git a/${path} b/${path}\n${PATCH}`,
    truncated: false,
    binary: false,
  });
  const store = await renderApp(script.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: /work/ }));
  await screen.findByRole("log", { name: "Conversation" });
  const tracked = () =>
    script.calls
      .filter(([name, event]) => name === "track" && String(event).startsWith("diff"))
      .map(([, event, props]) => [event, props]);
  return { store, user, script, tracked };
};

const panel = () => document.querySelector('[data-slot="side-panel"]') as HTMLElement;

test("this session's edits, by turn, the latest first: each file opens to its change and leads back to its call", async () => {
  const { user, tracked } = await mount({
    updates: [
      ask("m1", "Fix the login bug"),
      ...edit("t1", "/work/src/login.ts"),
      u({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }),
      ask("m2", "Update the docs"),
      ...edit("t2", "/work/README.md"),
    ],
  });
  await openTab(user, "Diff");
  await waitFor(() => expect(panel()).not.toBeNull());
  const tab = within(panel());
  expect(tab.getByRole("tab", { name: "Diff", selected: true })).toBeDefined();
  // Without a daemon that compares, there is one view, and no choice of it.
  expect(tab.queryByRole("radio", { name: "Workspace" })).toBeNull();
  expect(tab.getByText(/Changes made by commands are not included/)).toBeDefined();
  expect(tab.getAllByRole("heading").map((h) => h.textContent)).toEqual([
    "Update the docs",
    "Fix the login bug",
  ]);
  const row = tab.getByRole("button", { name: /src\/login\.ts/ });
  expect(row.textContent).toContain("+2");
  // The bar says how much changed in all: two edits of +2 −1.
  const bar = panel().querySelector('[data-slot="panel-bar"]') as HTMLElement;
  expect(bar.textContent).toContain("+4");
  expect(bar.textContent).toContain("−2");
  await user.click(row);
  expect(await tab.findByText("new line")).toBeDefined();
  await user.click(tab.getByRole("button", { name: "Show in conversation" }));
  expect(tracked()).toEqual([
    ["diff_file_opened", { view: "session" }],
    ["diff_edit_revealed", {}],
  ]);
});

test("the bar opens every file or closes them all, and sets whether long lines wrap", async () => {
  const { user, tracked } = await mount({
    updates: [
      ask("m1", "Fix the login bug"),
      ...edit("t1", "/work/src/login.ts"),
      ...edit("t2", "/work/README.md"),
    ],
  });
  await openTab(user, "Diff");
  const tab = within(panel());
  const rows = () => tab.getAllByRole("button", { name: /login\.ts|README\.md/ });
  await waitFor(() => expect(rows()).toHaveLength(2));
  await user.click(tab.getByRole("button", { name: "Expand all files" }));
  expect(rows().map((r) => r.getAttribute("aria-expanded"))).toEqual(["true", "true"]);
  // A change is the panel's width, its lines kept to a line each until Wrap is on.
  const text = () => panel().querySelector('[data-slot="diff-text"]') as HTMLElement;
  expect(getComputedStyle(text()).whiteSpace).toBe("pre");
  const wrap = tab.getByRole("button", { name: "Wrap long lines" });
  expect(wrap.getAttribute("aria-pressed")).toBe("false");
  await user.click(wrap);
  expect(wrap.getAttribute("aria-pressed")).toBe("true");
  expect(getComputedStyle(text()).whiteSpace).toBe("pre-wrap");
  // One open is enough for the button to close them all.
  await user.click(rows()[0] as HTMLElement);
  await user.click(tab.getByRole("button", { name: "Collapse all files" }));
  expect(rows().map((r) => r.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
  expect(tab.getByRole("button", { name: "Expand all files" })).toBeDefined();
  expect(tracked()).toEqual([
    ["diff_all_toggled", { open: true, view: "session" }],
    ["diff_wrap_toggled", { wrap: true }],
    ["diff_all_toggled", { open: false, view: "session" }],
  ]);
});

test("a session with no edits says where they will show", async () => {
  const { user } = await mount({ updates: [ask("m1", "Just a question")] });
  await openTab(user, "Diff");
  expect(await within(panel()).findByText("No edits in this session yet")).toBeDefined();
});

test("the workspace view lists what differs from the last commit, and a file opens to its patch", async () => {
  const { user, tracked } = await mount({
    diff: true,
    status: async () => ({
      state: "ok",
      head: "0123456789abcdef0123456789abcdef01234567",
      truncated: false,
      files: [
        { path: "src/app.ts", status: "modified", additions: 2, deletions: 1 },
        { path: "logo.png", status: "modified", binary: true },
        { path: "notes.md", status: "untracked", additions: 3, deletions: 0 },
      ],
    }),
  });
  await openTab(user, "Diff");
  const tab = within(panel());
  await user.click(await tab.findByRole("radio", { name: "Workspace" }));
  expect(await tab.findByText("Against commit 0123456")).toBeDefined();
  expect(tab.getByRole("button", { name: /logo\.png/ }).textContent).toContain("binary");
  // What became of a file is git's letter, with the word for a reader; a modified one, as most are, shows no letter.
  const notes = tab.getByRole("button", { name: /notes\.md/ });
  expect(notes.textContent).toContain("untracked");
  expect(notes.querySelector('[data-slot="diff-status"] > [aria-hidden]')?.textContent).toBe("U");
  expect(tab.getByRole("button", { name: /src\/app\.ts/ }).querySelector("[data-tone]")).toBeNull();
  // The folder a file is in is quiet beside its name, and is what gives way in a narrow panel.
  const path = tab.getByRole("button", { name: /src\/app\.ts/ });
  expect(path.querySelector('[data-slot="path-folder"]')?.textContent).toBe("src/");
  expect(path.querySelector('[data-slot="path-name"]')?.textContent).toBe("app.ts");
  await user.click(tab.getByRole("button", { name: /src\/app\.ts/ }));
  expect(await tab.findByText("another")).toBeDefined();
  expect(tracked()).toEqual([
    ["diff_view_changed", { view: "workspace" }],
    ["diff_file_opened", { view: "workspace" }],
  ]);
});

test("the workspace view says why there is nothing to compare: no repository, or one not trusted", async () => {
  const states: WorkspaceStatus[] = [
    { state: "untrusted", repository: "/work" },
    { state: "not_git" },
  ];
  const { user } = await mount({
    diff: true,
    status: async () => states.shift() ?? { state: "not_git" },
  });
  await openTab(user, "Diff");
  const tab = within(panel());
  await user.click(await tab.findByRole("radio", { name: "Workspace" }));
  expect(await tab.findByText("This repository is not trusted")).toBeDefined();
  expect(tab.getByText(/Trust \/work from the workspace menu/)).toBeDefined();
  // Back and forth reads it again.
  await user.click(tab.getByRole("radio", { name: "This session" }));
  await user.click(tab.getByRole("radio", { name: "Workspace" }));
  expect(await tab.findByText("This folder is not in a git repository")).toBeDefined();
});

test("a failure to compare says why in git's words, and Retry asks again", async () => {
  let fail = true;
  const { user } = await mount({
    diff: true,
    status: async () => {
      if (fail) throw new Error("git exited with 128");
      return { state: "ok", head: null, truncated: false, files: [] };
    },
  });
  await openTab(user, "Diff");
  const tab = within(panel());
  await user.click(await tab.findByRole("radio", { name: "Workspace" }));
  expect(await tab.findByText("git exited with 128")).toBeDefined();
  fail = false;
  await user.click(tab.getByRole("button", { name: "Retry" }));
  expect(await tab.findByText("No changes since the last commit")).toBeDefined();
  expect(tab.getByText("No commits yet: everything is new")).toBeDefined();
});

test("an edit held for review says so; a repository inside opens in Files; trusting and checking again compares", async () => {
  const states: WorkspaceStatus[] = [
    { state: "untrusted", repository: "/work" },
    {
      state: "ok",
      head: "0123456789abcdef0123456789abcdef01234567",
      truncated: false,
      files: [{ path: "vendor/lib", status: "untracked", folder: true }],
    },
  ];
  const { user } = await mount({
    diff: true,
    // The last answer stays: a view shown again asks again.
    status: async () =>
      states.length > 1 ? (states.shift() as WorkspaceStatus) : (states[0] as WorkspaceStatus),
    updates: [
      ask("m1", "Propose a change"),
      u({ sessionUpdate: "tool_call_update", toolCallId: "t1", name: "Edit", status: "pending" }),
      u({
        sessionUpdate: "tool_call_update",
        toolCallId: "t1",
        status: "completed",
        content: [
          {
            type: "diff",
            changes: [{ operation: "modify", path: "/work/a.ts" }],
            patch: { format: "git_patch", text: PATCH },
          },
        ],
        _meta: { "cycle/toolResult": { edit: { additions: 2, deletions: 1, staged: true } } },
      }),
    ],
  });
  await openTab(user, "Diff");
  const tab = within(panel());
  expect(tab.getByRole("button", { name: /a\.ts/ }).textContent).toContain("held for review");
  await user.click(tab.getByRole("radio", { name: "Workspace" }));
  expect(await tab.findByText("This repository is not trusted")).toBeDefined();
  await user.click(tab.getByRole("button", { name: "Check again" }));
  const folder = await tab.findByRole("button", { name: /vendor\/lib/ });
  // The view chosen stays while another tab is looked at.
  await user.click(tab.getByRole("tab", { name: "Overview" }));
  await user.click(within(panel()).getByRole("tab", { name: "Diff" }));
  expect(within(panel()).getByRole("radio", { name: "Workspace", checked: true })).toBeDefined();
  await user.click(await within(panel()).findByRole("button", { name: /vendor\/lib/ }));
  expect(await within(panel()).findByRole("tab", { name: "Files", selected: true })).toBeDefined();
  expect(folder).toBeDefined();
});
