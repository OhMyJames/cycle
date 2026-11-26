import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { PermissionRequest, PlanUsage, SessionSnapshot } from "../../src/api.ts";
import { codeTheme } from "../../src/code-theme.ts";
import { applyUpdate, emptyConversation } from "../../src/model/index.ts";
import { MOD } from "../../src/react/sidebar.tsx";
import { fakeBridge, idle, summary, text } from "../fake-bridge.ts";
import { accountMenu, openSettings } from "./account-menu.ts";
import { findAlert, getAlert, queryAlert } from "./alert.ts";
import { chosenFolder, typeFolder } from "./blank.ts";
import { boxText, press, ready, sleep, write } from "./box.ts";
import { renderApp } from "./render-app.tsx";

afterEach(() => {
  cleanup();
  // Drafts are kept in the page's storage; each test starts with none.
  localStorage.clear();
});

const u = (update: object) => update as SessionUpdate;

const mount = async (
  options: {
    snapshot?: () => SessionSnapshot;
    configure?: (script: ReturnType<typeof fakeBridge>) => void;
    capabilities?: {
      queue: boolean;
      steer?: boolean;
      files: boolean;
      folders: boolean;
      sessionMentions?: boolean;
    };
    steer?: boolean;
  } = {},
) => {
  const script = fakeBridge({
    connected: true,
    ...(options.steer === true ? { steer: true } : {}),
    ...(options.snapshot ? { snapshot: options.snapshot } : {}),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
  });
  options.configure?.(script);
  const store = await renderApp(script.bridge);
  const user = userEvent.setup();
  // An event arrives outside React's own calls: say so, or each one warns.
  const emit = (event: Parameters<typeof script.emit>[0]) => act(() => script.emit(event));
  return { store, user, ...script, emit };
};

const history = (...updates: SessionUpdate[]): SessionSnapshot => ({
  conversation: updates.reduce((c, u) => applyUpdate(c, u), emptyConversation()),
  permissions: [],
  version: updates.length,
});

const openFirstSession = async (user: ReturnType<typeof userEvent.setup>) => {
  const option = await screen.findByRole("option", { name: /work/ });
  await user.click(option);
};

test("lists the host's sessions, and shows the conversation of the one chosen", async () => {
  const { user } = await mount({
    snapshot: () =>
      history(
        u({
          sessionUpdate: "user_message",
          messageId: "u1",
          content: [{ type: "text", text: "Say hi" }],
        }),
        text("Hi there!", "a1"),
        idle({ stopReason: "end_turn" }),
      ),
  });
  await openFirstSession(user);
  const log = await screen.findByRole("log", { name: "Conversation" });
  await waitFor(() => expect(log.textContent).toContain("Hi there!"));
  expect(log.textContent).toContain("Say hi");
});

test("Enter sends what was typed, Shift+Enter makes a new line, and the box empties", async () => {
  const { user, named } = await mount();
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "first line");
  await press(box, "Enter", { shiftKey: true });
  await write(box, "second line");
  expect(boxText(box)).toBe("first line\nsecond line");
  expect(named("prompt")).toHaveLength(0);
  await press(box, "Enter");
  await waitFor(() =>
    expect(named("prompt")).toEqual([
      [
        "prompt",
        "local",
        "s1",
        [{ type: "text", text: "first line\nsecond line" }],
        { via: "enter" },
      ],
    ]),
  );
  expect(boxText(box)).toBe("");
});

test("while the agent works there is Stop, and a message typed is queued, not refused", async () => {
  const { user, emit, named } = await mount();
  await openFirstSession(user);
  await screen.findByRole("textbox", { name: "Message" });
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    update: u({ sessionUpdate: "state_update", state: "running" }),
    version: 1,
  });
  const stop = await screen.findByRole("button", { name: "Stop" });
  expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  const queue = screen.getByRole("button", { name: "Queue" }) as HTMLButtonElement;
  expect(queue.disabled).toBe(true);
  await write(screen.getByRole("textbox", { name: "Message" }), "next");
  await user.click(queue);
  await waitFor(() =>
    expect(named("prompt")).toEqual([
      ["prompt", "local", "s1", [{ type: "text", text: "next" }], { via: "button" }],
    ]),
  );
  await user.click(stop);
  expect(named("cancel")).toHaveLength(1);
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    update: idle({ stopReason: "cancelled" }),
    version: 2,
  });
  await screen.findByRole("button", { name: "Send" });
});

test("while the agent works, Enter sends into its turn, ⌘Enter queues, and Shift+Enter is a new line", async () => {
  const { user, emit, named } = await mount({
    steer: true,
    capabilities: { queue: true, steer: true, files: true, folders: true },
  });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    update: u({ sessionUpdate: "state_update", state: "running" }),
    version: 1,
  });
  await screen.findByRole("button", { name: "Send now" });
  const queueButton = screen.getByRole("button", { name: "Queue" });
  expect(queueButton.getAttribute("title")).toBe(`Queue (${MOD}Enter)`);
  expect(box.closest('[data-slot="composer"]')?.textContent ?? "").not.toContain("Shift+Enter");
  // Shift+Enter is a new line while it works, as it is when it does not; so is Alt+Enter.
  await write(box, "one");
  await press(box, "Enter", { shiftKey: true });
  await write(box, "two");
  await press(box, "Enter", { altKey: true });
  await write(box, "three");
  expect(boxText(box)).toBe("one\ntwo\nthree");
  expect(named("prompt")).toHaveLength(0);
  await press(box, "Enter");
  await waitFor(() =>
    expect(named("prompt")).toEqual([
      [
        "prompt",
        "local",
        "s1",
        [{ type: "text", text: "one\ntwo\nthree" }],
        { steer: true, via: "enter" },
      ],
    ]),
  );
  // ⌘Enter (Ctrl+Enter off a Mac) queues.
  await write(box, "later");
  await press(box, "Enter", MOD === "⌘" ? { metaKey: true } : { ctrlKey: true });
  await waitFor(() => expect(named("prompt")).toHaveLength(2));
  expect(named("prompt")[1]).toEqual([
    "prompt",
    "local",
    "s1",
    [{ type: "text", text: "later" }],
    { via: "shortcut" },
  ]);
  expect(boxText(box)).toBe("");
  // And the button says how it was sent, too.
  await write(box, "by hand");
  await user.click(screen.getByRole("button", { name: "Queue" }));
  await waitFor(() => expect(named("prompt")).toHaveLength(3));
  expect(named("prompt")[2]?.[4]).toEqual({ via: "button" });
});

test("while a permission waits, ⌘Enter is the card's Allow once, not the queue's", async () => {
  const { user, emit, named } = await mount({
    steer: true,
    capabilities: { queue: true, steer: true, files: true, folders: true },
  });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    update: u({ sessionUpdate: "state_update", state: "requires_action" }),
    version: 1,
  });
  const request: PermissionRequest = {
    key: "local:s1:p1",
    locationId: "local",
    sessionId: "s1",
    title: "Allow Bash?",
    subject: { type: "tool_call", toolCall: { name: "Bash", rawInput: { command: "ls" } } },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  };
  emit({ type: "permission", request, version: 2 });
  await screen.findByLabelText("Allow Bash?");
  await write(box, "wait");
  await press(box, "Enter", MOD === "⌘" ? { metaKey: true } : { ctrlKey: true });
  // The box leaves it to the window's shortcut (Allow once, app.tsx): it queues nothing and keeps what was written.
  expect(named("prompt")).toHaveLength(0);
  expect(boxText(box)).toBe("wait");
});

test("an agent that cannot be steered keeps Enter as queue while it works", async () => {
  const { user, emit, named } = await mount({
    capabilities: { queue: true, steer: true, files: true, folders: true },
  });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    update: u({ sessionUpdate: "state_update", state: "running" }),
    version: 1,
  });
  await screen.findByRole("button", { name: "Queue" });
  expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
  await write(box, "next");
  await press(box, "Enter");
  await waitFor(() =>
    expect(named("prompt")).toEqual([
      ["prompt", "local", "s1", [{ type: "text", text: "next" }], { via: "enter" }],
    ]),
  );
});

test("streams: what arrives is added to the message on screen", async () => {
  const { user, emit } = await mount({ snapshot: () => history() });
  await openFirstSession(user);
  const log = await screen.findByRole("log", { name: "Conversation" });
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    update: text("Hel", "a1"),
    version: 1,
  });
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    update: text("lo!", "a1"),
    version: 2,
  });
  await waitFor(() => expect(log.textContent).toContain("Hello!"));
});

test("a tool call shows what it is doing and how it went", async () => {
  const { user } = await mount({
    snapshot: () =>
      history(
        u({ sessionUpdate: "tool_call_update", toolCallId: "t1", name: "Bash", status: "pending" }),
        u({
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: "completed",
          rawInput: { command: "make -j4" },
        }),
      ),
  });
  await openFirstSession(user);
  const log = await screen.findByRole("log", { name: "Conversation" });
  await waitFor(() => expect(log.textContent).toContain("Bash"));
  expect(log.textContent).toContain("make -j4");
  expect(log.textContent).toContain("completed");
});

