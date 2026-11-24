import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { SessionSnapshot } from "../../src/api.ts";
import { applyUpdate, emptyConversation } from "../../src/model/index.ts";
import { fakeBridge, idle, summary, text } from "../fake-bridge.ts";
import { renderApp } from "./render-app.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const u = (update: object) => update as SessionUpdate;

const history = (...updates: SessionUpdate[]): SessionSnapshot => ({
  conversation: updates.reduce((c, u) => applyUpdate(c, u), emptyConversation()),
  permissions: [],
  version: updates.length,
});

const busy = history(
  u({ sessionUpdate: "user_message", messageId: "u1", content: [{ type: "text", text: "Go" }] }),
  u({
    sessionUpdate: "plan_update",
    plan: {
      type: "items",
      planId: "tasks",
      entries: [
        { content: "Write the parser", priority: "medium", status: "completed" },
        { content: "Test the parser", priority: "medium", status: "in_progress" },
      ],
    },
  }),
  u({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-b",
    title: "Bash",
    kind: "execute",
    status: "completed",
    rawInput: { command: "bun dev", run_in_background: true },
    _meta: { "cycle/tool": "Bash" },
  }),
  u({
    sessionUpdate: "_cycle/task_update",
    taskId: "b1",
    kind: "shell",
    title: "Run the dev server",
    toolCallId: "call-b",
    state: "running",
  }),
  u({ sessionUpdate: "_cycle/task_update", taskId: "old", kind: "monitor", state: "completed" }),
  u({
    sessionUpdate: "_cycle/goal_update",
    goal: { condition: "All tests pass", iterations: 2, setAt: 0, lastReason: "Two still fail" },
  }),
  u({
    sessionUpdate: "config_option_update",
    configOptions: [
      {
        configId: "model",
        name: "Model",
        type: "select",
        currentValue: "opus",
        options: [{ value: "opus", name: "Opus" }],
      },
      {
        configId: "mode",
        name: "Mode",
        type: "select",
        currentValue: "default",
        options: [{ value: "default", name: "Ask" }],
      },
    ],
  }),
  text("Working on it", "a1"),
  idle({ stopReason: "end_turn" }),
);

const mount = async (snapshot: SessionSnapshot) => {
  const script = fakeBridge({ connected: true, snapshot: () => snapshot });
  await renderApp(script.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: /work/ }));
  await screen.findByRole("log", { name: "Conversation" });
  await user.click(await screen.findByRole("button", { name: "Show panel" }));
  const panel = await screen.findByRole("complementary", { name: "Panel" });
  return { script, user, panel };
};

test("the Overview shows the goal, the todo list, the background, and the session's settings", async () => {
  const { panel } = await mount(busy);
  const overview = within(panel);
  expect(overview.getByRole("heading", { name: "Goal" })).toBeDefined();
  expect(panel.textContent).toContain("All tests pass");
  expect(panel.textContent).toContain("Two still fail");
  expect(panel.textContent).toContain("1 of 2 done");
  expect(panel.textContent).toContain("Test the parser");
  expect(overview.getByRole("button", { name: /Run the dev server/ })).toBeDefined();
  expect(panel.textContent).toContain("1 running");
  expect(panel.textContent).toContain("1 ended");
  // This history is from before the agent told its scheduled calls: not known, not "none".
  expect(panel.textContent).toContain("Not reported for this session");
  expect(panel.textContent).toContain("Opus");
  // A setting left to the agent is said to be the default, not guessed at.
  expect(panel.textContent).toContain("Default");
  expect(panel.textContent).toContain("/work");
});

test("a background task goes back to the call that started it, and only the section is counted", async () => {
  const { panel, user, script } = await mount(busy);
  await user.click(within(panel).getByRole("button", { name: /Run the dev server/ }));
  await waitFor(() =>
    expect(document.querySelector('[data-item-id="call-b"][data-revealed]')).not.toBeNull(),
  );
  const events = script.calls
    .filter(([name]) => name === "track")
    .map(([, event, props]) => [event, props])
    .filter(([event]) => event === "overview_item_revealed");
  expect(events).toEqual([["overview_item_revealed", { section: "background" }]]);
  expect(JSON.stringify(events)).not.toContain("dev server");
});

