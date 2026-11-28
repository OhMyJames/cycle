import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { PermissionRequest, SessionSnapshot } from "../../src/api.ts";
import { displayMode } from "../../src/display-mode.ts";
import { applyUpdate, emptyConversation } from "../../src/model/index.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { reveal } from "../../src/reveal.ts";
import { startedAt } from "../../src/started.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge } from "../fake-bridge.ts";
import { LONG_CODE_LINES, READING } from "../markdown-samples.ts";
import { openSettings } from "./account-menu.ts";
import { findAlert } from "./alert.ts";
import { renderApp } from "./render-app.tsx";

/** The session these tests open, by its view key: what its display mode is kept under. */
const SESSION = "local:s1";

beforeEach(() => displayMode.set(SESSION, "normal"));
afterEach(() => {
  cleanup();
  displayMode.set(SESSION, "normal");
  // A panel opened here is kept per session, and the files that run beside this one read the same storage.
  localStorage.clear();
});

const u = (update: object) => update as SessionUpdate;
const you = (id: string) =>
  u({ sessionUpdate: "user_message", messageId: id, content: [{ type: "text", text: id }] });
const say = (id: string) =>
  u({ sessionUpdate: "agent_message", messageId: id, content: [{ type: "text", text: id }] });
const think = (id: string, text: string) =>
  u({ sessionUpdate: "agent_thought", messageId: id, content: [{ type: "text", text }] });
const tool = (id: string, name: string, status: string, rawInput: object) => [
  u({ sessionUpdate: "tool_call_update", toolCallId: id, name, status: "pending" }),
  u({ sessionUpdate: "tool_call_update", toolCallId: id, status, rawInput }),
];
const state = (extra: object) => u({ sessionUpdate: "state_update", ...extra });

/** The session `s1`, open, with these updates in it; `stopSubagent`: its daemon can stop one sub-agent alone. */
const openWith = async (
  options: {
    stopSubagent?: boolean;
    fs?: boolean;
    stopped?: (childId: string) => Promise<boolean>;
  },
  ...updates: SessionUpdate[]
) => {
  const snapshot = (): SessionSnapshot => ({
    conversation: updates.reduce((c, u) => applyUpdate(c, u), emptyConversation()),
    permissions: [],
    version: updates.length,
  });
  const script = fakeBridge({
    connected: true,
    snapshot,
    ...(options.stopped !== undefined ? { stopSubagent: options.stopped } : {}),
    ...(options.stopSubagent === true || options.fs === true
      ? {
          capabilities: {
            queue: true,
            files: true,
            folders: true,
            ...(options.stopSubagent === true ? { stopSubagent: true } : {}),
            ...(options.fs === true ? { fs: true } : {}),
          },
        }
      : {}),
  });
  await renderApp(script.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: /work/ }));
  const log = await screen.findByRole("log", { name: "Conversation" });
  let version = updates.length;
  const emit = (...batch: SessionUpdate[]) =>
    act(() => {
      for (const update of batch) {
        version += 1;
        script.emit({ type: "update", locationId: "local", sessionId: "s1", update, version });
      }
    });
  /** The agent asks for leave, as the next thing the session says. */
  const ask = (request: PermissionRequest) => {
    version += 1;
    return act(() => script.emit({ type: "permission", request, version }));
  };
  return { user, log, emit, ask, script };
};
const open = (...updates: SessionUpdate[]) => openWith({}, ...updates);

/** A turn that ended normally folds its work above its answer: opens each fold, so its rows can be read. */
const openWork = async (user: ReturnType<typeof userEvent.setup>) => {
  for (const fold of await screen.findAllByRole("button", { name: /^Worked/ }))
    await user.click(fold);
};