test("a permission request is shown with its options, and the click answers it", async () => {
  const { user, emit, named } = await mount();
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  const request: PermissionRequest = {
    key: "local:s1:p1",
    locationId: "local",
    sessionId: "s1",
    title: "Allow Bash?",
    subject: {
      type: "tool_call",
      toolCall: { name: "Bash", rawInput: { command: "rm -rf build" } },
    },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
  };
  emit({ type: "permission", request, version: 1 });
  // By label and text: a role query walks the whole page's accessibility tree, which is slow here.
  const card = await screen.findByLabelText("Allow Bash?");
  expect(card.textContent).toContain("rm -rf build");
  const log = screen.getByRole("log", { name: "Conversation" });
  expect(within(log).getByText("Waiting for your answer")).toBeDefined();
  expect(box.getAttribute("aria-placeholder")).toBe("Waiting for your answer");
  const deny = within(card).getByText<HTMLButtonElement>("Deny");
  emit({ type: "location-status", locationId: "local", state: "reconnecting" });
  await waitFor(() => expect(deny.disabled).toBe(true));
  await emit({
    type: "location-status",
    locationId: "local",
    state: "connected",
    capabilities: { queue: true, files: false, folders: true },
  });
  await waitFor(() => expect(deny.disabled).toBe(false));
  await write(box, "next message");
  const queue = screen.getByRole<HTMLButtonElement>("button", { name: "Queue" });
  expect(queue.disabled).toBe(false);
  await user.click(queue);
  await waitFor(() =>
    expect(named("prompt")).toEqual([
      ["prompt", "local", "s1", [{ type: "text", text: "next message" }], { via: "button" }],
    ]),
  );
  await user.click(deny);
  expect(named("answerPermission")).toEqual([["answerPermission", "local:s1:p1", "deny"]]);
  emit({
    type: "permission-closed",
    locationId: "local",
    sessionId: "s1",
    key: request.key,
    version: 2,
  });
  await waitFor(() => expect(screen.queryByLabelText("Allow Bash?")).toBeNull());
  expect(within(log).queryByText("Waiting for your answer")).toBeNull();
});

const asking = (key: string, name: string, rawInput: object): PermissionRequest => ({
  key,
  locationId: "local",
  sessionId: "s1",
  title: `Allow ${name}?`,
  subject: { type: "tool_call", toolCall: { toolCallId: key, name, rawInput } },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ],
});

test("an edit waiting for leave shows the change it would make, line by line, before it is answered", async () => {
  const { user, emit } = await mount();
  await openFirstSession(user);
  await ready(await screen.findByRole("textbox", { name: "Message" }));
  emit({
    type: "permission",
    request: asking("local:s1:p1", "Edit", {
      file_path: "/work/src/app.ts",
      old_string: "const port = 3000;",
      new_string: "const port = 8080;\nconst host = 'localhost';",
    }),
    version: 1,
  });
  const card = await screen.findByLabelText("Allow Edit?");
  expect(card.textContent).toContain("/work/src/app.ts");
  const diff = card.querySelector('[data-slot="tool-diff"]') as HTMLElement;
  expect([...diff.querySelectorAll('[data-line="del"]')].map((l) => l.textContent)).toEqual([
    expect.stringContaining("const port = 3000;"),
  ]);
  expect([...diff.querySelectorAll('[data-line="add"]')]).toHaveLength(2);
  expect(card.textContent).toContain("+2");
});

test("several requests are answered one at a time; the keyboard goes on to the next card, then back to the box", async () => {
  const { user, emit, named } = await mount();
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  emit({
    type: "permission",
    request: asking("local:s1:p1", "Bash", { command: "ls" }),
    version: 1,
  });
  emit({
    type: "permission",
    request: asking("local:s1:p2", "Write", { file_path: "/w/a", content: "a" }),
    version: 2,
  });
  const first = await screen.findByLabelText("Allow Bash?");
  expect(first.textContent).toContain("1 more waiting");
  expect(screen.queryByLabelText("Allow Write?")).toBeNull();
  const allow = within(first).getByRole("button", { name: "Allow" });
  allow.focus();
  await user.keyboard("{Enter}");
  expect(named("answerPermission")).toEqual([["answerPermission", "local:s1:p1", "allow"]]);
  emit({
    type: "permission-closed",
    locationId: "local",
    sessionId: "s1",
    key: "local:s1:p1",
    version: 3,
  });
  const second = await screen.findByLabelText("Allow Write?");
  expect(second.textContent).not.toContain("more waiting");
  // The card itself takes the focus, not its Allow: a second Enter allows nothing unread.
  await waitFor(() => expect(document.activeElement).toBe(second));
  await user.keyboard("{Enter}");
  expect(named("answerPermission")).toHaveLength(1);
  await user.keyboard("{Tab}");
  expect(document.activeElement).toBe(within(second).getByRole("button", { name: "Allow" }));
  await user.keyboard("{Enter}");
  expect(named("answerPermission")).toHaveLength(2);
  emit({
    type: "permission-closed",
    locationId: "local",
    sessionId: "s1",
    key: "local:s1:p2",
    version: 4,
  });
  await waitFor(() => expect(screen.queryByLabelText("Allow Write?")).toBeNull());
  await waitFor(() =>
    expect(box.contains(document.activeElement) || document.activeElement === box).toBe(true),
  );
});

/** What a person presses for a choice: its label, which lies over the input the way the card draws it. */
const labelOf = (input: HTMLElement): HTMLElement => input.closest("label") ?? input;

test("an agent's questions are a form: a choice, several choices, an answer of one's own; only what was filled goes back", async () => {
  const { user, emit, named } = await mount();
  await openFirstSession(user);
  await ready(await screen.findByRole("textbox", { name: "Message" }));
  const request: PermissionRequest = {
    key: "local:s1:f1",
    locationId: "local",
    sessionId: "s1",
    title: "Claude has some questions",
    options: [],
    form: {
      message: "Claude has some questions",
      schema: {
        type: "object",
        properties: {
          q0: {
            type: "string",
            title: "Library",
            description: "Which library should we use?",
            oneOf: [
              { const: "zod", title: "zod", description: "Already a dependency" },
              { const: "valibot", title: "valibot" },
            ],
          },
          q0_other: {
            type: "string",
            title: "Other",
            description: "Your own answer",
            maxLength: 2000,
          },
          q1: {
            type: "array",
            title: "Targets",
            description: "Which platforms?",
            items: {
              anyOf: [
                { const: "mac", title: "macOS" },
                { const: "linux", title: "Linux" },
              ],
            },
          },
          q1_other: {
            type: "string",
            title: "Other",
            description: "Your own answer",
            maxLength: 2000,
          },
        },
      },
    },
  };
  emit({ type: "permission", request, version: 1 });
  const card = await screen.findByLabelText("Claude has some questions");
  expect(card.textContent).toContain("Which library should we use?");
  expect(card.textContent).toContain("Already a dependency");
  await user.click(labelOf(within(card).getByRole("radio", { name: /zod/ })));
  await user.click(labelOf(within(card).getByRole("checkbox", { name: /macOS/ })));
  await user.click(labelOf(within(card).getByRole("checkbox", { name: /Linux/ })));
  await user.click(labelOf(within(card).getByRole("checkbox", { name: /macOS/ })));
  const [, second] = within(card).getAllByPlaceholderText("Your own answer");
  await user.type(second as HTMLElement, "FreeBSD");
  await user.click(within(card).getByText("Send answers"));
  expect(named("answerForm")).toEqual([
    [
      "answerForm",
      "local:s1:f1",
      { action: "accept", content: { q0: "zod", q1: ["linux"], q1_other: "FreeBSD" } },
    ],
  ]);
  // Not a permission: it is never answered as one.
  expect(named("answerPermission")).toEqual([]);
  await user.click(within(card).getByText("Skip questions"));
  expect(named("answerForm").at(-1)).toEqual(["answerForm", "local:s1:f1", { action: "decline" }]);
});

test("a form's required field must be filled before it is answered; one the app cannot draw can only be skipped", async () => {
  const { user, emit, named } = await mount();
  await openFirstSession(user);
  await ready(await screen.findByRole("textbox", { name: "Message" }));
  const form = (key: string, properties: object, required: string[]): PermissionRequest => ({
    key,
    locationId: "local",
    sessionId: "s1",
    title: key,
    options: [],
    form: { message: key, schema: { type: "object", properties, required } },
  });
  emit({
    type: "permission",
    request: form("Name it", { name: { type: "string", title: "Name" } }, ["name"]),
    version: 1,
  });
  const card = await screen.findByLabelText("Name it");
  const answer = within(card)
    .getByText<HTMLButtonElement>("Send answers")
    .closest("button") as HTMLButtonElement;
  expect(card.textContent).toContain("required");
  expect(answer.disabled).toBe(true);
  await user.type(within(card).getByRole("textbox"), "cycle");
  await waitFor(() => expect(answer.disabled).toBe(false));
  await user.click(answer);
  expect(named("answerForm")).toEqual([
    ["answerForm", "Name it", { action: "accept", content: { name: "cycle" } }],
  ]);
  // Requests are shown one at a time: the next is drawn once this one is closed.
  emit({
    type: "permission-closed",
    locationId: "local",
    sessionId: "s1",
    key: "Name it",
    version: 2,
  });
  emit({
    type: "permission",
    request: form("Odd", { where: { type: "object", title: "Where" } }, ["where"]),
    version: 3,
  });
  const odd = await screen.findByLabelText("Odd");
  expect(odd.textContent).toContain("can't show");
  expect(
    (within(odd).getByText("Send answers").closest("button") as HTMLButtonElement).disabled,
  ).toBe(true);
});

test("shows what went wrong, and lets it be dismissed", async () => {
  const { user } = await mount({
    configure: (script) => {
      script.bridge.prompt = async () => {
        throw new Error("The session is working");
      };
    },
  });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "hi");
  await press(box, "Enter");
  const alert = await findAlert();
  expect(alert.textContent).toContain("The session is working");
  await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(queryAlert()).toBeNull());
});

test("says so when the connection is lost", async () => {
  const { emit, user } = await mount();
  // Under the open session's title bar; with none open, the empty page says it (notices.browser.tsx).
  await openFirstSession(user);
  emit({ type: "location-status", locationId: "local", state: "reconnecting" });
  const note = await screen.findByText(/Connection lost\. Reconnecting/);
  expect(note.getAttribute("role") ?? note.parentElement?.getAttribute("role")).toBe("status");
});

test("an open session keeps its draft offline and can send it after reconnecting", async () => {
  const { user, emit, named } = await mount();
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "Keep this");
  await emit({ type: "location-status", locationId: "local", state: "reconnecting" });
  // Said once, by the line under the title bar: the box does not repeat it.
  await screen.findByText(/Reconnecting….*Your draft is kept\./);
  expect(screen.queryByText(/keep editing your draft/)).toBeNull();
  await ready(box);
  await write(box, " draft");
  await press(box, "Enter");
  expect(boxText(box)).toBe("Keep this draft");
  expect(named("prompt")).toHaveLength(0);
  await emit({ type: "location-status", locationId: "local", state: "connected" });
  await press(box, "Enter");
  await waitFor(() =>
    expect(named("prompt")).toEqual([
      ["prompt", "local", "s1", [{ type: "text", text: "Keep this draft" }], { via: "enter" }],
    ]),
  );
});