test("a session from before these updates says what it has not got, block by block", async () => {
  const { panel } = await mount(history(text("Hello", "a1"), idle({ stopReason: "end_turn" })));
  expect(within(panel).queryByRole("heading", { name: "Goal" })).toBeNull();
  expect(panel.textContent).toContain("No todo list in this session yet");
  expect(panel.textContent).toContain("Nothing running in the background");
  expect(panel.textContent).toContain("No usage reported yet");
  expect(panel.textContent).toContain("Not reported for this session");
});

const scheduled = (jobs: object[], dormant?: boolean) =>
  u({ sessionUpdate: "_cycle/schedule_update", jobs, ...(dormant ? { dormant } : {}) });

test("what is scheduled is listed in the agent's words, goes back to the call that set it, and says when it will not fire", async () => {
  const wakeupCall = u({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-w",
    title: "ScheduleWakeup",
    kind: "other",
    status: "completed",
    rawInput: { delaySeconds: 1200, prompt: "Check the build again" },
    _meta: { "cycle/tool": "ScheduleWakeup" },
  });
  const jobs = [
    {
      id: "c9",
      kind: "wakeup",
      schedule: "20 3 * * *",
      recurring: false,
      durable: false,
      prompt: "Check the build again\nand say what changed",
      nextFireAt: Date.now() + 20 * 60_000,
      toolCallId: "call-w",
    },
    {
      id: "d1",
      kind: "cron",
      schedule: "0 9 * * 1-5",
      recurring: true,
      durable: true,
      prompt: "Morning summary",
    },
  ];
  const { panel, user, script } = await mount(
    history(
      u({
        sessionUpdate: "user_message",
        messageId: "u1",
        content: [{ type: "text", text: "Go" }],
      }),
      wakeupCall,
      scheduled(jobs),
      text("I will look again in 20 minutes", "a1"),
      idle({ stopReason: "end_turn" }),
      scheduled(jobs, true),
    ),
  );
  const overview = within(panel);
  expect(overview.getByRole("heading", { name: "Scheduled" })).toBeDefined();
  expect(panel.textContent).toContain("2 set");
  // The first line of what it will say is its title; how and when are under it.
  const wakeup = overview.getByRole("button", { name: /Check the build again/ });
  expect(wakeup.textContent).not.toContain("and say what changed");
  expect(wakeup.textContent).toContain("Wakeup");
  expect(wakeup.textContent).toContain("next about");
  // Without the agent's words for its schedule, the expression; saved in the project, as last heard.
  expect(panel.textContent).toContain("Cron · 0 9 * * 1-5 · saved in the project, as last heard");
  expect(overview.queryByRole("button", { name: /Morning summary/ })).toBeNull();
  expect(panel.textContent).toContain("A scheduled call due before the next message is skipped.");
  await user.click(wakeup);
  await waitFor(() =>
    expect(document.querySelector('[data-item-id="call-w"][data-revealed]')).not.toBeNull(),
  );
  const events = script.calls
    .filter(([name, event]) => name === "track" && event === "overview_item_revealed")
    .map(([, , props]) => props);
  expect(events).toEqual([{ section: "scheduled" }]);
});

test("an agent that tells its list and has nothing scheduled says so", async () => {
  const { panel } = await mount(
    history(text("Hello", "a1"), idle({ stopReason: "end_turn" }), scheduled([], true)),
  );
  expect(panel.textContent).toContain("Nothing scheduled");
  // Asleep with nothing to miss: nothing to warn of.
  expect(panel.textContent).not.toContain("is skipped");
});