test("two tool calls in a row are one card that says what they were, and opens to the rows", async () => {
  const { user, log } = await open(
    you("u1"),
    ...tool("a", "Bash", "completed", { command: "make" }),
    ...tool("b", "Read", "completed", { file_path: "a.ts" }),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  const card = await screen.findByRole("button", { name: /Ran 1 command and read 1 file/ });
  // Closed: the rows are not on screen yet.
  expect(card.getAttribute("aria-expanded")).toBe("false");
  expect(log.textContent).not.toContain("a.ts");
  await user.click(card);
  expect(card.getAttribute("aria-expanded")).toBe("true");
  await waitFor(() => expect(log.textContent).toContain("a.ts"));
});

test("a single tool call is a row of its own, not a card", async () => {
  const { log } = await open(
    you("u1"),
    ...tool("a", "Bash", "completed", { command: "make -j4" }),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  await waitFor(() => expect(log.textContent).toContain("make -j4"));
  expect(log.textContent).not.toContain("Ran 1 command");
});

test("a tool row says what it did with a verb in its tense, and only a failure says so in a word", async () => {
  const { log, emit } = await open(
    you("u1"),
    ...tool("a", "Bash", "in_progress", { command: "bun test" }),
    state({ state: "running" }),
  );
  const row = await screen.findByRole("button", { name: /Running/ });
  expect(row.textContent).toContain("bun test");
  // The tool's name is still in what a screen reader is told.
  expect(row.textContent).toContain("Bash");
  await emit(u({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /Ran/ })).toBeTruthy());
  await emit(u({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "failed" }));
  await waitFor(() =>
    expect(log.querySelector('[data-slot="tool-status"]')?.textContent).toBe("failed"),
  );
});

test("a call with a description reads as it alone, what it ran only in its tooltip and name; a mention is not drawn twice", async () => {
  const { log } = await open(
    u({
      sessionUpdate: "user_message",
      messageId: "u1",
      content: [
        { type: "text", text: "Look at @src/a.ts" },
        {
          type: "resource_link",
          name: "a.ts",
          uri: "file:///p/src/a.ts",
          _meta: { "cycle/mention": "src/a.ts" },
        },
      ],
    }),
    ...tool("a", "Bash", "completed", { command: "bun test", description: "Run the tests" }),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  const row = await screen.findByRole("button", { name: /Run the tests/ });
  expect(row.querySelector('[data-slot="tool-verb"]')?.textContent).toBe("Run the tests");
  expect(row.querySelector('[data-slot="tool-summary"]')?.textContent).toBe("");
  // Not on the line, but still in the row's name for a screen reader.
  expect(row.textContent).toContain("bun test");
  expect(row.querySelector('[data-slot="tool-verb"]')?.getAttribute("title")).toBe(
    "Bash: Run the tests\nbun test",
  );
  expect(log.textContent).not.toContain("resource_link");
  expect(log.textContent).toContain("@src/a.ts");
});

test("a session named with @ is a chip in the sent message, and the record the agent was given is not shown", async () => {
  const { log } = await open(
    u({
      sessionUpdate: "user_message",
      messageId: "u1",
      content: [
        { type: "text", text: "Go on from @Fix the login bug, then @Gone" },
        {
          type: "resource_link",
          name: "Fix the login bug",
          uri: "cycle://session/s2",
          _meta: { "cycle/mention": "Fix the login bug" },
        },
        {
          type: "resource_link",
          name: "Unsaid",
          uri: "cycle://session/s3",
          _meta: { "cycle/mention": "Unsaid" },
        },
      ],
    }),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  const chips = await waitFor(() => {
    const found = [...log.querySelectorAll('[data-slot="mention-chip"]')];
    expect(found).toHaveLength(2);
    return found;
  });
  expect(chips.map((c) => [c.textContent, c.getAttribute("title")])).toEqual([
    ["Fix the login bug", "Fix the login bug"],
    // One the words no longer say is still shown.
    ["Unsaid", "Unsaid"],
  ]);
  const message = chips[0]?.closest('[data-slot="message"]');
  expect(message?.textContent).toBe("Go on from Fix the login bug, then @GoneUnsaid");
});

test("a sent @ is the box's block for a session and for a file or folder inside the session's folder; one outside stays words", async () => {
  const link = (name: string, uri: string) => ({
    type: "resource_link",
    name,
    uri,
    _meta: { "cycle/mention": name },
  });
  const { log } = await openWith(
    { fs: true },
    u({
      sessionUpdate: "user_message",
      messageId: "u1",
      content: [
        { type: "text", text: "See @src/a.ts, @src/lib/, @Other and @../far/x.ts" },
        link("src/a.ts", "file:///work/src/a.ts"),
        link("src/lib", "file:///work/src/lib/"),
        link("Other", "cycle://session/s2"),
        link("../far/x.ts", "file:///far/x.ts"),
      ],
    }),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  const chips = await waitFor(() => {
    const found = [...log.querySelectorAll('[data-slot="mention-chip"]')];
    expect(found).toHaveLength(3);
    return found;
  });
  expect(chips.map((c) => [c.getAttribute("data-kind"), c.textContent])).toEqual([
    ["file", "src/a.ts"],
    ["folder", "src/lib/"],
    ["session", "Other"],
  ]);
  // Each has the icon of its kind, as the box's block has.
  expect(chips.every((c) => c.querySelector("svg") !== null)).toBe(true);
  expect(chips[0]?.closest('[data-slot="message"]')?.textContent).toContain("@../far/x.ts");
});

test("only a purpose sentence is a description: an MCP tool's description field is content, not the line", async () => {
  await open(
    you("u1"),
    ...tool("a", "mcp__tracker__create_issue", "completed", {
      title: "Fix login",
      description: "A long body\nwith several lines",
    }),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  const row = await screen.findByRole("button", { name: /mcp__tracker__create_issue/ });
  expect(row.querySelector('[data-slot="tool-verb"]')?.textContent).toBe(
    "mcp__tracker__create_issue",
  );
  expect(row.textContent).not.toContain("A long body");
});

test("a turn that failed says how, and the failed call is a row under the card, not in it", async () => {
  const { log } = await open(
    you("u1"),
    ...tool("a", "Bash", "completed", { command: "make" }),
    ...tool("b", "Bash", "completed", { command: "make test" }),
    ...tool("c", "Bash", "failed", { command: "make install" }),
    state({ state: "idle", stopReason: "error", error: { message: "disk full" } }),
  );
  const alert = await findAlert();
  expect(alert.textContent).toContain("The turn failed: disk full");
  const card = await screen.findByRole("button", { name: /Ran 2 commands/ });
  const row = await screen.findByRole("button", { name: /Bash.*make install/ });
  // Outside the card (which holds the two that went well), and closed as every row starts: its head says it failed.
  expect(card.closest('[data-kind="work"]')?.contains(row)).toBe(false);
  expect(row.getAttribute("aria-expanded")).toBe("false");
  expect(row.querySelector('[data-slot="tool-status"]')?.textContent).toBe("failed");
  expect(log.textContent).not.toContain("make test");
});

test("a failure that arrives while the card is on screen leaves it closed, and its line says so", async () => {
  const { log, emit } = await open(
    you("u1"),
    state({ state: "running" }),
    ...tool("a", "Bash", "in_progress", { command: "make" }),
    ...tool("b", "Bash", "in_progress", { command: "make test" }),
  );
  const card = await screen.findByRole("button", { name: /Ran 2 commands/ });
  expect(card.getAttribute("aria-expanded")).toBe("false");
  await emit(
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "b",
      status: "failed",
      rawInput: { command: "make test" },
    }),
  );
  // The other call is still going, and the card says both; it stays as the person left it.
  await waitFor(() => expect(log.textContent).toContain("1 failed"));
  expect(log.textContent).toContain("Running");
  // Rendered again later (the clock ticks), it is still closed.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(card.getAttribute("aria-expanded")).toBe("false");
});

test("a turn the person stopped says so, with the word and not only a colour", async () => {
  await open(you("u1"), state({ state: "idle", stopReason: "cancelled" }));
  await screen.findByText("Stopped before it finished.");
});

/** Emits updates with the time the daemon logged them, as a session that is going gets them. */
const timed = (script: Awaited<ReturnType<typeof open>>["script"], from: number) => {
  let version = from;
  return (update: SessionUpdate, at?: number) =>
    act(() =>
      script.emit({
        type: "update",
        locationId: "local",
        sessionId: "s1",
        update,
        ...(at !== undefined ? { at } : {}),
        version: ++version,
      }),
    );
};
const thoughtChunk = (text: string) =>
  u({ sessionUpdate: "agent_thought_chunk", messageId: "t1", content: { type: "text", text } });
const answerChunk = (text: string) =>
  u({ sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text } });

test("in normal mode a thought is not shown: the line at the end says Thinking… while it goes, then Writing…", async () => {
  const { log, script } = await open(you("u1"), state({ state: "running" }));
  const emit = timed(script, 2);
  await emit(thoughtChunk("weighing **the options**"));
  await waitFor(() => expect(log.textContent?.match(/Thinking…/g)).toHaveLength(1));
  expect(log.textContent).not.toContain("weighing");
  expect(log.querySelector('[data-kind="thought"]')).toBeNull();
  await emit(answerChunk("answer"));
  await waitFor(() => expect(log.textContent).toContain("answer"));
  expect(log.textContent).not.toContain("weighing");
  // Held a moment, so a short thought does not flicker, then the line says the reply is on its way.
  await waitFor(() => expect(log.textContent).toContain("Writing…"));
  expect(log.textContent).not.toContain("Thinking…");
});

test("detailed mode, set in Session settings, shows the thinking itself as an italic quote, and is told", async () => {
  const { user, log, script } = await open(
    you("u1"),
    think("t1", "weighing **the options**"),
    say("a1"),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  await waitFor(() => expect(log.textContent).toContain("a1"));
  expect(log.textContent).not.toContain("weighing");
  // With the session's settings, not in Settings → Appearance.
  await openSettings(user);
  await user.click(await screen.findByRole("tab", { name: "Appearance" }));
  expect(screen.queryByRole("switch", { name: /thinking/i })).toBeNull();
  await user.keyboard("{Escape}");
  await user.click(await screen.findByRole("button", { name: "Session actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Session settings" }));
  const dialog = await screen.findByRole("dialog");
  const choice = within(dialog).getByRole("combobox", { name: "Display mode" });
  expect(choice.textContent).toContain("Normal");
  await user.click(choice);
  await user.click(await screen.findByRole("option", { name: /^Detailed/ }));
  await waitFor(() => expect(choice.textContent).toContain("Detailed"));
  expect(displayMode.get(SESSION)).toBe("detailed");
  // The turn is over, so its thinking is in the work folded above the answer.
  await user.keyboard("{Escape}");
  await openWork(user);
  // Shown at once, not behind a row to open; markdown through the same path as a reply: the bold is bold.
  const thought = await waitFor(() => {
    const found = log.querySelector('blockquote[data-kind="thought"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  expect(within(thought).queryByRole("button")).toBeNull();
  expect(thought.querySelector('[data-streamdown="strong"]')).not.toBeNull();
  expect(thought.textContent).toContain("weighing the options");
  expect(
    getComputedStyle(thought.querySelector('[data-role="thought"]') as Element).fontStyle,
  ).toBe("italic");
  // The mode, never the words.
  expect(
    script.calls.filter(([name, event]) => name === "track" && event === "display_mode_changed"),
  ).toEqual([["track", "display_mode_changed", { mode: "detailed" }]]);
  // It is this session's mode, kept for the next time it is opened.
  expect(displayMode.get("local:other")).toBe("normal");
});

test("in detailed mode a thought streams in place; one with no words shows nothing; the line says Thinking… under it", async () => {
  displayMode.set(SESSION, "detailed");
  const { log, script } = await open(you("u1"), state({ state: "running" }));
  const emit = timed(script, 2);
  await emit(thoughtChunk(""));
  await waitFor(() => expect(log.textContent).toContain("Thinking…"));
  expect(log.querySelector('[data-kind="thought"]')).toBeNull();
  await emit(thoughtChunk("weighing"));
  const thought = await screen.findByRole("blockquote", { name: "Thinking" });
  expect(thought.textContent).toContain("weighing");
  expect(thought.hasAttribute("data-live")).toBe(true);
  // The words are an aside: until what comes next, the line at the end still says the agent is at it.
  expect(log.textContent).toContain("Thinking…");
  await emit(answerChunk("answer"));
  await waitFor(() => expect(log.textContent).not.toContain("Thinking…"));
  expect(thought.hasAttribute("data-live")).toBe(false);
});

test("a long thought is at most eight lines tall, scrolls within, and follows what is written until scrolled back", async () => {
  displayMode.set(SESSION, "detailed");
  const { script } = await open(you("u1"), state({ state: "running" }));
  const emit = timed(script, 2);
  const lines = (from: number, count: number) =>
    Array.from({ length: count }, (_, n) => `Line ${from + n} of the thought.\n\n`).join("");
  await emit(thoughtChunk(lines(1, 4)));
  const thought = await screen.findByRole("blockquote", { name: "Thinking" });
  const box = thought.querySelector('[data-slot="thought-scroll"]') as HTMLElement;
  // Short, it is all there, and no stop for the keyboard.
  expect(box.scrollHeight).toBeLessThanOrEqual(box.clientHeight + 1);
  expect(box.hasAttribute("tabindex")).toBe(false);
  await emit(thoughtChunk(lines(5, 30)));
  const lineHeight = Number.parseFloat(getComputedStyle(box).lineHeight);
  await waitFor(() => expect(box.getAttribute("tabindex")).toBe("0"));
  expect(box.clientHeight).toBeLessThanOrEqual(Math.ceil(lineHeight * 8) + 1);
  // While written, the newest words are in sight.
  const atEnd = () => box.scrollHeight - box.scrollTop - box.clientHeight <= 2;
  await waitFor(() => expect(atEnd()).toBe(true));
  // Scrolled back to read, the reader is left there as more comes.
  await act(async () => {
    box.scrollTop = 0;
    box.dispatchEvent(new Event("scroll"));
  });
  await emit(thoughtChunk(lines(35, 5)));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(box.scrollTop).toBe(0);
  // At its top with more below, the box fades at its foot (a scroll-driven mask, not motion).
  await waitFor(() => expect(getComputedStyle(box).maskImage).toContain("linear-gradient"));
  // The quote's rule is drawn whole, outside what scrolls and fades.
  expect(getComputedStyle(thought).maskImage).toBe("none");
});

test("a message says when it was sent and a reply when it finished, with the full time on focus; none when not known", async () => {
  const { user, log, script } = await open(you("old"));
  // The history from an older daemon carries no time: nothing is shown for it.
  await waitFor(() => expect(log.textContent).toContain("old"));
  expect(log.querySelector('[data-kind="message-time"]')).toBeNull();
  const now = Date.now();
  let version = 1;
  const emit = (update: SessionUpdate, at: number) =>
    act(() =>
      script.emit({
        type: "update",
        locationId: "local",
        sessionId: "s1",
        update,
        at,
        version: ++version,
      }),
    );
  await emit(state({ state: "idle", stopReason: "end_turn" }), now - 4 * 60_000);
  await emit(you("u2"), now - 3 * 60_000);
  await emit(
    u({
      sessionUpdate: "agent_message_chunk",
      messageId: "a2",
      content: { type: "text", text: "done" },
    }),
    now - 2 * 60_000,
  );
  // While the reply streams it has no finished time yet.
  await waitFor(() => expect(log.textContent).toContain("done"));
  expect(log.querySelectorAll('[data-kind="message-time"]')).toHaveLength(1);
  await emit(state({ state: "idle", stopReason: "end_turn" }), now - 2 * 60_000);
  await waitFor(() => expect(log.querySelectorAll('[data-kind="message-time"]')).toHaveLength(2));
  const [sent, finished] = log.querySelectorAll<HTMLElement>('[data-kind="message-time"]');
  expect(sent?.textContent).toBe("3 minutes ago");
  expect(finished?.textContent).toBe("2 minutes ago");
  // Quiet until asked for: its row under the message is hidden, then shown on keyboard focus with the full date and time.
  const row = (sent as HTMLElement).closest('[data-slot="message-actions"]') as HTMLElement;
  expect(getComputedStyle(row).opacity).toBe("0");
  (sent as HTMLElement).focus();
  await user.keyboard("{Shift>}{Tab}{/Shift}{Tab}");
  const tip = await screen.findByRole("tooltip");
  expect(tip.textContent).toContain("Sent");
  expect(tip.textContent).toContain(String(new Date(now - 3 * 60_000).getFullYear()));
});

const turnsOf = (n: number, from = 0) =>
  Array.from({ length: n }, (_, k) => [
    you(`question ${from + k}`),
    u({
      sessionUpdate: "agent_message",
      messageId: `m${from + k}`,
      content: [{ type: "text", text: `answer ${from + k}` }],
    }),
    state({ state: "idle", stopReason: "end_turn" }),
  ]).flat();

const drawn = (log: HTMLElement) => log.querySelectorAll('[data-slot="block"]').length;

/** The window's height, as #root has it in the app: the conversation scrolls inside it. */
const constrain = (log: HTMLElement) => {
  const root = log.closest('[data-slot="app"]')?.parentElement;
  if (root instanceof HTMLElement) root.style.height = "100%";
};
const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/** The text of the blocks drawn, in order. */
const drawnText = (log: HTMLElement) =>
  Array.from(log.querySelectorAll('[data-slot="block"]'), (b) => b.textContent ?? "");

test("a long conversation opens at its end and draws only the blocks near the view", async () => {
  const { log } = await open(...turnsOf(400));
  constrain(log);
  await waitFor(() => expect(log.textContent).toContain("answer 399"));
  await waitFor(() => expect(drawn(log)).toBeLessThan(80));
  expect(log.textContent).not.toContain("question 0");
  expect(log.textContent).not.toContain("question 300");
  // The room of the blocks not drawn is there, and the view is at the end.
  expect(log.scrollHeight).toBeGreaterThan(log.clientHeight * 10);
  await waitFor(() => expect(log.scrollHeight - log.scrollTop - log.clientHeight).toBeLessThan(2));
  expect(log.querySelector('[data-slot="earlier"]')).toBeNull();
});

test("scrolling up brings the blocks above into view and lets the ones left behind go, in order and in place", async () => {
  const { log } = await open(...turnsOf(400));
  constrain(log);
  await waitFor(() => expect(drawn(log)).toBeLessThan(80));
  await settle();
  // Up a long way, in steps, as a reader does: what is drawn follows, and the reader keeps their place.
  for (let step = 0; step < 40; step++) {
    log.scrollTop -= log.clientHeight;
    await settle();
  }
  expect(log.textContent).not.toContain("answer 399");
  expect(drawn(log)).toBeLessThan(80);
  // The blocks drawn are consecutive: each question is followed by its answer.
  const texts = drawnText(log);
  expect(texts.length).toBeGreaterThan(2);
  const firstQuestion = texts.findIndex((t) => t.startsWith("question"));
  const n = Number(/^question (\d+)/.exec(texts[firstQuestion] ?? "")?.[1]);
  expect(texts[firstQuestion + 1]).toContain(`answer ${n}`);
  // All the way up: the first message is there, below the top of the view, and the view does not slip away from the top.
  for (let i = 0; i < 100 && log.scrollTop > 0; i++) {
    log.scrollTop = 0;
    await settle();
  }
  await waitFor(() => expect(log.textContent).toContain("question 0"));
  await settle();
  expect(log.scrollTop).toBe(0);
  const first = log.querySelector('[data-slot="block"]')?.getBoundingClientRect();
  expect((first?.top ?? 0) - log.getBoundingClientRect().top).toBeGreaterThanOrEqual(16);
  expect(drawn(log)).toBeLessThan(80);
  // And back down to the end: the last answer is drawn again.
  log.scrollTop = log.scrollHeight;
  await waitFor(() => expect(log.textContent).toContain("answer 399"));
  await waitFor(() => expect(log.scrollHeight - log.scrollTop - log.clientHeight).toBeLessThan(2));
});

test("what arrives follows the end, and does not move a reader who is above it", async () => {
  const { log, emit } = await open(...turnsOf(100));
  constrain(log);
  await waitFor(() => expect(drawn(log)).toBeLessThan(60));
  await settle();
  const fromEnd = () => log.scrollHeight - log.scrollTop - log.clientHeight;
  await waitFor(() => expect(fromEnd()).toBeLessThan(2));
  for (const update of turnsOf(3, 100)) await emit(update);
  await waitFor(() => expect(log.textContent).toContain("answer 102"));
  await waitFor(() => expect(fromEnd()).toBeLessThan(2));
  // Reading above the end: the place holds as more arrives.
  for (let step = 0; step < 10; step++) {
    log.scrollTop -= log.clientHeight;
    await settle();
  }
  expect(fromEnd()).toBeGreaterThan(1000);
  const reading = log.querySelector('[data-slot="block"]')?.textContent;
  const top = log.scrollTop;
  for (const update of turnsOf(3, 103)) await emit(update);
  await settle();
  expect(log.scrollTop).toBe(top);
  expect(log.querySelector('[data-slot="block"]')?.textContent).toBe(reading);
  expect(log.textContent).not.toContain("answer 105");
});

test("a jump into a part never drawn fills the view with blocks, not with room", async () => {
  const { log } = await open(...turnsOf(400));
  constrain(log);
  await waitFor(() => expect(drawn(log)).toBeLessThan(80));
  await settle();
  // As a drag of the scrollbar does: far from where blocks were measured.
  log.scrollTop = log.scrollHeight / 2;
  await waitFor(() => {
    const view = log.getBoundingClientRect();
    const blocks = Array.from(log.querySelectorAll('[data-slot="block"]'), (b) =>
      b.getBoundingClientRect(),
    );
    expect(blocks.length).toBeGreaterThan(2);
    expect(blocks[0]?.top ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(view.top);
    expect(blocks.at(-1)?.bottom ?? 0).toBeGreaterThanOrEqual(view.bottom);
    for (const gap of log.querySelectorAll('[data-slot="spacer"]')) {
      const box = gap.getBoundingClientRect();
      expect(box.height === 0 || box.bottom <= view.top || box.top >= view.bottom).toBe(true);
    }
  });
  expect(drawn(log)).toBeLessThan(80);
});

test("a card the reader opened is still open when they come back to it", async () => {
  const { user, log } = await open(
    you("first"),
    ...tool("a", "Bash", "completed", { command: "make kept-open" }),
    ...tool("b", "Read", "completed", { file_path: "kept.ts" }),
    say("first answer"),
    state({ state: "idle", stopReason: "end_turn" }),
    ...turnsOf(300, 1),
  );
  constrain(log);
  await waitFor(() => expect(drawn(log)).toBeLessThan(80));
  await settle();
  await waitFor(() => {
    log.scrollTop = 0;
    expect(screen.queryByRole("button", { name: /^Worked/ })).not.toBeNull();
  });
  const fold = await screen.findByRole("button", { name: /^Worked/ });
  await user.click(fold);
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  log.scrollTop = log.scrollHeight;
  // A slow machine may not have followed the end by itself: go there, as a reader pressing "back to bottom" would.
  await waitFor(
    () => {
      log.scrollTop = log.scrollHeight;
      expect(log.textContent).toContain("answer 300");
    },
    { timeout: 5000 },
  );
  await waitFor(() => expect(log.scrollHeight - log.scrollTop - log.clientHeight).toBeLessThan(2));
  expect(drawn(log)).toBeLessThan(80);
  for (let i = 0; i < 100 && log.scrollTop > 0; i++) {
    log.scrollTop = 0;
    await settle();
  }
  const back = await screen.findByRole("button", { name: /^Worked/ });
  expect(back.getAttribute("aria-expanded")).toBe("true");
});

test("a long code block shown whole at the end of a conversation leaves the view where it was", async () => {
  const { user, log } = await open(
    you("What did you change?"),
    u({
      sessionUpdate: "agent_message",
      messageId: "a1",
      content: [{ type: "text", text: READING }],
    }),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  constrain(log);
  const more = await within(log).findByRole("button", {
    name: `Show all ${LONG_CODE_LINES} lines`,
  });
  // Coloured, measured and at the end, as a reader finds it.
  await waitFor(() =>
    expect(log.querySelector('[data-streamdown="code-block-body"] span[style]')).not.toBeNull(),
  );
  await settle();
  await waitFor(() => expect(log.scrollHeight - log.scrollTop - log.clientHeight).toBeLessThan(2));
  const top = log.scrollTop;
  // The browser kept something it picked in place as the block grew, and the view went 42px down with it (CYC-535). Only
  // the gallery's `markdown-expand` shows the jump, so this asks too that, as the block opens, nothing is kept in place.
  more.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  expect(getComputedStyle(log).overflowAnchor).toBe("none");
  await user.click(more);
  for (let i = 0; i < 6; i++) await settle();
  expect(more.getAttribute("aria-expanded")).toBe("true");
  expect(Math.abs(log.scrollTop - top)).toBeLessThanOrEqual(2);
});

test("an item far above the view is brought into view and marked, in a long conversation", async () => {
  const { log } = await open(
    you("first"),
    ...tool("far", "Bash", "completed", { command: "make far-away" }),
    ...tool("far2", "Read", "completed", { file_path: "far.ts" }),
    state({ state: "idle", stopReason: "end_turn" }),
    ...turnsOf(300, 1),
  );
  constrain(log);
  await waitFor(() => expect(log.textContent).toContain("answer 300"), { timeout: 5000 });
  await waitFor(() => expect(drawn(log)).toBeLessThan(80));
  expect(log.querySelector('[data-item-id="far"]')).toBeNull();
  act(() => {
    reveal.request(SESSION, "far");
  });
  await waitFor(() =>
    expect(log.querySelector('[data-item-id="far"][data-revealed]')).not.toBeNull(),
  );
  expect(log.textContent).toContain("make far-away");
  expect(drawn(log)).toBeLessThan(80);
});

test("scrolled up, a button takes the reader back to the end, says when something new came, and moves nothing", async () => {
  const { user, log, emit, script } = await open(...turnsOf(20));
  await waitFor(() => expect(log.textContent).toContain("answer 19"));
  // The window's height, as #root has it in the app: the conversation scrolls inside it.
  const root = log.closest('[data-slot="app"]')?.parentElement;
  if (root instanceof HTMLElement) root.style.height = "100%";
  await waitFor(() => expect(log.scrollHeight).toBeGreaterThan(log.clientHeight + 500));
  // The view settles into its new height (a scroll in the same frame would count as the layout's, not the reader's).
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  log.scrollTop = log.scrollHeight;
  const fromEnd = () => log.scrollHeight - log.scrollTop - log.clientHeight;
  await waitFor(() => expect(fromEnd()).toBeLessThan(2));
  const toEnd = () => log.querySelector<HTMLButtonElement>('[data-slot="to-end-button"]');
  // At the end there is nothing to go back to; the holder takes no room.
  expect(toEnd()).toBeNull();
  const holder = log.querySelector('[data-slot="to-end"]');
  expect(holder?.getBoundingClientRect().height).toBe(0);
  log.scrollTop = 0;
  await waitFor(() => expect(toEnd()).not.toBeNull());
  expect(toEnd()?.hasAttribute("data-fresh")).toBe(false);
  // Floats inside the view, at its bottom.
  const box = toEnd()?.getBoundingClientRect();
  const view = log.getBoundingClientRect();
  expect(box && box.bottom <= view.bottom && box.bottom > view.bottom - 64).toBe(true);
  // Clear of the view's bottom fade (32px), which would fade it too.
  expect(box && view.bottom - box.bottom).toBeGreaterThanOrEqual(32);
  // A reply arrives below: the reader stays where they are, and the button says there is something new.
  const top = log.scrollTop;
  await emit(you("later"));
  await waitFor(() => expect(toEnd()?.hasAttribute("data-fresh")).toBe(true));
  expect(log.scrollTop).toBe(top);
  // By keyboard: it is a button with a name, and Enter goes back to the end.
  const button = screen.getByRole("button", {
    name: "Back to bottom, where there is something new",
  });
  button.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(fromEnd()).toBeLessThan(2));
  await waitFor(() => expect(toEnd()).toBeNull());
  // The focus stays in the conversation, not on the page.
  expect(document.activeElement).toBe(log);
  // Counted with whether something new was there, nothing else.
  expect(script.calls.filter(([name]) => name === "track")).toEqual([
    ["track", "back_to_bottom_used", { fresh: true }],
  ]);
});

/** Where the conversation's text runs, against the input box below it: left and right edges, in pixels. */
const edges = (log: HTMLElement) => {
  const block = log.querySelector('[data-slot="block"]')?.getBoundingClientRect();
  const box = document.querySelector('[data-slot="composer-box"]')?.getBoundingClientRect();
  if (block === undefined || box === undefined) throw new Error("no block or no input box");
  const view = log.getBoundingClientRect();
  return {
    block: [block.left, block.right],
    box: [box.left, box.right],
    margins: [block.left - view.left, view.right - block.right],
  };
};

test("the conversation's text lines up with the input box, short or scrolling, with equal room left and right", async () => {
  const { log, emit, ask } = await open(...turnsOf(1));
  await waitFor(() => expect(log.textContent).toContain("answer 0"));
  // The window's height, as #root has it in the app: the conversation scrolls inside it.
  const root = log.closest('[data-slot="app"]')?.parentElement;
  if (root instanceof HTMLElement) root.style.height = "100%";
  // Too short to scroll: the scrollbar's slot is kept all the same, so nothing moves once it does scroll.
  await waitFor(() => expect(log.scrollHeight).toBeLessThanOrEqual(log.clientHeight));
  expect(log.offsetWidth - log.clientWidth).toBe(10);
  const short = edges(log);
  expect(short.block[0]).toBeCloseTo(short.box[0] ?? 0, 0);
  expect(short.block[1]).toBeCloseTo(short.box[1] ?? 0, 0);
  expect(short.margins[0]).toBeCloseTo(short.margins[1] ?? 0, 0);
  for (const update of turnsOf(20, 1)) await emit(update);
  await waitFor(() => expect(log.scrollHeight).toBeGreaterThan(log.clientHeight + 200));
  expect(edges(log)).toEqual(short);
  // In a narrow window, where the column's pad is its least, the same holds.
  if (root instanceof HTMLElement) root.style.width = "640px";
  await waitFor(() => expect(log.getBoundingClientRect().width).toBeLessThan(600));
  const narrow = edges(log);
  expect(narrow.block[0]).toBeCloseTo(narrow.box[0] ?? 0, 0);
  expect(narrow.block[1]).toBeCloseTo(narrow.box[1] ?? 0, 0);
  expect(narrow.margins[0]).toBeCloseTo(narrow.margins[1] ?? 0, 0);
  if (root instanceof HTMLElement) root.style.width = "";
  await waitFor(() => expect(edges(log)).toEqual(short));
  // A permission card above the box has the same edges.
  await ask({
    key: "local:s1:p1",
    locationId: "local",
    sessionId: "s1",
    title: "Allow Read?",
    subject: { type: "tool_call", toolCall: { name: "Read", rawInput: { file_path: "a" } } },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
  });
  const card = (await screen.findByLabelText("Allow Read?")).getBoundingClientRect();
  expect(card.left).toBeCloseTo(short.box[0] ?? 0, 0);
  expect(card.right).toBeCloseTo(short.box[1] ?? 0, 0);
});

test("the conversation fades at its top and bottom edges, and at the end the last message is 64px above the input box", async () => {
  const { log } = await open(...turnsOf(20));
  await waitFor(() => expect(log.textContent).toContain("answer 19"));
  const root = log.closest('[data-slot="app"]')?.parentElement;
  if (root instanceof HTMLElement) root.style.height = "100%";
  await waitFor(() => expect(log.scrollHeight).toBeGreaterThan(log.clientHeight + 200));
  // A mask of the view, with no colour in it: 16px at the top, 32px at the bottom.
  const { maskImage } = getComputedStyle(log);
  expect(maskImage).toBe(
    "linear-gradient(rgba(0, 0, 0, 0), rgb(0, 0, 0) 16px, rgb(0, 0, 0) calc(100% - 32px), rgba(0, 0, 0, 0))",
  );
  log.scrollTop = log.scrollHeight;
  await waitFor(() => expect(log.scrollHeight - log.scrollTop - log.clientHeight).toBeLessThan(2));
  // At the end, the last message ends 64px above the view's bottom (the input box is right below it): past the fade.
  const blocks = log.querySelectorAll('[data-slot="block"]');
  const last = blocks[blocks.length - 1]?.getBoundingClientRect();
  const view = log.getBoundingClientRect();
  const composer = document.querySelector('[data-slot="composer"]')?.getBoundingClientRect();
  expect(composer?.top).toBeCloseTo(view.bottom, 0);
  expect((last?.bottom ?? 0) + 64).toBeCloseTo(view.bottom, 0);
  // At the top, the first message starts below the top fade.
  // Reaching the top draws the blocks above and keeps the reader's place: scroll up until the first is drawn, then measure.
  await waitFor(() => {
    log.scrollTop = 0;
    expect(log.textContent).toContain("question 0");
    expect(log.scrollTop).toBe(0);
  });
  const first = log.querySelector('[data-slot="block"]')?.getBoundingClientRect();
  expect((first?.top ?? 0) - log.getBoundingClientRect().top).toBeGreaterThanOrEqual(16);
});

test("an empty session's message stays in the middle of the view, whatever room is kept under a last message", async () => {
  const { log } = await open();
  const root = log.closest('[data-slot="app"]')?.parentElement;
  if (root instanceof HTMLElement) root.style.height = "100%";
  const empty = await screen.findByText("Nothing here yet. Say something below.");
  const box = empty.getBoundingClientRect();
  const view = log.getBoundingClientRect();
  expect(box.top - view.top).toBeCloseTo(view.bottom - box.bottom, 0);
  expect(box.top - view.top).toBeGreaterThan(32);
});

test("a conversation that grows from a few blocks to many draws the ones near its end, not all of it", async () => {
  const { log, emit } = await open(...turnsOf(1));
  expect(drawn(log)).toBe(2);
  constrain(log);
  const updates = turnsOf(300, 1);
  // Emit in bursts so the view grows incrementally across the virtualization threshold without 600 serial flushes.
  for (let i = 0; i < updates.length; i += 20) await emit(...updates.slice(i, i + 20));
  await waitFor(() => expect(log.textContent).toContain("answer 300"));
  await waitFor(() => expect(drawn(log)).toBeLessThan(80));
  expect(log.textContent).not.toContain("question 20");
});

test("a tool call left going in a turn that has ended is not shown running; in a card it is not done", async () => {
  const { log, emit } = await open(
    you("u1"),
    state({ state: "running" }),
    ...tool("a", "Bash", "in_progress", { command: "sed -n 1,60p icons.tsx" }),
  );
  const row = await screen.findByRole("button", { name: /Bash/ });
  expect(row.textContent).toContain("in progress");
  // The row says it is at work: the line at the end is quiet.
  expect(log.querySelector('[data-slot="step"]')?.hasAttribute("data-quiet")).toBe(true);
  // An older session: the turn ended and the call never said it had.
  await emit(state({ state: "idle", stopReason: "end_turn" }));
  await waitFor(() => expect(row.textContent).toContain("cancelled"));
  expect(log.querySelector('[data-slot="step"]')).toBeNull();
});

test("a call the person opened stays open when a second call makes it a card", async () => {
  const { user, log, emit } = await open(
    you("u1"),
    state({ state: "running" }),
    ...tool("a", "Bash", "completed", { command: "make lint" }),
  );
  await user.click(await screen.findByRole("button", { name: /make lint/ }));
  expect(log.querySelector('[data-item-id="a"] > button')?.getAttribute("aria-expanded")).toBe(
    "true",
  );
  await emit(...tool("b", "Bash", "completed", { command: "make test" }));
  await waitFor(() => expect(log.querySelector('[data-kind="work"]')).not.toBeNull());
  expect(log.querySelector('[data-kind="work"] > button')?.getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(log.querySelector('[data-item-id="a"] > button')?.getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(log.querySelector('[data-item-id="b"] > button')?.getAttribute("aria-expanded")).toBe(
    "false",
  );
});

test("a call never opened is closed, and so is its card, when a second call joins it", async () => {
  const { log, emit } = await open(
    you("u1"),
    state({ state: "running" }),
    ...tool("a", "Bash", "failed", { command: "make lint" }),
  );
  await emit(...tool("b", "Bash", "completed", { command: "make test" }));
  await waitFor(() => expect(log.querySelector('[data-kind="work"]')).not.toBeNull());
  expect(log.querySelector('[data-kind="work"] > button')?.getAttribute("aria-expanded")).toBe(
    "false",
  );
});

test("a card with a call the turn left is not finished, not done", async () => {
  await open(
    you("u1"),
    state({ state: "running" }),
    ...tool("a", "Bash", "completed", { command: "make lint" }),
    ...tool("b", "Bash", "in_progress", { command: "make" }),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  const card = await screen.findByRole("button", { name: /Ran 2 commands/ });
  expect(card.textContent).toContain("not finished");
  expect(card.closest('[data-kind="work"]')?.getAttribute("data-status")).toBe("pending");
});

const finished = (id: string, name: string, rawInput: object, result: object) => [
  ...tool(id, name, "in_progress", rawInput),
  u({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", ...result }),
];

test("an edit's line counts its own lines and opens to them, not to the strings it was given", async () => {
  const { user, log } = await open(
    you("u1"),
    ...finished(
      "e",
      "Edit",
      { file_path: "src/a.ts", old_string: "OLD-INPUT", new_string: "NEW-INPUT" },
      {
        content: [
          {
            type: "diff",
            changes: [{ operation: "modify", path: "/r/src/a.ts" }],
            patch: {
              format: "git_patch",
              text: "--- a\n+++ b\n@@ -7,2 +7,3 @@\n keep\n-gone\n+here\n+also\n",
            },
          },
        ],
        _meta: { "cycle/toolResult": { edit: { additions: 2, deletions: 1 } } },
      },
    ),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  const row = await screen.findByRole("button", { name: /Edited/ });
  expect(row.textContent).toContain("+2");
  expect(row.textContent).toContain("−1");
  // In words for a screen reader, not only in colour and signs.
  expect(row.textContent).toContain("2 lines added, 1 removed");
  await user.click(row);
  const diff = log.querySelector('[data-slot="tool-diff"]');
  expect(
    [...(diff?.querySelectorAll("[data-line]") ?? [])].map((l) => l.getAttribute("data-line")),
  ).toEqual(["context", "del", "add", "add"]);
  expect(diff?.textContent).toContain("here");
  expect(log.textContent).not.toContain("OLD-INPUT");
});

test("a big diff draws one page of lines, and each click draws the next until all of it is shown", async () => {
  const body = Array.from({ length: 1000 }, (_, n) => `+row ${n + 1}`).join("\n");
  const { user, log } = await open(
    you("u1"),
    ...finished(
      "e",
      "Edit",
      { file_path: "src/big.ts", old_string: "a", new_string: "b" },
      {
        content: [
          {
            type: "diff",
            changes: [{ operation: "modify", path: "/r/src/big.ts" }],
            patch: { format: "git_patch", text: `--- a\n+++ b\n@@ -1,0 +1,1000 @@\n${body}\n` },
          },
        ],
        _meta: { "cycle/toolResult": { edit: { additions: 1000, deletions: 0 } } },
      },
    ),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  await user.click(await screen.findByRole("button", { name: /Edited/ }));
  const lines = () => log.querySelectorAll('[data-slot="tool-diff"] [data-line]').length;
  expect(lines()).toBe(400);
  await user.click(screen.getByRole("button", { name: "Show 600 more lines" }));
  expect(lines()).toBe(800);
  await user.click(screen.getByRole("button", { name: "Show 200 more lines" }));
  expect(lines()).toBe(1000);
  expect(screen.queryByRole("button", { name: /more lines/ })).toBeNull();
});

test("an output over the limit draws a page of its end, and each click draws more until all of it is shown", async () => {
  const long = Array.from({ length: 1000 }, (_, n) => `line ${n + 1}`).join("\n");
  const { user, log } = await open(
    you("u1"),
    ...finished(
      "b",
      "Bash",
      { command: "make all", description: "Build it" },
      {
        content: [{ type: "content", content: { type: "text", text: long } }],
      },
    ),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  await user.click(await screen.findByRole("button", { name: /Build it/ }));
  const out = () => log.querySelector('[data-kind="output"] [data-slot="tool-output"]');
  expect(out()?.textContent?.split("\n").length).toBe(40);
  await user.click(screen.getByRole("button", { name: "Show 200 earlier lines" }));
  expect(out()?.textContent?.split("\n").length).toBe(240);
  expect(out()?.textContent?.endsWith("line 1000")).toBe(true);
  for (let i = 0; i < 4; i++)
    await user.click(screen.getByRole("button", { name: /Show \d+ earlier lines/ }));
  expect(out()?.textContent).toBe(long);
  expect(screen.queryByRole("button", { name: /earlier line/ })).toBeNull();
});

test("a single huge line is shown up to the limit, and more of it on request", async () => {
  const huge = "x".repeat(50_000);
  const { user, log } = await open(
    you("u1"),
    ...finished(
      "b",
      "Bash",
      { command: "cat big", description: "Cat it" },
      {
        content: [{ type: "content", content: { type: "text", text: huge } }],
      },
    ),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  await user.click(await screen.findByRole("button", { name: /Cat it/ }));
  const out = () => log.querySelector('[data-kind="output"] [data-slot="tool-output"]');
  expect(out()?.textContent?.length).toBeLessThan(20_100);
  await user.click(screen.getByRole("button", { name: /Show more/ }));
  expect(out()?.textContent?.length).toBeLessThan(40_100);
  await user.click(screen.getByRole("button", { name: /Show more/ }));
  expect(out()?.textContent).toBe(huge);
  expect(screen.queryByRole("button", { name: /Show more/ })).toBeNull();
});

test("a new file is Created; a read says its lines; a search what it found; a picture read is shown", async () => {
  const { user, log } = await open(
    you("u1"),
    ...finished(
      "w",
      "Write",
      { file_path: "README.md", content: "…" },
      {
        content: [
          { type: "diff", changes: [{ operation: "add", path: "/r/README.md" }], patch: null },
        ],
        _meta: { "cycle/toolResult": { edit: { additions: 3, deletions: 0, created: true } } },
      },
    ),
    u({
      sessionUpdate: "agent_message",
      messageId: "m1",
      content: [{ type: "text", text: "next" }],
    }),
    ...finished(
      "z",
      "Write",
      { file_path: "__init__.py", content: "" },
      {
        content: [
          { type: "diff", changes: [{ operation: "add", path: "/r/__init__.py" }], patch: null },
        ],
        _meta: {
          "cycle/toolResult": { edit: { additions: 0, deletions: 0, created: true, staged: true } },
        },
      },
    ),
    u({
      sessionUpdate: "agent_message",
      messageId: "m1b",
      content: [{ type: "text", text: "next" }],
    }),
    ...finished(
      "r",
      "Read",
      { file_path: "a.ts" },
      { _meta: { "cycle/toolResult": { read: { startLine: 20, numLines: 40, totalLines: 212 } } } },
    ),
    u({
      sessionUpdate: "agent_message",
      messageId: "m2",
      content: [{ type: "text", text: "next" }],
    }),
    ...finished(
      "g",
      "Grep",
      { pattern: "PORT" },
      { _meta: { "cycle/toolResult": { search: { files: 2, matches: 5 } } } },
    ),
    u({
      sessionUpdate: "agent_message",
      messageId: "m3",
      content: [{ type: "text", text: "next" }],
    }),
    ...finished(
      "p",
      "Read",
      { file_path: "a.png" },
      {
        content: [
          {
            type: "content",
            content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          },
        ],
      },
    ),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  await openWork(user);
  const created = await screen.findByRole("button", { name: /Created README/ });
  await user.click(created);
  expect(log.textContent).toContain("The change is too large to show here.");
  expect(log.textContent).toContain("lines 20–59 of 212");
  // An empty new file held for review says both.
  expect(log.textContent).toContain("empty file held for review");
  expect(log.textContent).toContain("5 matches in 2 files");
  await user.click(screen.getByRole("button", { name: /a\.png/ }));
  await waitFor(() => expect(log.querySelector('[data-kind="tool"] img')).toBeTruthy());
  // Neither input is shown again: the new file's is the file, the read's says only the path the line shows.
  expect(log.querySelector('[data-slot="tool-input"]')).toBeNull();
});

test("a deletion-only edit shows only removed lines, not +0", async () => {
  await open(
    you("u1"),
    ...finished(
      "d",
      "Edit",
      { file_path: "src/old.ts", old_string: "a\nb\n", new_string: "" },
      {
        content: [
          {
            type: "diff",
            changes: [{ operation: "modify", path: "/r/src/old.ts" }],
            patch: { format: "git_patch", text: "--- a\n+++ b\n@@ -1,2 +1,0 @@\n-a\n-b\n" },
          },
        ],
        _meta: { "cycle/toolResult": { edit: { additions: 0, deletions: 2 } } },
      },
    ),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  const row = await screen.findByRole("button", { name: /Edited/ });
  expect(row.textContent).toContain("−2");
  expect(row.textContent).not.toContain("+0");
});

test("a command opens to itself and its output apart from its errors; a long output shows its end; both copy whole", async () => {
  const long = Array.from({ length: 100 }, (_, n) => `line ${n + 1}`).join("\n");
  const { user, log, script } = await open(
    you("u1"),
    ...finished(
      "b",
      "Bash",
      { command: "make all", description: "Build everything", timeout: 600000 },
      {
        content: [
          { type: "content", content: { type: "text", text: long } },
          {
            type: "content",
            content: { type: "text", text: "warning: deprecated" },
            _meta: { "cycle/stream": "stderr" },
          },
        ],
        _meta: { "cycle/toolResult": { run: { timedOutMs: 120000, background: true } } },
      },
    ),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  const row = await screen.findByRole("button", { name: /Build everything/ });
  expect(row.textContent).toContain("ran past 2 min, now in the background");
  await user.click(row);
  // The command as a command, not a field of JSON: everything its input says is said.
  expect(log.querySelector('[data-slot="tool-input"]')).toBeNull();
  expect(log.querySelector('[data-slot="tool-command"]')?.textContent).toBe("make all");
  const output = log.querySelector('[data-kind="output"] [data-slot="tool-output"]');
  expect(output?.textContent?.startsWith("line 61")).toBe(true);
  expect(output?.textContent?.endsWith("line 100")).toBe(true);
  expect(log.querySelector('[data-kind="stderr"]')?.textContent).toContain("warning: deprecated");
  await user.click(screen.getByRole("button", { name: "Show 60 earlier lines" }));
  expect(log.querySelector('[data-kind="output"] [data-slot="tool-output"]')?.textContent).toBe(
    long,
  );
  await user.click(screen.getByRole("button", { name: "Copy the output" }));
  expect(script.calls.filter(([name]) => name === "copyText")).toEqual([["copyText", long]]);
  // Reported as what was copied, never the text.
  expect(script.calls.filter(([name]) => name === "track")).toEqual([
    ["track", "tool_output_expanded", {}],
    ["track", "tool_copied", { part: "output" }],
  ]);
});

test("a shell command is coloured as bash in the code theme's colours, and is the same words and copy as plain text", async () => {
  const command = 'git show :2:a.md | grep "x" > /tmp/o.txt; n=$(wc -l < a.md) && echo "$n"';
  const { user, log, script } = await open(
    you("u1"),
    ...finished("hl", "Bash", { command, description: "Highlight me" }, { content: [] }),
  );
  await user.click(await screen.findByRole("button", { name: /Highlight me/ }));
  const pre = () => log.querySelector('[data-slot="tool-command"]');
  // Before the highlighter is ready, and after it: the words are the command's.
  await waitFor(() => expect(pre()).not.toBeNull());
  expect(pre()?.textContent).toBe(command);
  await waitFor(() => expect(pre()?.querySelectorAll("[data-token]").length).toBeGreaterThan(3));
  expect(pre()?.textContent).toBe(command);
  const tokens = [...(pre()?.querySelectorAll<HTMLElement>("[data-token]") ?? [])];
  // Command name, string, operator and variable are not one colour.
  expect(tokens.find((token) => token.textContent === "git")).toBeTruthy();
  const colours = new Set(tokens.map((token) => token.style.getPropertyValue("--tok-l")));
  expect(colours.has("")).toBe(false);
  expect(colours.size).toBeGreaterThan(2);
  // A dark colour is given beside each light one.
  expect(tokens.every((token) => token.style.getPropertyValue("--tok-d") !== "")).toBe(true);
  await user.click(screen.getByRole("button", { name: "Copy the command" }));
  expect(script.calls.filter(([name]) => name === "copyText")).toEqual([["copyText", command]]);
});

test("a call at work shows on its row how long it has been going, from when the page first saw it", async () => {
  // Seen three seconds ago: a row drawn again goes on from there, not from nought.
  startedAt("local:s1:tool:slow", Date.now() - 3_000);
  await open(
    you("u1"),
    ...tool("slow", "Bash", "in_progress", { command: "make", description: "Build it" }),
  );
  const row = await screen.findByRole("button", { name: /Build it/ });
  // The agent's sentence has no tense: that it is at work is written out.
  expect(row.querySelector('[data-slot="tool-status"]')?.textContent).toBe("in progress");
  await waitFor(() =>
    expect(row.querySelector('[data-slot="tool-elapsed"]')?.textContent).toMatch(/^[34]s$/),
  );
});

/** The loaders that can be seen in `root`: one kept out of the layout while the line is quiet is not. */
const shownLoaders = (root: Element): number =>
  [...root.querySelectorAll('[data-slot="morph-loader"]')].filter((loader) =>
    loader.checkVisibility(),
  ).length;

/** Seconds, from what a count says ("7s", "1m 5s"). */
const seconds = (text: string | null | undefined): number => {
  const match = /^(?:(\d+)m)?\s*(?:(\d+)s)?$/.exec(text ?? "");
  return match === null ? Number.NaN : Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0);
};

test("the line at the end counts the whole turn: a call and an approval do not start it again", async () => {
  // The turn was first seen five seconds ago (or earlier, by another test of this session's first turn).
  startedAt("local:s1:turn:0", Date.now() - 5_000);
  const { log, emit } = await open(you("u1"), state({ state: "running" }), think("t1", "hm"));
  const step = () => log.querySelector<HTMLElement>('[data-slot="step"]');
  const elapsed = () => seconds(step()?.querySelector('[data-slot="step-elapsed"]')?.textContent);
  await waitFor(() => expect(elapsed()).toBeGreaterThanOrEqual(5));
  const before = elapsed();
  expect(step()?.getBoundingClientRect().height).toBe(28);
  expect(shownLoaders(log)).toBe(1);

  // A call at work: its row says so; the line keeps its height and shows neither a loader nor a time.
  for (const update of tool("a", "Bash", "in_progress", { command: "make" })) await emit(update);
  await waitFor(() => expect(step()?.hasAttribute("data-quiet")).toBe(true));
  expect(step()?.getBoundingClientRect().height).toBe(28);
  expect(shownLoaders(log)).toBe(0);
  expect(log.querySelector('[data-slot="step-elapsed"]')).toBeNull();
  // Out of sight, it asks for no frames.
  await waitFor(() =>
    expect(log.querySelector<SVGElement>('[data-slot="morph-loader"] svg')?.dataset.animating).toBe(
      "false",
    ),
  );

  // The agent asks: the line waits, without a time.
  await emit(state({ state: "requires_action" }));
  await waitFor(() => expect(step()?.getAttribute("data-step")).toBe("approval"));
  expect(step()?.getBoundingClientRect().height).toBe(28);
  expect(log.querySelector('[data-slot="step-elapsed"]')).toBeNull();

  // Answered, the call done: the count goes on from the turn's start, not from nought.
  await emit(state({ state: "running" }));
  await emit(u({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" }));
  await waitFor(() => expect(step()?.getAttribute("data-step")).toBe("working"));
  await waitFor(() => expect(elapsed()).toBeGreaterThanOrEqual(before));
});

test("a call that has not started its work (its input still coming) is spoken for by the line", async () => {
  const { log } = await open(
    you("u1"),
    state({ state: "running" }),
    u({ sessionUpdate: "tool_call_update", toolCallId: "w", name: "Write", status: "pending" }),
  );
  const step = log.querySelector<HTMLElement>('[data-slot="step"]');
  // Its row has no time yet: the line keeps the loader and the turn's time.
  expect(step?.hasAttribute("data-quiet")).toBe(false);
  expect(shownLoaders(log)).toBe(1);
});

test("a long label stays on its one line, inside the column", async () => {
  const { log } = await open(
    you("u1"),
    state({ state: "running" }),
    u({
      sessionUpdate: "notice",
      severity: "info",
      title: "Retrying",
      _meta: { "cycle/retry": { attempt: 2, maxRetries: 10, delayMs: 500 } },
    }),
  );
  const step = await waitFor(() => {
    const found = log.querySelector<HTMLElement>('[data-slot="step"]');
    expect(found?.textContent).toContain("trying again");
    return found as HTMLElement;
  });
  step.style.width = "120px";
  expect(step.getBoundingClientRect().height).toBe(28);
  expect(step.scrollWidth).toBeLessThanOrEqual(step.clientWidth);
});

test("a run of quick calls keeps the line quiet: no loader flickers in between", async () => {
  const { log, emit } = await open(
    you("u1"),
    state({ state: "running" }),
    ...tool("a", "Bash", "in_progress", { command: "make" }),
  );
  const step = log.querySelector<HTMLElement>('[data-slot="step"]');
  expect(step?.hasAttribute("data-quiet")).toBe(true);
  const height = step?.getBoundingClientRect().height;
  let spoke = false;
  const watch = new MutationObserver(() => {
    if (shownLoaders(log) > 0) spoke = true;
  });
  watch.observe(log, { subtree: true, childList: true, attributes: true });
  let last = "a";
  for (const id of ["b", "c", "d", "e"]) {
    // Between one call's end and the next one's start, the agent is at work for a moment.
    await emit(u({ sessionUpdate: "tool_call_update", toolCallId: last, status: "completed" }));
    for (const update of tool(id, "Read", "in_progress", { file_path: `${id}.ts` })) {
      await emit(update);
    }
    last = id;
  }
  // Longer than a step is held: a change waiting would have shown by now.
  await new Promise((resolve) => setTimeout(resolve, 900));
  watch.disconnect();
  expect(spoke).toBe(false);
  expect(log.querySelector('[data-slot="step"]')?.getBoundingClientRect().height).toBe(height);
});

test("while the agent writes its reply the line stays, saying so: nothing below the reply jumps", async () => {
  const { log, script } = await open(you("u1"), state({ state: "running" }));
  const emit = timed(script, 2);
  await emit(answerChunk("the start of it"));
  await waitFor(() => expect(log.textContent).toContain("the start of it"));
  await waitFor(() =>
    expect(log.querySelector('[data-slot="step"]')?.getAttribute("data-step")).toBe("replying"),
  );
  expect(log.querySelector('[data-slot="morph-loader"]')?.getAttribute("data-state")).toBe(
    "responding",
  );
  await emit(state({ state: "idle", stopReason: "end_turn" }));
  await waitFor(() => expect(log.querySelector('[data-slot="step"]')).toBeNull());
});

test("a card of calls, closed, says on its line how long the call that is going has been at work", async () => {
  startedAt("local:s1:tool:card-b", Date.now() - 3_000);
  const { log } = await open(
    you("u1"),
    state({ state: "running" }),
    ...tool("card-a", "Bash", "completed", { command: "make" }),
    ...tool("card-b", "Bash", "in_progress", { command: "make check" }),
  );
  const card = await waitFor(() => {
    const found = log.querySelector('[data-kind="work"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  await waitFor(() =>
    expect(
      seconds(card.querySelector('[data-slot="tool-elapsed"]')?.textContent),
    ).toBeGreaterThanOrEqual(3),
  );
  // One clock for the call: the line at the end shows none.
  expect(log.querySelector('[data-slot="step-elapsed"]')).toBeNull();
});

test("a tool row is text only: no icon, dot, spinner, cross or chevron, whatever its state", async () => {
  const { user, log } = await open(
    you("u1"),
    say("m1"),
    ...finished("r", "Read", { file_path: "a.ts" }, {}),
    say("m2"),
    ...tool("x", "Bash", "failed", { command: "make" }),
    say("m3"),
    ...finished("s1", "Grep", { pattern: "a" }, {}),
    ...finished("s2", "Glob", { pattern: "*.ts" }, {}),
    say("m4"),
    ...tool("g", "Bash", "in_progress", { command: "make test" }),
    say("m5"),
    ...tool("p", "Bash", "pending", { command: "rm -rf build" }),
  );
  await waitFor(() => expect(log.querySelectorAll('[data-kind="tool"]').length).toBeGreaterThan(3));
  const rows = log.querySelectorAll(':is([data-kind="tool"], [data-kind="work"]) > button');
  for (const row of rows) {
    expect(row.querySelector("svg, [data-slot='spinner'], [data-slot='tool-lead']")).toBeNull();
    // Nor the chevron ui-sdk draws after a trigger without an icon.
    expect(getComputedStyle(row, "::after").content).toBe("none");
  }
  // Opened, what it holds is text too: the end of a command is a word, not a tick or a cross.
  await user.click(log.querySelector('[data-item-id="x"] > button') as HTMLElement);
  await waitFor(() =>
    expect(log.querySelector('[data-item-id="x"] [data-slot="tool-end"]')).not.toBeNull(),
  );
  expect(log.querySelector('[data-item-id="x"] [data-slot="collapsible-panel"] svg')).toBeNull();
  // Failed is said in words, in red; going, in the verb's tense.
  const failed = log.querySelector('[data-item-id="x"] > button') as HTMLElement;
  expect(failed.querySelector('[data-slot="tool-status"]')?.textContent).toBe("failed");
  expect(log.querySelector('[data-item-id="g"] [data-slot="tool-verb"]')?.textContent).toMatch(
    /^Running/,
  );
  // Waiting, there is no tense to say it: the word is written out.
  expect(
    log.querySelector('[data-item-id="p"] > button [data-slot="tool-status"]')?.textContent,
  ).toBe("pending");
  // In the secondary ink, not the body's.
  const verb = log.querySelector('[data-item-id="r"] [data-slot="tool-verb"]') as HTMLElement;
  const body = log.querySelector('[data-slot="message"]') as HTMLElement;
  expect(getComputedStyle(verb).color).not.toBe(getComputedStyle(body).color);
});

test("a command that only searches, reads or lists says so; with the agent's sentence, that sentence is the line", async () => {
  const { log } = await open(
    you("u1"),
    say("m1"),
    ...finished("q", "Bash", { command: "rg useSteady src | head -5" }, {}),
    say("m2"),
    ...finished("d", "Bash", { command: "cat a.ts", description: "Look at the config" }, {}),
    say("m3"),
    ...finished("c1", "Bash", { command: "cat a.ts" }, {}),
    ...finished("c2", "Bash", { command: "head -n 5 b.ts" }, {}),
  );
  const row = await screen.findByRole("button", { name: /Searched/ });
  expect(row.querySelector('[data-slot="tool-summary"]')?.textContent).toBe("'useSteady' in src");
  const described = screen.getByRole("button", { name: /Look at the config/ });
  expect(described.querySelector('[data-slot="tool-summary"]')?.textContent).toBe("");
  // A stretch of them is counted for what they did.
  expect(log.textContent).toContain("Read 2 files");
});

test("an edit's diff is headed by its file, which opens it in the Diff tab among the session's edits", async () => {
  const edit = (id: string, path: string) =>
    finished(
      id,
      "Edit",
      { file_path: path, old_string: "a", new_string: "b" },
      {
        content: [
          {
            type: "diff",
            changes: [{ operation: "modify", path }],
            patch: { format: "git_patch", text: "--- a\n+++ b\n@@ -1,1 +1,1 @@\n-a\n+b\n" },
          },
        ],
        _meta: { "cycle/toolResult": { edit: { additions: 1, deletions: 1 } } },
      },
    );
  const { user, log, script } = await open(
    you("u1"),
    ...edit("e1", "/r/src/one.ts"),
    say("m1"),
    ...edit("e2", "/r/src/two.ts"),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  await openWork(user);
  const rows = await screen.findAllByRole("button", { name: /Edited/ });
  await user.click(rows[1] as HTMLElement);
  const head = log.querySelector('[data-item-id="e2"] [data-slot="tool-diff-head"]') as HTMLElement;
  expect(head.textContent).toContain("/r/src/two.ts");
  expect(head.textContent).toContain("+1");
  // Its name says what it does, not only its tooltip.
  expect(head.textContent).toContain("Show in Diff");
  await user.click(head);
  // The panel is on Diff, this session's view, with that edit open and the other closed.
  const panel = await screen.findByRole("tabpanel");
  await waitFor(() => {
    const open = [...panel.querySelectorAll('[data-kind="diff-file"][data-open]')];
    expect(open.map((row) => row.textContent)).toEqual([expect.stringContaining("two.ts")]);
  });
  expect(
    script.calls.filter(
      ([name, event]) => name === "track" && event === "diff_shown_from_conversation",
    ),
  ).toHaveLength(1);
});

test("a command's output is drawn in its colours and copied without them; its head says how it ended", async () => {
  const printed = "\x1b[32m✓ 12 passed\x1b[0m\n\x1b[1;31m✗ 1 failed\x1b[0m\x1b[2K";
  const { user, log, script } = await open(
    you("u1"),
    ...finished(
      "t",
      "Bash",
      { command: "bun test", description: "Run the tests" },
      {
        content: [{ type: "content", content: { type: "text", text: printed } }],
        _meta: { "cycle/toolResult": { run: {} } },
      },
    ),
    ...tool("f", "Bash", "in_progress", { command: "make", description: "Build it" }),
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "f",
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: "Exit code 2\nno rule" } }],
      _meta: { "cycle/toolResult": { run: { exitCode: 2 } } },
    }),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  // The two are a card, closed though one failed; its rows open one by one.
  await user.click(await screen.findByRole("button", { name: /Ran 2 commands/ }));
  await user.click(await screen.findByRole("button", { name: /Run the tests/ }));
  const output = log.querySelector('[data-kind="output"] [data-slot="tool-output"]') as HTMLElement;
  expect(output.textContent).toBe("✓ 12 passed\n✗ 1 failed");
  const green = [...output.querySelectorAll("span[style]")].find(
    (s) => s.textContent === "✓ 12 passed",
  );
  // The terminal's green, made readable on the output's ground in either theme.
  expect((green as HTMLElement).style.color).toContain("light-dark(");
  const red = [...output.querySelectorAll("span[style]")].find(
    (s) => s.textContent === "✗ 1 failed",
  );
  expect((red as HTMLElement).style.fontWeight).toBe("600");
  const ok = log.querySelector('[data-item-id="t"] [data-slot="tool-end"]');
  expect(ok?.getAttribute("data-tone")).toBe("ok");
  expect(ok?.textContent).toBe("Succeeded");
  await user.click(
    within(log.querySelector('[data-item-id="t"]') as HTMLElement).getByRole("button", {
      name: "Copy the output",
    }),
  );
  expect(script.calls.filter(([name]) => name === "copyText")).toEqual([
    ["copyText", "✓ 12 passed\n✗ 1 failed"],
  ]);
  // A failed command, opened, says its code.
  await user.click(await screen.findByRole("button", { name: /Build it/ }));
  const failed = log.querySelector('[data-item-id="f"] [data-slot="tool-end"]');
  expect(failed?.getAttribute("data-tone")).toBe("danger");
  expect(failed?.textContent).toBe("exited with code 2");
});

test("a message and a finished turn's reply copy from under them, by keyboard too, and only which kind is counted", async () => {
  const said = (id: string, text: string) =>
    u({ sessionUpdate: "agent_message", messageId: id, content: [{ type: "text", text }] });
  const { user, log, emit, script } = await open(
    u({
      sessionUpdate: "user_message",
      messageId: "u1",
      content: [{ type: "text", text: "Fix the **build**" }],
    }),
    said("m1", "Looking at `make`."),
    ...tool("b", "Bash", "completed", { command: "make" }),
    said("m2", "Fixed:\n\n```sh\nmake all\n```"),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  // One Copy for the reply, under its last message: the turn's words as markdown, not one message's.
  const reply = within(log).getByRole("button", { name: "Copy the reply" });
  expect(within(log).getAllByRole("button", { name: "Copy the reply" })).toHaveLength(1);
  await user.click(reply);
  const copied = () => script.calls.filter(([name]) => name === "copyText").map(([, text]) => text);
  expect(copied()).toEqual(["Looking at `make`.\n\nFixed:\n\n```sh\nmake all\n```"]);
  await waitFor(() => expect(log.textContent).toContain("Copied"));
  // By keyboard: the focus reaches the message's Copy, and Enter copies what was written, as written.
  within(log).getByRole("button", { name: "Copy the message" }).focus();
  await user.keyboard("{Enter}");
  expect(copied()).toEqual([
    "Looking at `make`.\n\nFixed:\n\n```sh\nmake all\n```",
    "Fix the **build**",
  ]);
  expect(script.calls.filter(([name]) => name === "track")).toEqual([
    ["track", "message_copied", { kind: "agent" }],
    ["track", "message_copied", { kind: "user" }],
  ]);
  // A reply still being written has no Copy yet; the one before it keeps its own.
  await emit(you("u2"));
  await emit(state({ state: "running" }));
  await emit(said("m3", "Working on it"));
  await waitFor(() => expect(log.textContent).toContain("Working on it"));
  const replies = () => log.querySelectorAll('[data-slot="message-actions"][data-role="agent"]');
  expect(replies()).toHaveLength(1);
  await emit(state({ state: "idle", stopReason: "end_turn" }));
  await waitFor(() => expect(replies()).toHaveLength(2));
});

test("the plan is followed above the input box and is one line in the conversation; a sub-agent, a compaction, a plan proposed and a question say what they are", async () => {
  const plan = (statuses: string[]) =>
    u({
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "tasks",
        entries: statuses.map((status, n) => ({
          content: `Step ${n + 1}`,
          priority: "medium",
          status,
        })),
      },
    });
  const { user, log, script, emit } = await open(
    you("u1"),
    plan(["completed", "in_progress", "pending"]),
    ...tool("a", "Agent", "in_progress", { description: "Survey the tests", prompt: "…" }),
    u({
      sessionUpdate: "subagent_update",
      sessionId: "task-1",
      state: { state: "running" },
      _meta: { "cycle/subagent": { toolCallId: "a", background: true, lastTool: "Grep" } },
    }),
    u({ sessionUpdate: "compaction_update", compactionId: "k", status: "completed" }),
    ...finished("p", "ExitPlanMode", { plan: "## The plan\n\n1. Do it" }, {}),
    u({
      sessionUpdate: "agent_message",
      messageId: "m1",
      content: [{ type: "text", text: "next" }],
    }),
    ...finished(
      "q",
      "AskUserQuestion",
      { questions: [{ question: "Which library?", options: [] }] },
      {},
    ),
    state({ state: "running" }),
  );
  // Above the input box: how far along, and what is being done now.
  const strip = await waitFor(() => {
    const found = document.querySelector('[data-kind="plan-strip"]');
    if (found === null) throw new Error("no strip");
    return found;
  });
  expect(strip.textContent).toContain("1/3");
  expect(strip.textContent).toContain("Step 2");
  await user.click(within(strip as HTMLElement).getByRole("button"));
  expect(script.calls.filter(([name]) => name === "track")).toEqual([["track", "plan_opened", {}]]);
  // In the conversation: one line.
  expect(log.querySelector('[data-kind="plan"]')?.textContent).toContain("1 of 3 done");
  const agent = screen.getByRole("button", { name: /Survey the tests/ });
  expect(agent.textContent).toContain("Background");
  expect(agent.closest('[data-kind="subagent"]')?.textContent).toContain("Using Grep");
  // The description is the line once, not again as the summary.
  expect(agent.textContent?.split("Survey the tests").length).toBe(2);
  expect(log.textContent).toContain("Context compacted");
  await user.click(screen.getByRole("button", { name: /Proposed a plan/ }));
  expect(log.querySelector('[data-slot="tool-plan"] h2')?.textContent).toBe("The plan");
  expect(screen.getByRole("button", { name: /Asked/ }).textContent).toContain("Which library?");
  // All done: the strip goes.
  await emit(plan(["completed", "completed", "completed"]));
  await waitFor(() => expect(document.querySelector('[data-kind="plan-strip"]')).toBeNull());
});

test("an MCP tool reads by its title and the first short line of its input; a search's hits are links; a fetch says its status", async () => {
  const { user, log, script } = await open(
    you("u1"),
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "m",
      name: "mcp__linear__create_issue",
      title: "linear · create_issue",
      status: "completed",
      rawInput: { team: "CYCL", title: "Fix the login bug", description: "A long\nbody" },
    }),
    u({
      sessionUpdate: "agent_message",
      messageId: "a1",
      content: [{ type: "text", text: "next" }],
    }),
    ...finished(
      "s",
      "WebSearch",
      { query: "bun test runner" },
      {
        content: [
          { type: "content", content: { type: "text", text: "Two results." } },
          {
            type: "content",
            content: {
              type: "resource_link",
              uri: "https://bun.sh/docs/cli/test",
              name: "Test runner",
            },
          },
          {
            type: "content",
            content: { type: "resource_link", uri: "javascript:alert(1)", name: "Trap" },
          },
        ],
      },
    ),
    u({
      sessionUpdate: "agent_message",
      messageId: "a2",
      content: [{ type: "text", text: "next" }],
    }),
    ...finished(
      "f",
      "WebFetch",
      { url: "https://example.com/missing", prompt: "Read it" },
      { _meta: { "cycle/toolResult": { fetch: { status: 404, bytes: 1500 } } } },
    ),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  await openWork(user);
  const mcp = await screen.findByRole("button", { name: /linear · create_issue/ });
  // The first short line of its input, not the first field: "CYCL" is short too, and comes first.
  expect(mcp.textContent).toContain("CYCL");
  expect(mcp.textContent).not.toContain("A long");
  const search = screen.getByRole("button", { name: /Searched/ });
  expect(search.textContent).toContain("bun test runner");
  await user.click(search);
  const link = within(log).getByRole("link", { name: "Test runner" });
  expect(link.getAttribute("href")).toBe("https://bun.sh/docs/cli/test");
  // What the page told, apart from opening the folded work to reach the links.
  const links = () =>
    script.calls.filter(([name, event]) => name === "track" && event !== "turn_work_opened");
  const opened: unknown[][] = [];
  const windowOpen = window.open;
  window.open = ((...args: unknown[]) => {
    opened.push(args);
    return null;
  }) as typeof window.open;
  try {
    // A click asks first, showing where the link goes; nothing is opened or counted until the person says yes.
    await user.click(link);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("https://bun.sh/docs/cli/test");
    expect(opened).toEqual([]);
    expect(links()).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Open link" }));
    expect(opened).toEqual([["https://bun.sh/docs/cli/test", "_blank", "noopener,noreferrer"]]);
  } finally {
    window.open = windowOpen;
  }
  // That a link was opened, never which.
  expect(links()).toEqual([["track", "tool_link_opened", {}]]);
  expect(link.parentElement?.textContent).toContain("bun.sh");
  // An address that is not a web one is text, never a link.
  expect(within(log).queryByRole("link", { name: "Trap" })).toBeNull();
  expect(log.textContent).toContain("Trap");
  const fetch = screen.getByRole("button", { name: /Fetched/ });
  expect(fetch.textContent).toContain("404 · 1.5 kB");
});

test("a long plan does not lengthen the window: nothing scrolls the header off its top", async () => {
  // Mounted as the desktop page mounts it, in a #root as tall as the window, so the page's own height is what is measured.
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  const updates: SessionUpdate[] = [
    you("u1"),
    u({
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "tasks",
        entries: Array.from({ length: 40 }, (_, n) => ({
          content: `Step ${n + 1}`,
          priority: "medium",
          status: n < 30 ? "completed" : "pending",
        })),
      },
    }),
  ];
  const script = fakeBridge({
    connected: true,
    snapshot: (): SessionSnapshot => ({
      conversation: updates.reduce((c, u) => applyUpdate(c, u), emptyConversation()),
      permissions: [],
      version: updates.length,
    }),
  });
  const store = new AppStore(script.bridge);
  const user = userEvent.setup();
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
    { container: root },
  );
  try {
    await act(() => store.start());
    await user.click(await screen.findByRole("option", { name: /work/ }));
    await user.click(await screen.findByRole("button", { name: "Show panel" }));
    await waitFor(() =>
      expect(document.querySelector('[data-kind="plan-strip"] > button')).not.toBeNull(),
    );
    await user.click(document.querySelector('[data-kind="plan-strip"] > button') as HTMLElement);
    // The plan is drawn twice: in the Overview and in the strip above the input box.
    await waitFor(() => expect(document.querySelectorAll('[data-slot="plan"]').length).toBe(2));
    // Each row's word for a screen reader is placed against its list, not against the page.
    for (const word of document.querySelectorAll<HTMLElement>(
      '[data-slot="plan"] [data-slot="visually-hidden"]',
    ))
      expect(word.offsetParent?.closest('[data-slot="plan"]')).not.toBeNull();
    const page = document.scrollingElement as HTMLElement;
    expect(page.scrollHeight).toBe(page.clientHeight);
    // What scrolls the window (a wheel run past the conversation's end, an item brought into view) moves nothing.
    window.scrollTo(0, 500);
    const columns = document.querySelector<HTMLElement>(
      '[data-slot="split"] > [data-slot="resizable"]',
    );
    columns?.scrollTo(0, 500);
    document.querySelector('[data-slot="plan"] li:last-child')?.scrollIntoView({ block: "end" });
    expect(page.scrollTop).toBe(0);
    expect(columns?.scrollTop).toBe(0);
    expect(document.querySelector('[data-slot="main-header"]')?.getBoundingClientRect().top).toBe(
      0,
    );
  } finally {
    root.remove();
  }
});

test("a sub-agent is a card of its own: its task, how it goes, and once back the start of its answer, all of it when opened", async () => {
  const { user, log, emit } = await open(
    you("u1"),
    state({ state: "running" }),
    ...tool("s1", "Agent", "in_progress", {
      description: "Find the flaky test",
      subagent_type: "Explore",
      prompt: "Find which test is flaky and why.",
    }),
    u({
      sessionUpdate: "subagent_update",
      sessionId: "sub-1",
      state: { state: "running" },
      _meta: { "cycle/subagent": { toolCallId: "s1", background: false, lastTool: "Grep" } },
    }),
  );
  const card = await waitFor(() => {
    const found = log.querySelector<HTMLElement>('[data-kind="subagent"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  expect(card.textContent).toContain("Find the flaky test");
  expect(card.textContent).toContain("Explore");
  expect(card.textContent).toContain("Using Grep");
  expect(card.querySelector('[data-slot="subagent-answer"]')).toBeNull();
  await emit(
    u({
      sessionUpdate: "subagent_update",
      sessionId: "sub-1",
      state: { state: "idle", stopReason: "end_turn" },
      _meta: {
        "cycle/subagent": {
          toolCallId: "s1",
          usage: { tokens: 900, toolUses: 4, durationMs: 12_000 },
        },
      },
    }),
  );
  await emit(
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "s1",
      status: "completed",
      content: [
        {
          type: "content",
          content: {
            type: "text",
            text: "**queue.test.ts** is flaky: it sleeps instead of waiting.",
          },
        },
      ],
    }),
  );
  await waitFor(() => expect(card.textContent).toContain("4 steps"));
  const preview = card.querySelector('[data-slot="subagent-answer"]') as HTMLElement;
  // Drawn as markdown, as the reply it is.
  expect(preview.querySelector('[data-streamdown="strong"]')?.textContent).toBe("queue.test.ts");
  await user.click(within(card).getByRole("button", { name: "Show the whole answer" }));
  await waitFor(() => expect(card.textContent).toContain("Find which test is flaky and why."));
  expect(card.querySelector('[data-slot="subagent-answer"]')).toBeNull();
});

const child = (update: object) =>
  u({ sessionUpdate: "_cycle/child_update", childId: "sub-1", update });

test("a sub-agent's card opens to what it did, apart from the main agent's work, and a permission it asks for says which one", async () => {
  const { user, log, emit, ask, script } = await open(
    you("u1"),
    state({ state: "running" }),
    ...tool("s1", "Agent", "in_progress", {
      description: "Find the flaky test",
      prompt: "Find it.",
    }),
    u({
      sessionUpdate: "subagent_update",
      sessionId: "sub-1",
      state: { state: "running" },
      _meta: { "cycle/subagent": { toolCallId: "s1" } },
    }),
    child({
      sessionUpdate: "agent_message_chunk",
      messageId: "c1",
      content: { type: "text", text: "Looking at the queue tests." },
    }),
    child({
      sessionUpdate: "tool_call_update",
      toolCallId: "c-read",
      name: "Read",
      kind: "read",
      status: "pending",
    }),
    child({
      sessionUpdate: "tool_call_update",
      toolCallId: "c-read",
      status: "completed",
      rawInput: { file_path: "test/queue.test.ts" },
    }),
  );
  const card = await waitFor(() => {
    const found = log.querySelector<HTMLElement>('[data-kind="subagent"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  // Closed, nothing of what it did is drawn: at most the last thing it said, as what it does now, on its card's line.
  // None of it is in the main agent's words.
  expect(card.querySelector('[data-slot="subagent-glimpse"]')?.textContent).toBe(
    "Looking at the queue tests.",
  );
  expect(log.textContent?.replace(card.textContent ?? "", "")).not.toContain(
    "Looking at the queue tests.",
  );
  expect(card.querySelector('[data-slot="subagent-work"]')).toBeNull();
  await user.click(within(card).getByRole("button", { name: /Find the flaky test/ }));
  const work = await waitFor(() => {
    const found = card.querySelector<HTMLElement>('[data-slot="subagent-work"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  expect(within(card).getByRole("region", { name: "What it did" })).toBeDefined();
  expect(work.textContent).toContain("Looking at the queue tests.");
  expect(work.textContent).toContain("queue.test.ts");
  // What it says next arrives in the open card.
  await emit(
    child({
      sessionUpdate: "agent_message_chunk",
      messageId: "c2",
      content: { type: "text", text: "It sleeps instead of waiting." },
    }),
  );
  await waitFor(() => expect(work.textContent).toContain("It sleeps instead of waiting."));
  expect(
    script.calls.filter(([name, event]) => name === "track" && event === "subagent_opened"),
  ).toEqual([["track", "subagent_opened", { work: true, running: true }]]);

  // It asks for leave: the card says that the sub-agent asks, by what it was sent to do.
  const request = {
    key: "local:s1:p1",
    locationId: "local",
    sessionId: "s1",
    title: "Allow Bash?",
    subject: { type: "tool_call", toolCall: { name: "Bash", rawInput: { command: "ls" } } },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
  };
  await ask({ ...request, subagentId: "sub-1" });
  const card2 = await screen.findByLabelText("Allow Bash?");
  expect(card2.textContent).toContain("Asked by the sub-agent Find the flaky test");
});

test("a sub-agent at work can be stopped alone from its card, by keyboard too, and only where it can be (CYCL-143)", async () => {
  const running = (id: string, call: string, extra: object = {}) =>
    u({
      sessionUpdate: "subagent_update",
      sessionId: id,
      state: { state: "running" },
      _meta: { "cycle/subagent": { toolCallId: call, background: id === "sub-bg" } },
      ...extra,
    });
  const updates = [
    you("u1"),
    state({ state: "running" }),
    ...tool("s1", "Agent", "in_progress", { description: "Find the flaky test" }),
    running("sub-1", "s1", { capabilities: { cancel: {} } }),
    // Its agent says nothing of stopping it: no button.
    ...tool("s2", "Agent", "in_progress", { description: "Read the docs" }),
    running("sub-2", "s2"),
  ];
  const { user, log, emit, script } = await openWith({ stopSubagent: true }, ...updates);
  const stop = await within(log).findByRole("button", {
    name: "Stop sub-agent Find the flaky test",
  });
  expect(within(log).queryByRole("button", { name: /Stop sub-agent Read the docs/ })).toBeNull();
  stop.focus();
  await user.keyboard("{Enter}");
  await waitFor(() =>
    expect(script.calls.filter(([name]) => name === "stopSubagent")).toEqual([
      ["stopSubagent", "local", "s1", "sub-1", false],
    ]),
  );
  // Asked once: it says so, and cannot be asked again, until its end comes. The keyboard stays on it.
  await waitFor(() => expect(stop.textContent).toBe("Stopping…"));
  expect(stop.getAttribute("aria-disabled")).toBe("true");
  expect(stop.getAttribute("aria-label")).toBe("Stopping sub-agent Find the flaky test");
  expect(document.activeElement).toBe(stop);
  await user.keyboard("{Enter}");
  expect(script.calls.filter(([name]) => name === "stopSubagent")).toHaveLength(1);
  await emit(
    u({
      sessionUpdate: "subagent_update",
      sessionId: "sub-1",
      state: { state: "idle", stopReason: "cancelled" },
      _meta: { "cycle/subagent": { toolCallId: "s1" } },
    }),
  );
  await waitFor(() =>
    expect(within(log).queryByRole("button", { name: /Stop sub-agent/ })).toBeNull(),
  );
  const card = log.querySelector('[data-item-id="s1"]') as HTMLElement;
  expect(card.textContent).toContain("Stopped");
  // The button went with its sub-agent: the keyboard is on the card, not lost to the page.
  expect(document.activeElement).toBe(card.querySelector(":scope > button"));
  cleanup();

  // A daemon that cannot stop one alone: no button, whatever the agent says.
  const older = await openWith({}, ...updates);
  await within(older.log).findByText("Find the flaky test");
  expect(within(older.log).queryByRole("button", { name: /Stop sub-agent/ })).toBeNull();
  cleanup();

  // The daemon has nothing to stop (it ended while the card was behind): the button goes, not "Stopping…" for good.
  const behind = await openWith({ stopSubagent: true, stopped: async () => false }, ...updates);
  await behind.user.click(
    await within(behind.log).findByRole("button", { name: "Stop sub-agent Find the flaky test" }),
  );
  await waitFor(() =>
    expect(within(behind.log).queryByRole("button", { name: /sub-agent Find/ })).toBeNull(),
  );
  cleanup();

  // The ask fails: the error is shown, and it can be asked again.
  let fail = true;
  const failing = await openWith(
    {
      stopSubagent: true,
      stopped: async () => {
        if (fail) throw new Error("connection lost");
        return true;
      },
    },
    ...updates,
  );
  const again = await within(failing.log).findByRole("button", {
    name: "Stop sub-agent Find the flaky test",
  });
  await failing.user.click(again);
  await screen.findByText(/connection lost/);
  await waitFor(() => expect(again.textContent).toBe("Stop"));
  expect(again.getAttribute("aria-disabled")).toBeNull();
  fail = false;
  await failing.user.click(again);
  await waitFor(() => expect(again.textContent).toBe("Stopping…"));
  expect(failing.script.calls.filter(([name]) => name === "stopSubagent")).toHaveLength(2);
});

test("a sub-agent's last words, which are its answer, are shown once: as the answer", async () => {
  const answer = "queue.test.ts sleeps instead of waiting.";
  const { user, log } = await open(
    you("u1"),
    state({ state: "running" }),
    ...tool("s1", "Agent", "in_progress", { description: "Find the flaky test" }),
    u({
      sessionUpdate: "subagent_update",
      sessionId: "sub-1",
      state: { state: "running" },
      _meta: { "cycle/subagent": { toolCallId: "s1" } },
    }),
    child({
      sessionUpdate: "agent_message_chunk",
      messageId: "c1",
      content: { type: "text", text: "Looking at the queue tests." },
    }),
    child({
      sessionUpdate: "agent_message_chunk",
      messageId: "c2",
      content: { type: "text", text: answer },
    }),
    u({
      sessionUpdate: "subagent_update",
      sessionId: "sub-1",
      state: { state: "idle", stopReason: "end_turn" },
      _meta: { "cycle/subagent": { toolCallId: "s1" } },
    }),
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "s1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: answer } }],
    }),
  );
  const card = await waitFor(() => {
    const found = log.querySelector<HTMLElement>('[data-kind="subagent"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  await user.click(within(card).getByRole("button", { name: /Find the flaky test/ }));
  const work = await waitFor(() => {
    const found = card.querySelector<HTMLElement>('[data-slot="subagent-work"]');
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  expect(work.textContent).toContain("Looking at the queue tests.");
  expect(work.textContent).not.toContain(answer);
  expect(within(card).getByRole("region", { name: "Result" }).textContent).toContain(answer);
});

test("a permission the main agent asks for says nothing of a sub-agent; one from a sub-agent not known here still says one asks", async () => {
  const { ask } = await open(you("u1"), state({ state: "running" }));
  const request = {
    key: "local:s1:p2",
    locationId: "local",
    sessionId: "s1",
    title: "Allow Read?",
    subject: { type: "tool_call", toolCall: { name: "Read", rawInput: { file_path: "a" } } },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
  };
  await ask(request);
  const main = await screen.findByLabelText("Allow Read?");
  expect(main.querySelector('[data-slot="permission-asker"]')).toBeNull();
  await ask({ ...request, key: "local:s1:p3", title: "Allow Grep?", subagentId: "gone" });
  // One at a time: the first is answered first, the second waits behind it.
  expect(main.textContent).toContain("1 more");
});

test("a sub-agent sent to the background shows no answer from its launch; one that failed says so on its closed card", async () => {
  const { log } = await open(
    you("u1"),
    ...tool("bg", "Agent", "completed", { description: "Watch the logs", prompt: "Watch." }),
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "bg",
      content: [{ type: "content", content: { type: "text", text: "Async agent launched" } }],
    }),
    u({
      sessionUpdate: "subagent_update",
      sessionId: "sub-bg",
      state: { state: "running" },
      _meta: { "cycle/subagent": { toolCallId: "bg", background: true, lastTool: "Read" } },
    }),
    ...tool("bad", "Agent", "completed", { description: "Fix the build", prompt: "Fix it." }),
    u({
      sessionUpdate: "subagent_update",
      sessionId: "sub-bad",
      state: { state: "idle", stopReason: "error" },
      _meta: { "cycle/subagent": { toolCallId: "bad" } },
    }),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  const cards = await waitFor(() => {
    const found = log.querySelectorAll<HTMLElement>('[data-kind="subagent"]');
    expect(found).toHaveLength(2);
    return [...found];
  });
  const [background, bad] = cards as [HTMLElement, HTMLElement];
  expect(background.querySelector('[data-slot="subagent-answer"]')).toBeNull();
  expect(background.textContent).not.toContain("Async agent launched");
  expect(bad.getAttribute("data-status")).toBe("failed");
  // Closed, as every card starts: its head says it failed, in a word and a mark, and nothing of it is open.
  expect(bad.querySelector(":scope > button")?.getAttribute("aria-expanded")).toBe("false");
  expect(bad.textContent).toContain("Failed");
  expect(bad.textContent).not.toContain("Fix it.");
});

test("a turn that ended normally shows its answer with its work folded above it; one that stopped stays open", async () => {
  const { user, log, script } = await open(
    you("u1"),
    say("first look"),
    ...tool("a", "Bash", "completed", { command: "make" }),
    say("the answer"),
    state({ state: "idle", stopReason: "end_turn" }),
    you("u2"),
    ...tool("b", "Bash", "completed", { command: "make check" }),
    say("halfway"),
    state({ state: "idle", stopReason: "cancelled" }),
  );
  const fold = await screen.findByRole("button", { name: /^Worked/ });
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  expect(log.textContent).toContain("the answer");
  expect(log.textContent).not.toContain("first look");
  // The turn that was stopped is read as it went: nothing of it is folded.
  expect(screen.getAllByRole("button", { name: /^Worked/ })).toHaveLength(1);
  expect(log.textContent).toContain("make check");
  expect(log.textContent).toContain("halfway");
  await user.click(fold);
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  // Told that it was opened, never what it holds.
  expect(
    script.calls.filter(([name, event]) => name === "track" && event === "turn_work_opened"),
  ).toEqual([["track", "turn_work_opened", {}]]);
  await waitFor(() => expect(log.textContent).toContain("first look"));
  expect(log.textContent).toContain("make");
  // Keyboard: the same line closes it.
  fold.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(fold.getAttribute("aria-expanded")).toBe("false"));
});

/** A call to Claude's advisor, as its adapter tells it: no input, then how it answered. */
const advisor = (id: string, end?: { status: string; rawOutput: object; text?: string }) => [
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: id,
    name: "advisor",
    kind: "other",
    status: "in_progress",
    rawInput: {},
  }),
  ...(end === undefined
    ? []
    : [
        u({
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: end.status,
          rawOutput: end.rawOutput,
          ...(end.text !== undefined
            ? { content: [{ type: "content", content: { type: "text", text: end.text } }] }
            : {}),
        }),
      ]),
];

test("asking the advisor is a row that says so while it waits, then that it asked, and opens to why there is nothing to read", async () => {
  const { user, log, emit } = await open(you("u1"), ...advisor("v"), state({ state: "running" }));
  const row = await screen.findByRole("button", { name: /Asking the advisor/ });
  // No input to show, and no tool name of its own on the line.
  expect(row.textContent).not.toContain("{}");
  await emit(
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "v",
      status: "completed",
      rawOutput: { type: "advisor_redacted_result" },
    }),
  );
  const done = await screen.findByRole("button", { name: /Asked the advisor/ });
  await user.click(done);
  await waitFor(() => expect(log.textContent).toContain("only Claude can read it"));
});

test("the advisor's advice in the clear is read when its row is opened, and one that failed says why", async () => {
  const { user, log } = await open(
    you("u1"),
    ...advisor("v", {
      status: "completed",
      rawOutput: { type: "advisor_result" },
      text: "Close the input channel first.",
    }),
    say("a1"),
    ...advisor("w", {
      status: "failed",
      rawOutput: { type: "advisor_tool_result_error", error_code: "overloaded" },
    }),
    state({ state: "running" }),
  );
  await user.click(await screen.findByRole("button", { name: /Asked the advisor/ }));
  await waitFor(() => expect(log.textContent).toContain("Close the input channel first."));
  const failed = await screen.findByRole("button", { name: /The advisor could not answer/ });
  expect(failed.textContent).toContain("failed");
  await user.click(failed);
  await waitFor(() => expect(log.textContent).toContain("(overloaded)"));
});

test("two calls to the advisor in a card are counted as asking it", async () => {
  await open(
    you("u1"),
    ...advisor("v", { status: "completed", rawOutput: { type: "advisor_redacted_result" } }),
    ...tool("a", "Bash", "completed", { command: "make" }),
    ...advisor("w", { status: "completed", rawOutput: { type: "advisor_redacted_result" } }),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  await screen.findByRole("button", { name: /^Asked the advisor 2 times and ran 1 command/ });
});

test("Codex and agy consecutive command cards show every command, hide exit 0 noise, and keep failures clear", async () => {
  const longAgyCmd = `bun test ${"packages/ui/test/".repeat(9)}blocks.test.ts`;
  const { user, log } = await open(
    you("u1"),
    // Codex new shape (rawInput.command + cwd)
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "c1",
      name: "exec_command",
      title: "bun run check",
      kind: "execute",
      status: "completed",
      rawInput: { command: "bun run check", cwd: "/repo" },
      _meta: { "cycle/toolResult": { run: {} } },
    }),
    // Codex legacy log shape (title only, no rawInput)
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "c2",
      name: "exec_command",
      title: "/bin/zsh -lc 'git status'",
      kind: "execute",
      status: "completed",
    }),
    // agy normalized shape (long command + extra runner params + exitCode 0)
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "a1",
      name: "run_command",
      title: longAgyCmd,
      kind: "execute",
      status: "completed",
      rawInput: { command: longAgyCmd, WaitMsBeforeAsync: 10_000, toolSummary: "Run blocks test" },
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
      _meta: { "cycle/toolResult": { run: { exitCode: 0 } } },
    }),
    // agy legacy shape (PascalCase CommandLine > 120 chars)
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "a2",
      name: "run_command",
      title: longAgyCmd,
      kind: "execute",
      status: "completed",
      rawInput: { CommandLine: longAgyCmd, WaitMsBeforeAsync: 5000 },
    }),
    // Failed command with non-zero exit code
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: "f1",
      name: "exec_command",
      title: "bun run build",
      kind: "execute",
      status: "failed",
      rawInput: { command: "bun run build", cwd: "/repo" },
      content: [{ type: "content", content: { type: "text", text: "build failed" } }],
      _meta: { "cycle/toolResult": { run: { exitCode: 2 } } },
    }),
    state({ state: "idle", stopReason: "end_turn" }),
  );
  await user.click(await screen.findByRole("button", { name: /Ran 5 commands/ }));
  for (const [id, expected] of [
    ["c1", "bun run check"],
    ["c2", "/bin/zsh -lc 'git status'"],
    ["a1", longAgyCmd],
    ["a2", longAgyCmd],
    ["f1", "bun run build"],
  ] as const) {
    const summary = log.querySelector(`[data-item-id="${id}"] [data-slot="tool-summary"]`);
    expect(summary?.textContent).toBe(expected);
  }
  // Successful exitCode: 0 does not clutter the row with "exited with code 0".
  expect(log.querySelector('[data-item-id="a1"] [data-slot="tool-facts"]')).toBeNull();
  // Failed command shows its exit code and failed status.
  expect(log.querySelector('[data-item-id="f1"] [data-slot="tool-facts"]')?.textContent).toBe(
    "exited with code 2",
  );
  expect(log.querySelector('[data-item-id="f1"] [data-slot="tool-status"]')?.textContent).toBe(
    "failed",
  );
  // Expanding an agy command renders the command block and does not repeat `command` in extra input JSON.
  await user.click(log.querySelector('[data-item-id="a1"] > button') as HTMLElement);
  const cmdBlock = log.querySelector('[data-item-id="a1"] [data-kind="command"]');
  expect(cmdBlock?.textContent).toContain(longAgyCmd);
  const extraInput = log.querySelector('[data-item-id="a1"] [data-slot="tool-input"]');
  expect(extraInput?.textContent).not.toContain(longAgyCmd);
});