test("a new session is a blank conversation: nothing is made until its first message, which starts it from the agent's defaults in the folder typed", async () => {
  const { user, named } = await mount({
    configure: (script) => {
      script.bridge.agentDefaults = async () => ({ mode: "plan" });
      script.bridge.agents = async () => [
        {
          id: "fake",
          name: "Fake",
          available: true,
          configSchema: {
            type: "object",
            properties: { mode: { type: "string", enum: ["default", "plan"] } },
          },
        },
      ];
    },
  });
  await user.click(await screen.findByRole("button", { name: "New session" }));
  expect(await screen.findByRole("heading", { name: "New session" })).toBeTruthy();
  // It starts from the folder of the workspace that is shown, named by its last part: the person replaces it.
  const where = screen.getByRole("group", { name: "Where the session runs" });
  expect(await chosenFolder()).toBe("/work");
  expect(within(where).getByRole("button", { name: "Folder: /work" }).textContent).toContain(
    "work",
  );
  await typeFolder(user, "/work/new");
  expect(await chosenFolder()).toBe("/work/new");
  // What it starts with is shown under the box, before anything is made.
  await screen.findByRole("button", { name: "mode: plan" });
  expect(named("createSession")).toEqual([]);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "Fix the build");
  await press(box, "Enter");
  await waitFor(() => expect(named("prompt")).toHaveLength(1));
  expect(named("createSession")[0]).toEqual([
    "createSession",
    "local",
    { cwd: "/work/new", agent: "fake", config: { mode: "plan" } },
  ]);
  expect(named("prompt")[0]).toEqual([
    "prompt",
    "local",
    "s2",
    [{ type: "text", text: "Fix the build" }],
  ]);
  // The session is open in its place.
  await waitFor(() =>
    expect(screen.queryByRole("group", { name: "Where the session runs" })).toBeNull(),
  );
});

test("a choice the agent names and describes shows its name and what it does, and sends its value", async () => {
  const { user, named } = await mount({
    configure: (script) => {
      script.bridge.agentDefaults = async () => ({ mode: "plan" });
      script.bridge.agents = async () => [
        {
          id: "fake",
          name: "Fake",
          available: true,
          configSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                title: "Permission mode",
                oneOf: [
                  {
                    const: "auto",
                    title: "Auto",
                    description: "Decides for you.",
                    _meta: { "cycle/recommended": true },
                  },
                  { const: "default", title: "Ask before acting", description: "Asks first." },
                  { const: "plan", title: "Plan mode", description: "Changes nothing." },
                ],
              },
            },
          },
        },
      ];
    },
  });
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const chip = await screen.findByRole("button", { name: "Permission mode: Plan mode" });
  await user.click(chip);
  const option = await screen.findByRole("menuitemradio", { name: /Ask before acting/ });
  expect(option.textContent).toContain("Asks first.");
  // The suggested one says so; the others do not.
  expect(option.textContent).not.toContain("Recommended");
  expect(screen.getByRole("menuitemradio", { name: /Auto/ }).textContent).toContain("Recommended");
  expect(screen.getByRole("menuitemradio", { name: /Plan mode/ }).textContent).toContain(
    "Changes nothing.",
  );
  await user.click(option);
  // The choice is what the box shows under it, too.
  await screen.findByRole("button", { name: "Permission mode: Ask before acting" });
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "hi");
  await press(box, "Enter");
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
  expect(named("createSession")[0]?.[2]).toMatchObject({ config: { mode: "default" } });
});

test("session settings show an unknown mode and follow the daemon while the dialog stays open", async () => {
  const { user, emit, named } = await mount({
    configure: (script) => {
      script.bridge.agents = async () => [
        {
          id: "fake",
          name: "Fake",
          available: true,
          configSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                title: "Permission mode",
                oneOf: [
                  { const: "auto", title: "Auto" },
                  { const: "default", title: "Ask before acting" },
                ],
                default: "auto",
              },
            },
          },
        },
      ];
    },
  });
  await openFirstSession(user);
  // Session settings lives in the session header menu, not beside permission in the composer.
  await user.click(await screen.findByRole("button", { name: "Session actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Session settings" }));
  const dialog = await screen.findByRole("dialog");
  const trigger = within(dialog).getByRole("combobox", { name: "Permission mode" });
  // An older session may run in another mode than new ones start in: say nothing rather than guess.
  expect(trigger.textContent).toContain("Not set");
  expect(trigger.textContent).not.toContain("Auto");
  emit({
    type: "sessions",
    locationId: "local",
    sessions: [{ ...summary("s1"), config: { mode: "default" } }],
  });
  expect(trigger.textContent).toContain("Ask before acting");
  expect(named("setSessionConfig")).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "Close" }));
  expect(
    await screen.findByRole("button", { name: "Permission mode: Ask before acting" }),
  ).toBeTruthy();
});

test("a setting the schema does not list is shown as it is, not as Not set", async () => {
  const { user } = await mount({
    configure: (script) => {
      script.bridge.sessions = async () => [
        { ...summary("s1"), config: { model: "claude-opus-4-5" } },
      ];
      script.bridge.agents = async () => [
        {
          id: "fake",
          name: "Fake",
          available: true,
          configSchema: {
            type: "object",
            properties: {
              model: { type: "string", title: "Model", oneOf: [{ const: "opus", title: "Opus" }] },
            },
          },
        },
      ];
    },
  });
  await openFirstSession(user);
  await screen.findByRole("button", { name: "Model: claude-opus-4-5" });
  // No settings gear button beside permission in the composer utility bar.
  expect(screen.queryByRole("button", { name: "Session settings" })).toBeNull();
});

test("an agent with nothing to set has no settings in the message box", async () => {
  const { user } = await mount({
    configure: (script) => {
      script.bridge.agents = async () => [
        { id: "fake", name: "Fake", available: true, configSchema: { type: "object" } },
      ];
    },
  });
  await openFirstSession(user);
  await screen.findByRole("textbox", { name: "Message" });
  expect(screen.queryByRole("button", { name: "Session settings" })).toBeNull();
});

test("the session's settings are at hand under the message box, and a choice there is sent", async () => {
  const { user, named } = await mount({
    configure: (script) => {
      script.bridge.agents = async () => [
        {
          id: "fake",
          name: "Fake",
          available: true,
          configSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                title: "Permission mode",
                oneOf: [
                  { const: "auto", title: "Auto" },
                  { const: "plan", title: "Plan mode", description: "Changes nothing." },
                ],
                default: "auto",
              },
              // Text is not a choice: it stays in Session settings.
              prompt: { type: "string", title: "System prompt" },
            },
          },
        },
      ];
    },
  });
  await openFirstSession(user);
  // Nothing on record: said so, not shown as the default.
  const chip = await screen.findByRole("button", { name: "Permission mode: Not set" });
  expect(screen.queryByRole("button", { name: /System prompt/ })).toBeNull();
  await user.click(chip);
  await user.click(await screen.findByRole("menuitemradio", { name: /Plan mode/ }));
  await waitFor(() =>
    expect(named("setSessionConfig")).toEqual([
      ["setSessionConfig", "local", "s1", "mode", "plan"],
    ]),
  );
});

test("the session menu marks only the displayed unknown background tasks as ended", async () => {
  const { user, named } = await mount({
    configure: ({ bridge }) => {
      bridge.sessions = async () => [{ ...summary("s1"), unknownBackground: ["child"] }];
    },
  });
  await openFirstSession(user);
  await user.click(await screen.findByRole("button", { name: "Session actions" }));
  await user.click(
    await screen.findByRole("menuitem", { name: "Mark 1 unconfirmed background task as ended" }),
  );
  await waitFor(() =>
    expect(named("dismissBackground")).toEqual([["dismissBackground", "local", "s1", ["child"]]]),
  );
});

test("deleting a session asks first", async () => {
  const { user, named } = await mount();
  await openFirstSession(user);
  // Delete is in the session's menu: out of the way, so that it is not pressed by habit.
  await user.click(await screen.findByRole("button", { name: "Session actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Delete" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(named("deleteSession")).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "Delete session" }));
  await waitFor(() => expect(named("deleteSession")).toEqual([["deleteSession", "local", "s1"]]));
});

test("Ctrl or Cmd+Enter allows a pending request even while typing in the message box, when connected", async () => {
  const { user, emit, named } = await mount();
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  emit({
    type: "permission",
    version: 1,
    request: {
      key: "local:s1:p1",
      locationId: "local",
      sessionId: "s1",
      title: "Allow Bash?",
      subject: {
        type: "tool_call",
        toolCall: { name: "Bash", rawInput: { command: "rm -rf build" } },
      },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    },
  });
  await screen.findByLabelText("Allow Bash?");
  // The key this platform's shortcut uses: Cmd on a Mac, Control elsewhere (the page reads the user agent).
  const mod = /Mac/.test(navigator.userAgent) ? "Meta" : "Control";
  await write(box, "half-written follow-up");
  await user.click(box);
  emit({ type: "location-status", locationId: "local", state: "reconnecting" });
  await user.keyboard(`{${mod}>}{Enter}{/${mod}}`);
  expect(named("answerPermission")).toHaveLength(0);
  emit({ type: "location-status", locationId: "local", state: "connected" });
  // Connected, Cmd/Ctrl+Enter allows it even with focus and a draft inside the message box, without sending or adding a line break.
  await user.keyboard(`{${mod}>}{Enter}{/${mod}}`);
  await waitFor(() =>
    expect(named("answerPermission")).toEqual([["answerPermission", "local:s1:p1", "allow"]]),
  );
  expect(named("sendPrompt")).toHaveLength(0);
  expect(boxText(box)).toBe("half-written follow-up");
});