test("a task started by a call inside a closed card of several calls opens the card to show it", async () => {
  const call = (id: string, command: string) =>
    u({
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      title: "Bash",
      kind: "execute",
      status: "completed",
      rawInput: { command },
    });
  const { panel, user } = await mount(
    history(
      u({
        sessionUpdate: "user_message",
        messageId: "u1",
        content: [{ type: "text", text: "Go" }],
      }),
      call("c1", "ls"),
      call("c2", "bun dev"),
      u({
        sessionUpdate: "_cycle/task_update",
        taskId: "b2",
        kind: "shell",
        title: "Serve the app",
        toolCallId: "c2",
        state: "running",
      }),
      text("Started", "a1"),
      idle({ stopReason: "end_turn" }),
    ),
  );
  expect(document.querySelector('[data-item-id="c2"]')).toBeNull();
  await user.click(within(panel).getByRole("button", { name: /Serve the app/ }));
  await waitFor(() =>
    expect(document.querySelector('[data-item-id="c2"][data-revealed]')).not.toBeNull(),
  );
});

/** Opens the session as the daemon lists it, `background` running; the panel stays shut. */
const openBetweenTurns = async (snapshot: SessionSnapshot, background: number | undefined) => {
  const script = fakeBridge({ connected: true, snapshot: () => snapshot });
  script.bridge.sessions = async (environmentId: string) => [
    { ...summary("s1", environmentId), ...(background === undefined ? {} : { background }) },
  ];
  await renderApp(script.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("option", { name: /work/ }));
  const log = await screen.findByRole("log", { name: "Conversation" });
  return { script, user, log };
};

test("between turns, what still runs in the background is said at the end of the conversation and opens the Overview", async () => {
  const { script, user, log } = await openBetweenTurns(busy, 1);
  // Not the turn's loader and no clock: a ring, how many, and what.
  const line = await within(log).findByRole("button", { name: /1 running in the background/ });
  expect(line.textContent).toContain("Run the dev server");
  expect(line.textContent).not.toContain("old");
  // It says what it does, and it is not read out as it changes.
  expect(line.getAttribute("aria-label") ?? line.textContent).toContain(
    "Show background work in the Overview",
  );
  expect(line.closest("[aria-live]")).toBeNull();
  expect(
    log.querySelector('[data-step="background"] [data-slot="dot"][data-shape="ring"]'),
  ).not.toBeNull();
  expect(log.querySelector('[data-step="background"] [data-slot="morph-loader"]')).toBeNull();
  expect(log.querySelector('[data-step="background"] [data-slot="step-elapsed"]')).toBeNull();
  expect(screen.queryByRole("complementary", { name: "Panel" })).toBeNull();
  await user.click(line);
  const panel = await screen.findByRole("complementary", { name: "Panel" });
  expect(within(panel).getByRole("heading", { name: "Background" })).toBeDefined();
  // A second click, on the Overview already shown, is not counted again.
  await user.click(line);
  const events = script.calls.filter(
    ([name, event]) => name === "track" && event === "background_shown_from_conversation",
  );
  expect(events).toHaveLength(1);
});

test("a task the history says runs is not said to once the daemon counts nothing (its agent process died)", async () => {
  const { log } = await openBetweenTurns(busy, undefined);
  await within(log).findByText("Working on it");
  expect(log.querySelector('[data-slot="step"]')).toBeNull();
});

test("nothing is said between turns once the background has ended", async () => {
  const ended = history(
    u({ sessionUpdate: "user_message", messageId: "u1", content: [{ type: "text", text: "Go" }] }),
    u({ sessionUpdate: "_cycle/task_update", taskId: "b1", kind: "shell", state: "running" }),
    u({ sessionUpdate: "_cycle/task_update", taskId: "b1", state: "completed" }),
    text("Done", "a1"),
    idle({ stopReason: "end_turn" }),
  );
  const { log } = await openBetweenTurns(ended, 1);
  await within(log).findByText("Done");
  expect(log.querySelector('[data-slot="step"]')).toBeNull();
});