test("the colours of code can be chosen, and the choice is kept", async () => {
  const { user } = await mount();
  try {
    expect(codeTheme.get()).toBe("github");
    await openSettings(user);
    await user.click(await screen.findByRole("tab", { name: "Appearance" }));
    await user.click(await screen.findByRole("combobox", { name: "Code colours" }));
    await user.click(await screen.findByRole("option", { name: "Catppuccin" }));
    await waitFor(() => expect(codeTheme.get()).toBe("catppuccin"));
    expect(localStorage.getItem("cycle-code-theme")).toBe("catppuccin");
  } finally {
    // Global state of the page: whatever happens above, the next test starts from the default.
    codeTheme.set("github");
  }
});

test("Ctrl or Cmd+K searches the sessions by what each shows, and Enter opens the one found", async () => {
  const { user, named } = await mount({
    configure: (script) => {
      script.bridge.sessions = async () => [{ ...summary("s1"), state: "requires_action" }];
    },
  });
  await screen.findByRole("option", { name: /work/ });
  const mod = /Mac/.test(navigator.userAgent) ? "Meta" : "Control";
  await user.keyboard(`{${mod}>}k{/${mod}}`);
  const box = await screen.findByRole("combobox", { name: "Search sessions" });
  // The summary has no title: it is shown by its folder, and found by it.
  await user.type(box, "zzz");
  expect(await screen.findByText("No session matches that.")).toBeTruthy();
  await user.clear(box);
  await user.type(box, "work");
  expect(await screen.findByRole("option", { name: /work.*Needs you/ })).toBeDefined();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(named("openSession")).toEqual([["openSession", "local", "s1"]]));
});

test("images can be attached when the agent takes them, and go with the message as image blocks", async () => {
  const { user, named } = await mount({
    configure: (script) => {
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
  });
  await openFirstSession(user);
  const attach = await screen.findByRole("button", { name: "Attach image" });
  expect(attach).toBeTruthy();
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (picker === null) throw new Error("no file input");
  const png = new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], "shot.png", {
    type: "image/png",
  });
  await user.upload(picker, png);
  expect(await screen.findByRole("button", { name: "Remove shot.png" })).toBeTruthy();
  const message = await screen.findByRole("textbox", { name: "Message" });
  await write(message, "what is this");
  await press(message, "Enter");
  await waitFor(() => expect(named("prompt")).toHaveLength(1));
  expect(named("prompt")[0]).toEqual([
    "prompt",
    "local",
    "s1",
    [
      { type: "text", text: "what is this" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ],
    { via: "enter" },
  ]);
  // The attachment is gone once sent.
  expect(screen.queryByRole("button", { name: "Remove shot.png" })).toBeNull();
});

test("two images added one right after the other both stay", async () => {
  const { user } = await mount({
    configure: (script) => {
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
  });
  await openFirstSession(user);
  await screen.findByRole("button", { name: "Attach image" });
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (picker === null) throw new Error("no file input");
  const png = (name: string) =>
    new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: "image/png" });
  // Not awaited between: the second starts while the first is still being read.
  await user.upload(picker, png("one.png"));
  await user.upload(picker, png("two.png"));
  expect(await screen.findByRole("button", { name: "Remove one.png" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Remove two.png" })).toBeTruthy();
});

test("a session found by the search that is archived is shown, not selected out of sight", async () => {
  const { user } = await mount({
    configure: (script) => {
      script.bridge.sessions = async () => [{ ...summary("s1"), archived: true }];
    },
  });
  const mod = /Mac/.test(navigator.userAgent) ? "Meta" : "Control";
  await user.keyboard(`{${mod}>}k{/${mod}}`);
  await user.type(await screen.findByRole("combobox", { name: "Search sessions" }), "work");
  await user.keyboard("{Enter}");
  // The list now includes the archived session, and it is the selected one.
  expect(await screen.findByRole("option", { name: /work/ })).toBeTruthy();
});

test("a file that is not an image the agent takes is refused with the reason, and nothing is attached", async () => {
  const { user } = await mount({
    configure: (script) => {
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
  });
  await openFirstSession(user);
  await screen.findByRole("button", { name: "Attach image" });
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (picker === null) throw new Error("no file input");
  // The picker's own filter (`accept`) is only a hint: a drop or a paste brings anything, so the code checks again. (The
  // browser's own upload does not apply it either.)
  await userEvent.upload(picker, new File(["x"], "pic.bmp", { type: "image/bmp" }));
  expect((await findAlert()).textContent).toContain(
    "pic.bmp is not a PNG, JPEG, GIF or WebP image.",
  );
  expect(screen.queryByRole("list", { name: "Attachments" })).toBeNull();
});

test("without the agent's word that it takes images, there is nothing to attach them with", async () => {
  const { user } = await mount();
  await openFirstSession(user);
  await screen.findByRole("textbox", { name: "Message" });
  expect(screen.queryByRole("button", { name: "Attach image" })).toBeNull();
});

test("a newer interface that is ready is offered with Reload, and not while the whole app has an update", async () => {
  const { user, emit, named } = await mount();
  await accountMenu();
  expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  await emit({ type: "interface-update", state: { bundled: 100, running: 100, ready: 120 } });
  expect(screen.getByText("The interface was updated")).toBeTruthy();
  // The whole app has an update: it carries the newest page itself, so there is only that one to act on.
  await emit({
    type: "app-update",
    state: { current: "0.1.0", kind: "available", version: "0.2.0" },
  });
  expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  await emit({ type: "app-update", state: { current: "0.1.0", kind: "up-to-date", checkedAt: 0 } });
  await user.click(await screen.findByRole("button", { name: "Reload" }));
  await waitFor(() => expect(named("applyInterfaceUpdate")).toHaveLength(1));
  // Showing it: no more waiting, and the footer says which interface this is.
  await emit({ type: "interface-update", state: { bundled: 100, running: 120 } });
  expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  await user.click(await accountMenu());
  expect(await screen.findByText(/0\.1\.0 · UI 120/)).toBeTruthy();
});

test("an update that is found is offered, asks before it restarts, and the footer can check on demand", async () => {
  const { user, emit, named } = await mount();
  await accountMenu();
  await emit({
    type: "app-update",
    state: { current: "0.1.0", kind: "available", version: "0.2.0" },
  });
  expect(screen.getByText("Version 0.2.0 is available")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Update and restart" }));
  // Asked first: nothing is installed until the user agrees.
  expect(named("installUpdate")).toHaveLength(0);
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Update and restart" }));
  await waitFor(() => expect(named("installUpdate")).toHaveLength(1));

  await emit({
    type: "app-update",
    state: { current: "0.1.0", kind: "downloading", version: "0.2.0", received: 5e6, total: 2e7 },
  });
  expect(screen.getAllByText(/Downloading 0.2.0: 5 of 20 MB/).length).toBeGreaterThan(0);
  // By the difference it says so, and how much it is: the changes, not the app.
  await emit({
    type: "app-update",
    state: {
      current: "0.1.0",
      kind: "downloading",
      version: "0.2.0",
      received: 5e6,
      total: 4e7,
      how: "difference",
    },
  });
  expect(
    screen.getAllByText(/Downloading the changes for 0.2.0: 5 of 40 MB/).length,
  ).toBeGreaterThan(0);
  // No button to start it again while it works, and no second check. (The dialog that asked leaves with its own motion.)
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Update and restart" })).toBeNull(),
  );
  await openSettings(user);
  expect(
    (await screen.findByRole("button", { name: "Check for updates" })).hasAttribute("disabled"),
  ).toBe(true);
  await user.keyboard("{Escape}");

  await emit({
    type: "app-update",
    state: { current: "0.1.0", kind: "error", message: "no room", version: "0.2.0" },
  });
  expect(screen.getByText("Updating to 0.2.0 failed: no room")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();

  await emit({ type: "app-update", state: { current: "0.1.0", kind: "up-to-date", checkedAt: 0 } });
  await openSettings(user);
  await user.click(await screen.findByRole("button", { name: "Check for updates" }));
  expect(named("checkForUpdate")).toHaveLength(1);
  await user.keyboard("{Escape}");
  // The account's menu checks too, and says which version this is at the row's end.
  await user.click(await accountMenu());
  const check = await screen.findByRole("menuitem", { name: /^Check for updates/ });
  expect(check.querySelector('[data-slot="app-version"]')?.textContent).toBe("0.1.0");
  await user.click(check);
  expect(named("checkForUpdate")).toHaveLength(2);
});

test("a daemon too old for the app says so in one line with a button, and updating asks first", async () => {
  const { emit, user, named } = await mount();
  expect(screen.queryByText(/too old for this app/)).toBeNull();
  await emit({
    type: "location-status",
    locationId: "local",
    state: "connected",
    daemon: { version: "0.1.0", upgrade: { to: "0.3.0", command: "sh install.sh" } },
  });
  expect(screen.getByText(/Cycle on .* is 0\.1\.0, too old for this app/)).toBeTruthy();
  // The command is not the first thing shown.
  expect(screen.queryByText("sh install.sh")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Update to 0.3.0" }));
  expect(named("upgradeDaemon")).toHaveLength(0);
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Update" }));
  // Nothing is waiting, so the app does not say when.
  await waitFor(() =>
    expect(named("upgradeDaemon")).toEqual([["upgradeDaemon", "local", undefined]]),
  );
  await emit({
    type: "location-status",
    locationId: "local",
    state: "connected",
    daemon: { version: "0.3.0" },
  });
  expect(screen.queryByText(/too old for this app/)).toBeNull();
});

test("updating a daemon whose sessions are working names them, and the person waits for them or interrupts them", async () => {
  const { emit, user, named } = await mount();
  await emit({
    type: "sessions",
    locationId: "local",
    sessions: [
      { ...summary("s1"), title: "Fix the build", state: "running" },
      { ...summary("s2"), title: "Idle one", state: "idle" },
    ],
  });
  await emit({
    type: "location-status",
    locationId: "local",
    state: "connected",
    daemon: { version: "0.1.0", upgrade: { to: "0.3.0", command: "sh install.sh" } },
  });
  await user.click(screen.getByRole("button", { name: "Update to 0.3.0" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText(/Fix the build/)).toBeTruthy();
  expect(within(dialog).queryByText(/Idle one/)).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "Update when they finish" }));
  await waitFor(() =>
    expect(named("upgradeDaemon")).toEqual([["upgradeDaemon", "local", "later"]]),
  );

  // Installed and waiting: the line says so, and what is left to choose is to interrupt them.
  await emit({
    type: "location-status",
    locationId: "local",
    state: "connected",
    daemon: {
      version: "0.1.0",
      upgrade: { to: "0.3.0", command: "sh install.sh", waiting: true },
    },
  });
  expect(screen.getByText(/restarts as the new version when its sessions finish/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Update now" }));
  const again = await screen.findByRole("alertdialog");
  expect(within(again).queryByRole("button", { name: "Update when they finish" })).toBeNull();
  await user.click(within(again).getByRole("button", { name: "Update now and interrupt" }));
  await waitFor(() =>
    expect(named("upgradeDaemon").at(-1)).toEqual(["upgradeDaemon", "local", "now"]),
  );
});

test("a daemon on another protocol says why it cannot be used and what to update, and the line goes when it connects", async () => {
  const { emit } = await mount();
  await emit({
    type: "location-status",
    locationId: "local",
    state: "reconnecting",
    error: "The daemon speaks Cycle protocol 0.2; this client speaks 1.0.",
    incompatible: {
      with: "daemon",
      supported: ["0.2"],
      requested: "1.0",
      command: "sh install.sh",
    },
  });
  expect(screen.getByText(/speaks protocol 0\.2, older than the 1\.0 this app needs/)).toBeTruthy();
  // Not stacked with the generic "Connection lost" banner: protocol mismatch is the single reason.
  expect(screen.queryByText(/Connection lost/)).toBeNull();
  // Not a button that would act on a daemon that is not connected: the command, to run on that machine.
  expect(screen.getByText("sh install.sh")).toBeTruthy();

  await emit({
    type: "location-status",
    locationId: "local",
    state: "reconnecting",
    error: "x",
    incompatible: { with: "app", supported: ["2.0"], requested: "1.0" },
  });
  // The app is the one to update: the daemon is not offered a downgrade.
  expect(screen.getByText(/newer than the 1\.0 this app has\. Update this app/)).toBeTruthy();
  expect(screen.queryByText("sh install.sh")).toBeNull();

  await emit({ type: "location-status", locationId: "local", state: "connected" });
  expect(screen.queryByText(/this app needs|this app has|cannot use/)).toBeNull();
});

test("a daemon update that did not work says why and shows the command to run by hand", async () => {
  const { emit } = await mount();
  await emit({
    type: "location-status",
    locationId: "local",
    state: "connected",
    daemon: {
      version: "0.1.0",
      upgrade: { to: "0.3.0", command: "sh install.sh", error: "Permission denied (publickey)." },
    },
  });
  expect(
    screen.getByText(/Could not update Cycle on .*Permission denied \(publickey\)\./),
  ).toBeTruthy();
  expect(screen.getByText("sh install.sh")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

test("a host that cannot be reached says why, not only that it is not connected", async () => {
  const { emit } = await mount();
  await emit({
    type: "location-status",
    locationId: "local",
    state: "closed",
    error: "bash: /home/james/.local/bin/cycle-daemon: No such file or directory",
  });
  expect(screen.getByText("Not connected to this location.")).toBeTruthy();
  expect(getAlert().textContent).toContain("No such file or directory");
});

test("a development run says updates are for the installed app and offers no check", async () => {
  const { emit, user } = await mount();
  await emit({
    type: "app-update",
    state: { current: "0.0.0", kind: "disabled", reason: "Updates are for the installed app." },
  });
  // The account's menu says why, where the check would be, and offers none.
  await user.click(await accountMenu());
  const check = await screen.findByRole("menuitem", {
    name: /^Updates are for the installed app\./,
  });
  expect(check.getAttribute("aria-disabled") ?? check.getAttribute("data-disabled")).not.toBeNull();
  await user.keyboard("{Escape}");
  await openSettings(user);
  await screen.findByRole("tab", { name: "General" });
  // Said again where the check would be, in place of it.
  expect(screen.getAllByText("Updates are for the installed app.").length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
});

const queueUpdate = (version: number, entries: object[], extra: object = {}) => ({
  type: "update" as const,
  locationId: "local",
  sessionId: "s1",
  update: u({ sessionUpdate: "_cycle/queue_update", entries, ...extra }),
  version,
});
const waiting = (id: string, words: string) => ({
  queueId: id,
  prompt: [{ type: "text", text: words }],
});

test("what is queued is listed, and Edit takes it back into the box", async () => {
  const { user, emit, bridge } = await mount();
  const taken: string[] = [];
  bridge.dequeue = async (_host, _session, queueId) => {
    taken.push(queueId);
    return [{ type: "text", text: "the second one" }];
  };
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  emit(queueUpdate(1, [waiting("q1", "the second one")]));
  const list = await screen.findByRole("list", { name: "Queued messages" });
  expect(list.textContent).toContain("the second one");
  await user.click(
    within(list).getByRole("button", { name: /Edit queued message: the second one/ }),
  );
  await waitFor(() => expect(boxText(box)).toBe("the second one"));
  emit(queueUpdate(2, []));
  await waitFor(() => expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull());
  expect(taken).toEqual(["q1"]);
  expect(document.activeElement).toBe(box);
});

test("what the daemon hands back after a stop is in the box, with no error", async () => {
  const { user, emit, store } = await mount();
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "and this");
  emit(
    queueUpdate(1, [], {
      returned: [waiting("q1", "one"), waiting("q2", "two")],
      reason: "cancelled",
    }),
  );
  await waitFor(() => expect(boxText(box)).toBe("one\n\ntwo\n\nand this"));
  expect(store.getState().error).toBeUndefined();
});

test("Up in an empty box recalls what was sent, Down goes back, and typing is not interfered with", async () => {
  const { user } = await mount({
    snapshot: () =>
      history(
        u({
          sessionUpdate: "user_message",
          messageId: "u1",
          content: [{ type: "text", text: "first" }],
        }),
        text("ok", "a1"),
        u({
          sessionUpdate: "user_message",
          messageId: "u2",
          content: [{ type: "text", text: "second" }],
        }),
        idle({ stopReason: "end_turn" }),
      ),
  });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await press(box, "ArrowUp");
  expect(boxText(box)).toBe("second");
  await press(box, "ArrowUp");
  expect(boxText(box)).toBe("first");
  await press(box, "ArrowDown");
  expect(boxText(box)).toBe("second");
  await press(box, "ArrowDown");
  expect(boxText(box)).toBe("");
  await write(box, "typing");
  await press(box, "ArrowUp");
  expect(boxText(box)).toBe("typing");
});

const withCommands = (...names: string[]) =>
  history(
    u({
      sessionUpdate: "available_commands_update",
      availableCommands: names.map((name) => ({
        type: "command",
        name,
        description: `Does ${name}`,
        ...(name === "review" ? { input: { type: "text", hint: "PR number" } } : {}),
      })),
    }),
  );

test("a slash at the start lists the commands that fit; the arrows choose, Enter takes it and does not send", async () => {
  const { user, named } = await mount({
    snapshot: () => withCommands("init", "review", "compact"),
  });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "/");
  const menu = await screen.findByRole("listbox", { name: "Commands" });
  expect(
    within(menu)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual(["/initDoes init", "/reviewPR numberDoes review", "/compactDoes compact"]);
  expect(box.getAttribute("aria-expanded")).toBe("true");
  await write(box, "r");
  await waitFor(() => expect(within(menu).getAllByRole("option")).toHaveLength(1));
  await press(box, "ArrowDown");
  await press(box, "Enter");
  await waitFor(() => expect(boxText(box)).toBe("/review "));
  expect(named("prompt")).toHaveLength(0);
  await waitFor(() => expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull());
  // The menu is gone, so Enter sends.
  await write(box, "12");
  await press(box, "Enter");
  await waitFor(() =>
    expect(named("prompt")).toEqual([
      ["prompt", "local", "s1", [{ type: "text", text: "/review 12" }], { via: "enter" }],
    ]),
  );
});

test("with the menu open, Shift+Enter is a new line and does not take what is chosen", async () => {
  const { user, named } = await mount({ snapshot: () => withCommands("init", "review") });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "/r");
  await screen.findByRole("listbox", { name: "Commands" });
  await press(box, "Enter", { shiftKey: true });
  await write(box, "x");
  expect(boxText(box)).toBe("/r\nx");
  expect(named("prompt")).toHaveLength(0);
});

test("a command typed in full is sent by Enter, not rewritten", async () => {
  const { user, named } = await mount({ snapshot: () => withCommands("init", "compact") });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "/compact");
  await screen.findByRole("listbox", { name: "Commands" });
  await press(box, "Enter");
  await waitFor(() =>
    expect(named("prompt")).toEqual([
      ["prompt", "local", "s1", [{ type: "text", text: "/compact" }], { via: "enter" }],
    ]),
  );
});

test("a slash that is not at the start of the message, or has a space after it, opens nothing", async () => {
  const { user } = await mount({ snapshot: () => withCommands("init") });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "see /in");
  await act(async () => {});
  expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
});

test("Escape closes the menu and Enter then sends what was typed", async () => {
  const { user, named } = await mount({ snapshot: () => withCommands("init") });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "/zzz");
  expect(screen.queryByRole("listbox", { name: "Commands" })).toBeNull();
  await write(box, "\b");
  await press(box, "Enter");
  await waitFor(() => expect(named("prompt")).toHaveLength(1));
});

test("a click on a command takes it, and the input keeps the focus", async () => {
  const { user } = await mount({ snapshot: () => withCommands("init", "compact") });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "/co");
  await user.click(await screen.findByRole("option", { name: /compact/ }));
  await waitFor(() => expect(boxText(box)).toBe("/compact "));
});

const files = (entries: { path: string; kind: "file" | "folder" }[]) => async () => ({
  root: "/work",
  entries,
  truncated: false,
});

test("an @ lists the files that fit; Enter takes one, the text says where, and the agent is sent a link too", async () => {
  const { user, named, bridge } = await mount();
  const asked: string[] = [];
  bridge.searchFiles = async (_host, _session, query) => {
    asked.push(query);
    return query === "ma"
      ? {
          root: "/work",
          entries: [
            { path: "src/main.ts", kind: "file" },
            { path: "docs/manual", kind: "folder" },
          ],
          truncated: false,
        }
      : { root: "/work", entries: [], truncated: false };
  };
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "look at @ma");
  const menu = await screen.findByRole("listbox", { name: "Files and folders" });
  expect(
    within(menu)
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual(["main.tssrc", "manual/docs"]);
  expect(asked.at(-1)).toBe("ma");
  await press(box, "Enter");
  await waitFor(() => expect(boxText(box)).toBe("look at @src/main.ts "));
  expect(named("prompt")).toHaveLength(0);
  await write(box, "please");
  await press(box, "Enter");
  await waitFor(() => expect(named("prompt")).toHaveLength(1));
  expect(named("prompt")[0]).toEqual([
    "prompt",
    "local",
    "s1",
    [
      { type: "text", text: "look at @src/main.ts please" },
      {
        type: "resource_link",
        name: "main.ts",
        uri: "file:///work/src/main.ts",
        _meta: { "cycle/mention": "src/main.ts" },
      },
    ],
    { via: "enter" },
  ]);
});

test("a name that fits nothing is said so, an @ in an address opens nothing, and a search that fails is quiet", async () => {
  const { user, store, bridge } = await mount();
  bridge.searchFiles = files([]);
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "write to me@example.com");
  await act(async () => {
    await sleep(200);
  });
  expect(screen.queryByRole("listbox", { name: "Files and folders" })).toBeNull();
  const empty = () => document.querySelector('[data-slot="picker"][role="status"]');
  expect(empty()).toBeNull();
  await write(box, " @zzz");
  await waitFor(() => expect(empty()?.textContent).toBe("No file or folder matches that."));
  // The box is not stopped by it: Enter sends what is there.
  bridge.searchFiles = async () => {
    throw new Error("The daemon is old");
  };
  await write(box, "q");
  await act(async () => {
    await sleep(200);
  });
  expect(store.getState().error).toBeUndefined();
});

test("a bare @ in a folder with nothing in it says so; the menu spans the box, not the field", async () => {
  const { user, bridge } = await mount();
  bridge.searchFiles = files([]);
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "see @");
  const empty = () => document.querySelector('[data-slot="picker"][role="status"]');
  await waitFor(() => expect(empty()?.textContent).toBe("No files or folders found here."));
  // Placed over the whole input box: with Queue, Send now and Stop beside one line, the field alone can be narrow.
  expect(empty()?.parentElement?.getAttribute("data-slot")).toBe("composer-box");
});

test("a mention taken back from the queue is a mention again", async () => {
  const { user, bridge, emit, store } = await mount();
  bridge.dequeue = async () => [
    { type: "text", text: "see @a.ts" },
    {
      type: "resource_link",
      name: "a.ts",
      uri: "file:///work/a.ts",
      _meta: { "cycle/mention": "a.ts" },
    },
  ];
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  emit(queueUpdate(1, [waiting("q1", "see @a.ts")]));
  await user.click(await screen.findByRole("button", { name: /Edit queued message/ }));
  await waitFor(() => expect(boxText(box)).toBe("see @a.ts"));
  expect(store.drafts.get("local:s1").mentions.map((m) => m.uri)).toEqual(["file:///work/a.ts"]);
});

test("a PDF taken back from the queue is shown, can be removed, and goes out again with the message", async () => {
  const { user, bridge, emit, named } = await mount();
  const pdf = {
    type: "resource" as const,
    resource: { uri: "file:///work/spec.pdf", mimeType: "application/pdf", blob: "AAAA" },
  };
  bridge.dequeue = async () => [{ type: "text", text: "read it" }, pdf];
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  emit(queueUpdate(1, [waiting("q1", "read it")]));
  await user.click(await screen.findByRole("button", { name: /Edit queued message/ }));
  await waitFor(() => expect(boxText(box)).toBe("read it"));
  expect(screen.getByRole("button", { name: "Remove spec.pdf" })).toBeTruthy();
  await press(box, "Enter");
  await waitFor(() => expect(named("prompt")).toHaveLength(1));
  expect(named("prompt")[0]?.[3]).toEqual([{ type: "text", text: "read it" }, pdf]);
});

test("a daemon that does not queue is not sent a message while the agent works, and says why", async () => {
  const { user, emit, named } = await mount({
    capabilities: { queue: false, files: false, folders: true },
  });
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    update: u({ sessionUpdate: "state_update", state: "running" }),
    version: 1,
  });
  await write(box, "next");
  const send = (await screen.findByRole("button", { name: "Send" })) as HTMLButtonElement;
  expect(send.disabled).toBe(true);
  await press(box, "Enter");
  expect(named("prompt")).toHaveLength(0);
  expect(document.querySelector('[data-slot="composer-placeholder"]')).toBeNull();
  expect(box.getAttribute("aria-placeholder")).toBe(
    "The agent is working. Stop it to send a message now.",
  );
  // The text stays: it goes when the turn is over.
  expect(boxText(box)).toBe("next");
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
});

test("a daemon that does not find files is not asked for them", async () => {
  const { user, bridge, named } = await mount({
    capabilities: { queue: true, files: false, folders: true },
  });
  bridge.searchFiles = async () => {
    throw new Error("must not be asked");
  };
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "@ma");
  await act(async () => {
    await sleep(250);
  });
  expect(screen.queryByRole("listbox", { name: "Files and folders" })).toBeNull();
  expect(named("searchFiles")).toHaveLength(0);
});

/** The sessions of the location, for the @ menu: the one open, two others, and one archived. */
const otherSessions = (script: ReturnType<typeof fakeBridge>) => {
  script.bridge.sessions = async (locationId: string) => [
    summary("s1", locationId),
    {
      ...summary("s2", locationId),
      cwd: "/repo/app",
      title: "Fix the login bug",
      updatedAt: "2020-01-01T00:00:00.000Z",
    },
    {
      ...summary("s3", locationId),
      title: "Login *styles*",
      updatedAt: "2020-01-01T12:00:00.000Z",
    },
    { ...summary("s4", locationId), title: "Old login notes", archived: true },
  ];
};

test("an @ lists the location's other sessions under their own heading; one picked is sent as a session link", async () => {
  const { user, bridge, named, calls } = await mount({
    capabilities: { queue: true, files: true, folders: true, sessionMentions: true },
    configure: otherSessions,
  });
  bridge.searchFiles = files([{ path: "src/login.ts", kind: "file" }]);
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "see @log");
  const menu = await screen.findByRole("listbox", { name: "Files, folders and sessions" });
  const rows = (name: string) =>
    within(within(menu).getByRole("group", { name }))
      .getAllByRole("option")
      .map((o) => o.querySelector('[data-slot="picker-name"]')?.textContent);
  expect(rows("Files and folders")).toEqual(["login.ts"]);
  // Not the one being written in, not an archived one; the most recent first.
  expect(rows("Sessions")).toEqual(["Login *styles*", "Fix the login bug"]);
  await press(box, "ArrowDown");
  await press(box, "ArrowDown");
  await press(box, "Enter");
  await waitFor(() => expect(boxText(box)).toBe("see @Fix the login bug "));
  await write(box, "please");
  await press(box, "Enter");
  await waitFor(() => expect(named("prompt")).toHaveLength(1));
  expect(named("prompt")[0]?.[3]).toEqual([
    { type: "text", text: "see @Fix the login bug please" },
    {
      type: "resource_link",
      name: "Fix the login bug",
      uri: "cycle://session/s2",
      _meta: { "cycle/mention": "Fix the login bug" },
    },
  ]);
  // What kind of thing was picked, never which.
  expect(calls.filter(([name, event]) => name === "track" && event === "mention_picked")).toEqual([
    ["track", "mention_picked", { kind: "session" }],
  ]);
});

test("a session's title is said without the marks Markdown would read", async () => {
  const { user, bridge } = await mount({
    capabilities: { queue: true, files: true, folders: true, sessionMentions: true },
    configure: otherSessions,
  });
  bridge.searchFiles = files([]);
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "@sty");
  await screen.findByRole("listbox", { name: "Files, folders and sessions" });
  await press(box, "Enter");
  await waitFor(() => expect(boxText(box)).toBe("@Login styles "));
});

test("a daemon that cannot give sessions to the agent has no sessions in the @ menu", async () => {
  const { user, bridge } = await mount({ configure: otherSessions });
  bridge.searchFiles = files([{ path: "src/login.ts", kind: "file" }]);
  await openFirstSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "@log");
  const menu = await screen.findByRole("listbox", { name: "Files and folders" });
  expect(within(menu).queryByRole("group")).toBeNull();
  expect(within(menu).getAllByRole("option")).toHaveLength(1);
});

test("while the first message makes the session it is shown, nothing can be changed, and a failure gives it back with the reason", async () => {
  let fail: (error: Error) => void = () => {};
  const { user, named } = await mount({
    configure: (script) => {
      script.bridge.createSession = () =>
        new Promise((_, reject) => {
          fail = reject;
        });
    },
  });
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "Fix the build");
  await press(box, "Enter");
  // The message is there, as it will be in the session, and the agent is being started for it.
  expect(await screen.findByText("Fix the build")).toBeTruthy();
  expect(screen.getAllByText("Starting the session…").length).toBeGreaterThan(0);
  const where = screen.getByRole("group", {
    name: "Where the session runs",
  }) as HTMLFieldSetElement;
  expect(where.disabled).toBe(true);
  await act(async () => {
    fail(new Error("No such folder"));
    await sleep(5);
  });
  expect(await screen.findByText("No such folder")).toBeTruthy();
  await waitFor(() => expect(boxText(box)).toBe("Fix the build"));
  expect(where.disabled).toBe(false);
  expect(named("prompt")).toEqual([]);
});

test("asking for a new session while one is blank keeps it as it is", async () => {
  const { user } = await mount();
  await user.click(await screen.findByRole("button", { name: "New session" }));
  await typeFolder(user, "/new/project");
  await user.click(screen.getByRole("button", { name: "New session" }));
  expect(await chosenFolder()).toBe("/new/project");
});

test("empty state offers Start a new session and high-risk mode chip carries data-danger", async () => {
  const { user } = await mount({
    configure: (script) => {
      script.bridge.agents = async () => [
        {
          id: "fake",
          name: "Fake",
          available: true,
          configSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                title: "Permission mode",
                oneOf: [
                  { const: "auto", title: "Auto", _meta: { "cycle/recommended": true } },
                  {
                    const: "bypassPermissions",
                    title: "Bypass permissions",
                    _meta: { "cycle/danger": true },
                  },
                ],
                default: "bypassPermissions",
              },
            },
          },
        },
      ];
    },
  });
  await user.click(await screen.findByRole("button", { name: "Start a new session" }));
  const chip = await screen.findByRole("button", { name: "Permission mode: Bypass permissions" });
  expect(chip.hasAttribute("data-danger")).toBe(true);
  expect(screen.getByRole("button", { name: "Hide sidebar" })).toBeTruthy();
});

test("composer uses a single-line box by default, stays one line with several buttons, and docks extensions above", async () => {
  const { user, emit } = await mount({
    configure: (script) => {
      const session = { ...summary("s1"), config: { mode: "auto", model: "opus", effort: "high" } };
      script.bridge.locations = async () => ({
        locations: [{ id: "local", name: "Local", kind: "local" }],
        status: [
          {
            locationId: "local",
            state: "connected",
            capabilities: { queue: true, files: false, folders: false },
          },
        ],
        sessions: { local: [session] },
      });
      script.bridge.agents = async () => [
        {
          id: "fake",
          name: "Fake",
          available: true,
          promptCapabilities: { image: {} },
          configSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                title: "Permission mode",
                oneOf: [{ const: "auto", title: "Auto" }],
              },
              model: {
                type: "string",
                title: "Model",
                oneOf: [{ const: "opus", title: "Opus" }],
              },
              effort: {
                type: "string",
                title: "Effort",
                oneOf: [
                  { const: "default", title: "Default" },
                  { const: "high", title: "High" },
                ],
              },
            },
          },
        },
      ];
      script.bridge.sessions = async () => [session];
    },
  });
  await openFirstSession(user);
  await screen.findByRole("textbox", { name: "Message" });

  // Idle with no extensions or attachments: compact single-line box, no extension tray, no legacy key-hints.
  const composerBox = document.querySelector('[data-slot="composer-box"]');
  expect(composerBox?.hasAttribute("data-multiline")).toBe(false);
  expect(document.querySelector('[data-slot="composer-extensions"]')).toBeNull();
  expect(document.querySelector('[data-slot="key-hints"]')).toBeNull();

  // Utility bar puts permission on the left, model, effort and context ring on the right.
  const toolsStart = document.querySelector<HTMLElement>('[data-slot="composer-tools-start"]');
  const toolsEnd = document.querySelector<HTMLElement>('[data-slot="composer-tools-end"]');
  expect(
    toolsStart && within(toolsStart).getByRole("button", { name: "Permission mode: Auto" }),
  ).toBeTruthy();
  expect(toolsEnd && within(toolsEnd).getByRole("button", { name: "Model: Opus" })).toBeTruthy();
  expect(toolsEnd && within(toolsEnd).getByRole("button", { name: "Effort: High" })).toBeTruthy();

  // Usage shows ring + percentage only; the numbers are in its details.
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    version: 1,
    update: {
      sessionUpdate: "usage_update",
      used: 12_000,
      size: 200_000,
      cost: { amount: 0.88, currency: "USD" },
    } as never,
  });
  const meter = await screen.findByRole("button", { name: "Context 6% full. Show details" });
  expect(meter.textContent).toBe("6%");

  // Plan + queued message dock inside the extension tray above the input box; the working state's buttons keep one line.
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    version: 2,
    update: { sessionUpdate: "state_update", state: "running" } as never,
  });
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    version: 3,
    update: {
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "p1",
        entries: [{ content: "Ship three-part composer", priority: "high", status: "in_progress" }],
      },
    } as never,
  });
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    version: 4,
    update: {
      sessionUpdate: "_cycle/queue_update",
      entries: [{ queueId: "q1", prompt: [{ type: "text", text: "Follow up next" }] }],
    } as never,
  });
  await waitFor(() => {
    const ext = document.querySelector('[data-slot="composer-extensions"]');
    expect(ext?.textContent).toContain("Ship three-part composer");
    expect(ext?.textContent).toContain("Follow up next");
    // Queue, Send now and Stop sit beside one line: several buttons do not make the box taller (CYCL-75).
    expect(
      document.querySelector('[data-slot="composer-box"]')?.hasAttribute("data-multiline"),
    ).toBe(false);
  });

  // Live config_option_update from the agent overlays newly discovered models and hides effort when unsupported.
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    version: 5,
    update: {
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          configId: "model",
          name: "Model",
          currentValue: "opus",
          options: [
            { value: "default", name: "Default model" },
            { value: "fabel", name: "Fabel" },
            { value: "opus", name: "Opus" },
          ],
        },
        {
          configId: "effort",
          name: "Effort",
          currentValue: "default",
          options: [{ value: "default", name: "Default" }],
        },
      ],
    } as never,
  });
  const modelButton = await screen.findByRole("button", { name: "Model: Opus" });
  await user.click(modelButton);
  expect(await screen.findByRole("menuitemradio", { name: "Fabel" })).toBeTruthy();
  // Model with only "default" effort has no Effort chip.
  expect(screen.queryByRole("button", { name: /^Effort:/ })).toBeNull();

  // Reaching 100% context marks the ring as full and settles cleanly at offset 0.
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    version: 6,
    update: { sessionUpdate: "usage_update", used: 200_000, size: 200_000 } as never,
  });
  const fullMeter = await screen.findByRole("button", { name: /Context 100% full/ });
  expect(fullMeter.hasAttribute("data-full")).toBe(true);
  expect(fullMeter.textContent).toBe("100%");
  const fill = fullMeter.querySelector<SVGCircleElement>('[data-slot="context-fill"]');
  expect(fill?.style.strokeDashoffset).toBe("0");
});

test("the composer's buttons are drawn 28px, take a press 32px across, and stay put when the box grows to many lines", async () => {
  const { user, emit } = await mount({
    configure: (script) => {
      const session = { ...summary("s1"), config: { mode: "auto", model: "opus" } };
      script.bridge.sessions = async () => [session];
      script.bridge.agents = async () => [
        {
          id: "fake",
          name: "Fake",
          available: true,
          promptCapabilities: { image: {} },
          configSchema: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                title: "Permission mode",
                oneOf: [{ const: "auto", title: "Auto" }],
              },
              model: { type: "string", title: "Model", oneOf: [{ const: "opus", title: "Opus" }] },
            },
          },
        },
      ];
    },
  });
  await openFirstSession(user);
  const input = await screen.findByRole("textbox", { name: "Message" });
  await ready(input);
  emit({
    type: "update",
    locationId: "local",
    sessionId: "s1",
    version: 1,
    update: { sessionUpdate: "usage_update", used: 12_000, size: 200_000 } as never,
  });
  const meter = await screen.findByRole("button", { name: /^Context 6% full/ });
  const box = document.querySelector<HTMLElement>('[data-slot="composer-box"]');
  const plus = document.querySelector<HTMLElement>('[data-kind="composer-plus"]');
  const send = document.querySelector<HTMLElement>('[data-action="send"]');
  if (box === null || plus === null || send === null) throw new Error("no composer");
  const chip = screen.getByRole("button", { name: "Model: Opus" });

  // One line: 28px circles in a 42px box (6px padding and a 1px border round 28).
  for (const button of [plus, send]) {
    const r = button.getBoundingClientRect();
    expect(r.width).toBeCloseTo(28, 0);
    expect(r.height).toBeCloseTo(28, 0);
  }
  expect(box.getBoundingClientRect().height).toBeCloseTo(42, 0);
  // The + has a fill of its own before it is hovered, a step off the box's.
  const fill = getComputedStyle(plus).backgroundColor;
  expect(fill).not.toBe("rgba(0, 0, 0, 0)");
  expect(fill).not.toBe(getComputedStyle(box).backgroundColor);

  // A press 2px outside the drawn circle still lands on the button: the hit area is 32px across.
  const hits = (el: HTMLElement, x: number, y: number) =>
    document.elementFromPoint(x, y)?.closest("button") === el;
  for (const button of [plus, send]) {
    const r = button.getBoundingClientRect();
    const midY = r.top + r.height / 2;
    const midX = r.left + r.width / 2;
    expect(hits(button, r.left - 1.5, midY)).toBe(true);
    expect(hits(button, r.right + 1.5, midY)).toBe(true);
    expect(hits(button, midX, r.top - 1.5)).toBe(true);
    expect(hits(button, midX, r.bottom + 1.5)).toBe(true);
    expect(hits(button, r.left - 3, midY)).toBe(false);
  }

  // The bar below: 24px chips at the meta size that take a press 32px tall.
  for (const item of [chip, meter]) {
    const r = item.getBoundingClientRect();
    expect(r.height).toBeCloseTo(24, 0);
    expect(getComputedStyle(item).fontSize).toBe("12px");
    const midX = r.left + r.width / 2;
    expect(hits(item, midX, r.top - 3.5)).toBe(true);
    expect(hits(item, midX, r.bottom + 3.5)).toBe(true);
  }

  // Many lines: the + and Send keep their inset from the box's corners, so promoting the box moves neither.
  const inset = () => {
    const b = box.getBoundingClientRect();
    const p = plus.getBoundingClientRect();
    const s = send.getBoundingClientRect();
    return { left: p.left - b.left, right: b.right - s.right, bottom: b.bottom - s.bottom };
  };
  const one = inset();
  await write(input, "first line");
  await press(input, "Enter", { shiftKey: true });
  await write(input, "second line");
  await waitFor(() => expect(box.hasAttribute("data-multiline")).toBe(true));
  const many = inset();
  expect(many.left).toBeCloseTo(one.left, 0);
  expect(many.right).toBeCloseTo(one.right, 0);
  expect(many.bottom).toBeCloseTo(one.bottom, 0);
  // And the text starts 16px inside the border, as it does on one line when there is no +.
  const paragraph = input.firstElementChild as HTMLElement;
  expect(
    paragraph.getBoundingClientRect().left - box.getBoundingClientRect().left - box.clientLeft,
  ).toBeCloseTo(16, 0);
});

test("the context ring opens into what was reported: nothing yet, now's usage part by part, and one from before a compaction", async () => {
  const { user, emit, calls } = await mount({
    configure: (script) => {
      const session = summary("s1");
      script.bridge.sessions = async () => [session];
    },
  });
  await openFirstSession(user);
  await screen.findByRole("textbox", { name: "Message" });
  const update = (version: number, u: object) =>
    emit({ type: "update", locationId: "local", sessionId: "s1", version, update: u as never });
  const tracked = () =>
    calls.filter(([name]) => name === "track").map(([, event, props]) => [event, props]);
  const dialog = () => screen.findByRole("dialog", { name: "Context window" });
  const rows = (root: HTMLElement) =>
    [...root.querySelectorAll('[data-slot="context-part"]')].map((row) =>
      [...row.children].map((cell) => cell.textContent).join("|"),
    );

  // Nothing reported yet: an empty ring, and details that say so rather than a number.
  const empty = await screen.findByRole("button", {
    name: "Context usage not reported yet. Show details",
  });
  expect(empty.hasAttribute("data-empty")).toBe(true);
  await user.click(empty);
  const details = await dialog();
  expect(details.textContent).toBe("Context windowNo usage reported yet");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Context window" })).toBeNull());
  expect(document.activeElement).toBe(empty);

  // Measured with what the window holds: the total and its share, then a row a part (used ones largest first, then
  // what is kept for compaction and what is free; a part not loaded is not one of them), then the facts. No notes.
  update(1, {
    sessionUpdate: "usage_update",
    used: 161_300,
    size: 200_000,
    cost: { amount: 0.52, currency: "USD" },
    _meta: {
      "cycle/context": {
        window: 200_000,
        autoCompactAt: 167_000,
        parts: [
          { id: "system_prompt", name: "System prompt", tokens: 6_000, kind: "used" },
          { id: "messages", name: "Messages", tokens: 155_300, kind: "used" },
          {
            id: "mcp_tools_deferred",
            name: "MCP tools (deferred)",
            tokens: 89_300,
            kind: "deferred",
          },
          { name: "Something new", tokens: 40, kind: "used" },
          { id: "free_space", name: "Free space", tokens: 5_700, kind: "free" },
          { id: "autocompact_buffer", name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
        ],
      },
    },
  });
  const ring = await screen.findByRole("button", { name: "Context 81% full. Show details" });
  await user.click(ring);
  const now = await dialog();
  expect(now.querySelector('[data-slot="context-total"]')?.textContent).toBe("161.3K / 200K (81%)");
  expect(rows(now)).toEqual([
    "|Messages|155.3K|77.7%",
    "|System prompt|6.0K|3.0%",
    "|Something new|40|<0.1%",
    "|Autocompact buffer|33.0K|16.5%",
    "|Free space|5.7K|2.9%",
  ]);
  expect(now.querySelector('[data-slot="context-facts"]')?.textContent).toBe(
    "Auto-compacts at167KSession cost$0.52",
  );
  expect(now.querySelector('[data-slot="context-state"]')).toBeNull();
  await user.click(ring);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Context window" })).toBeNull());

  // A compaction completed and no usage came after it: the total is kept and said to be from before; its parts,
  // which say nothing of the window now, are not shown.
  update(2, { sessionUpdate: "compaction_update", compactionId: "k1", status: "in_progress" });
  update(3, { sessionUpdate: "compaction_update", compactionId: "k1", status: "completed" });
  const stale = await screen.findByRole("button", {
    name: "Context was 81% full before the last compaction. Show details",
  });
  expect(stale.hasAttribute("data-before")).toBe(true);
  await user.click(stale);
  const before = await dialog();
  expect(before.querySelector('[data-slot="context-state"]')?.textContent).toBe(
    "From before the last compaction",
  );
  expect(rows(before)).toEqual([]);
  expect(before.querySelector('[data-slot="context-facts"]')?.textContent).toContain(
    "Compactions1",
  );
  await user.keyboard("{Escape}");

  // A usage with no parts (the one after a compaction, or an agent that does not count them) is the total alone,
  // and no parts of an earlier usage come with it; where it compacts stays, the window being the same. A currency
  // Intl does not know is written as given.
  update(4, {
    sessionUpdate: "usage_update",
    used: 30_000,
    size: 200_000,
    cost: { amount: 3, currency: "credits" },
  });
  const fresh = await screen.findByRole("button", { name: "Context 15% full. Show details" });
  await user.click(fresh);
  const plain = await dialog();
  expect(rows(plain)).toEqual([]);
  expect(plain.textContent).toContain("Session cost3 credits");
  expect(plain.textContent).toContain("Auto-compacts at167K");
  await user.keyboard("{Escape}");

  // Only what kind of state it was, and whether parts or plan limits were shown, is counted; no number goes with it.
  const opened = tracked().filter(([event]) => event === "context_details_opened");
  expect(opened).toEqual([
    ["context_details_opened", { state: "empty", parts: false, plan: false }],
    ["context_details_opened", { state: "measured", parts: true, plan: false }],
    ["context_details_opened", { state: "before_compaction", parts: false, plan: false }],
    ["context_details_opened", { state: "measured", parts: false, plan: false }],
  ]);
  expect(JSON.stringify(opened)).not.toMatch(/161|200|0\.52/);
});

test("the account's plan limits show under the context: the latest the daemon heard, gone once a limit starts over", async () => {
  const now = Date.now();
  let daemonHas: () => Record<string, PlanUsage> = () => ({});
  const { user, emit, calls } = await mount({
    configure: (script) => {
      script.bridge.sessions = async () => [summary("s1")];
      script.bridge.planUsage = async () => daemonHas();
      // What the daemon heard before the app connected: one limit getting close, one that has since started over.
      daemonHas = () => ({
        fake: {
          at: now - 60_000,
          windows: [
            { kind: "five_hour", utilization: 0.74, resetsAt: now + 43 * 60_000 + 30_000 },
            { kind: "seven_day", utilization: 0.31, resetsAt: now - 1_000 },
            // A limit Cycle does not know by name is not shown.
            { kind: "seven_day_overage_included", utilization: 0.2, resetsAt: now + 60_000 },
          ],
        },
        // Another agent's account is not this session's.
        other: {
          at: now,
          windows: [{ kind: "seven_day", utilization: 0.9, resetsAt: now + 60_000 }],
        },
      });
    },
  });
  await openFirstSession(user);
  await screen.findByRole("textbox", { name: "Message" });
  const limits = (root: HTMLElement) =>
    [...root.querySelectorAll('[data-slot="plan-limit"]')].map(
      (row) =>
        `${row.querySelector('[data-slot="plan-limit-name"]')?.textContent}|${row.querySelector('[data-slot="plan-limit-value"]')?.textContent}|${row.getAttribute("data-tone") ?? ""}`,
    );

  const ring = await screen.findByRole("button", {
    name: "Context usage not reported yet. Show details",
  });
  await user.click(ring);
  const details = await screen.findByRole("dialog", { name: "Context window" });
  expect(limits(details)).toEqual(["5-hour limit|74% · resets in 44m|attention"]);
  await user.keyboard("{Escape}");

  // A newer word from the agent replaces it; one with a later reset reads as a day and a time.
  emit({
    type: "plan-usage",
    locationId: "local",
    agent: "fake",
    usage: {
      at: now,
      windows: [
        {
          kind: "five_hour",
          utilization: 0.95,
          resetsAt: now + 3 * 3_600_000 + 5 * 60_000 + 30_000,
          status: "allowed_warning",
        },
        { kind: "seven_day", utilization: 0.996, resetsAt: now + 3 * 86_400_000 },
      ],
    },
  });
  await user.click(ring);
  const again = await screen.findByRole("dialog", { name: "Context window" });
  const rows = limits(again);
  expect(rows[0]).toBe("5-hour limit|95% · resets in 3h 6m|danger");
  // Not yet at the limit does not read as at it: 99.6% is 99%.
  expect(rows[1]).toMatch(/^Weekly limit\|99% · resets .+\|danger$/);
  await user.keyboard("{Escape}");

  // The connection comes back to a daemon that has none (it restarted, or the agent is signed in with a key now):
  // what was kept from before goes.
  daemonHas = () => ({});
  emit({ type: "location-status", locationId: "local", state: "reconnecting" });
  emit({ type: "location-status", locationId: "local", state: "connected" });
  await waitFor(async () => {
    await user.click(ring);
    const shown = await screen.findByRole("dialog", { name: "Context window" });
    const none = shown.querySelector('[data-slot="plan-usage"]') === null;
    await user.keyboard("{Escape}");
    expect(none).toBe(true);
  });

  // Whether the limits were shown is counted, never how much of them is used.
  const opened = calls
    .filter(([name, event]) => name === "track" && event === "context_details_opened")
    .map(([, , props]) => props);
  expect(opened.slice(0, 2)).toEqual([
    { state: "empty", parts: false, plan: true },
    { state: "empty", parts: false, plan: true },
  ]);
  expect(opened.at(-1)).toEqual({ state: "empty", parts: false, plan: false });
  expect(JSON.stringify(opened)).not.toMatch(/74|95|99/);
});

test("with no plan limits told (a login with an API key), the context shows none", async () => {
  const { user } = await mount({
    configure: (script) => {
      script.bridge.sessions = async () => [summary("s1")];
    },
  });
  await openFirstSession(user);
  await user.click(
    await screen.findByRole("button", { name: "Context usage not reported yet. Show details" }),
  );
  const details = await screen.findByRole("dialog", { name: "Context window" });
  expect(details.querySelector('[data-slot="plan-usage"]')).toBeNull();
});
