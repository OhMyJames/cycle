import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { SessionSnapshot } from "../../src/api.ts";
import { applyUpdate, emptyConversation } from "../../src/model/index.ts";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge, idle, text } from "../fake-bridge.ts";
import { press, ready, write } from "./box.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const mount = async (
  configure?: (script: ReturnType<typeof fakeBridge>) => void,
  snapshot?: () => SessionSnapshot,
) => {
  const script = fakeBridge({ connected: true, ...(snapshot ? { snapshot } : {}) });
  configure?.(script);
  const store = new AppStore(script.bridge);
  const user = userEvent.setup();
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  const emit = (event: Parameters<typeof script.emit>[0]) => act(() => script.emit(event));
  await user.click(await screen.findByRole("option", { name: /work/ }));
  await screen.findByRole("log", { name: "Conversation" });
  return { store, user, ...script, emit };
};

const header = () => document.querySelector('[data-slot="session-header"]') as HTMLElement;
const lines = () => [...document.querySelectorAll<HTMLElement>('[data-slot="notice-line"]')];
/** Where a node is, against the title bar: after it in the page, and below it on screen. */
const underTitleBar = (node: HTMLElement) => {
  expect(header().compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(node.getBoundingClientRect().top).toBeGreaterThanOrEqual(
    header().getBoundingClientRect().bottom - 1,
  );
};

test("what just failed is a red line under the session's title bar, and Dismiss takes it away", async () => {
  const { user } = await mount((script) => {
    script.bridge.prompt = async () => {
      throw new Error("The session is working");
    };
  });
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "hi");
  await press(box, "Enter");
  const alert = await screen.findByRole("alert");
  expect(alert.getAttribute("data-slot")).toBe("notice-line");
  expect(alert.getAttribute("data-tone")).toBe("error");
  expect(alert.textContent).toContain("The session is working");
  underTitleBar(alert);
  await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

test("a dropped connection is an amber line under the title bar, gone when it is back", async () => {
  const { emit } = await mount();
  expect(lines()).toEqual([]);
  await emit({ type: "environment-status", environmentId: "local", state: "reconnecting" });
  const [line] = lines();
  expect(line?.getAttribute("data-tone")).toBe("warning");
  expect(line?.getAttribute("role")).toBe("status");
  // Under way: nothing to press, and nothing to put away.
  expect(line?.hasAttribute("data-busy")).toBe(true);
  expect(within(line as HTMLElement).queryByRole("button")).toBeNull();
  expect(line?.textContent).toMatch(/Connection lost/);
  underTitleBar(line as HTMLElement);
  await emit({ type: "environment-status", environmentId: "local", state: "connected" });
  expect(lines()).toEqual([]);
});

test("an environment that went away says what is shown, and Connect again asks for it, counted", async () => {
  const { user, emit, named } = await mount();
  await emit({ type: "environment-status", environmentId: "local", state: "closed" });
  const [line] = lines();
  expect(line?.textContent).toMatch(/is not connected\..*Your draft is kept\./);
  // Said once: the box under the page does not say it too.
  expect(screen.queryByText(/keep editing your draft/)).toBeNull();
  underTitleBar(line as HTMLElement);
  await user.click(within(line as HTMLElement).getByRole("button", { name: "Connect again" }));
  expect(named("connect")).toEqual([["connect", "local"]]);
  expect(named("track").filter(([, name]) => name === "session_connect_pressed")).toEqual([
    ["track", "session_connect_pressed", {}],
  ]);
  // While it connects the line says so, with nothing to press.
  await emit({ type: "environment-status", environmentId: "local", state: "connecting" });
  expect(lines()[0]?.textContent).toMatch(/Connecting to .*Your draft is kept\.$/);
  expect(within(lines()[0] as HTMLElement).queryByRole("button")).toBeNull();
});

test("a daemon on another protocol is not offered Connect again: connecting would not change it", async () => {
  const { emit } = await mount();
  await emit({
    type: "environment-status",
    environmentId: "local",
    state: "closed",
    incompatible: { with: "daemon", supported: ["0.2"], requested: "1.0" },
  });
  const away = lines().find((l) => /is not connected/.test(l.textContent ?? ""));
  expect(away).toBeDefined();
  expect(away?.textContent).toMatch(/Your draft is kept\.$/);
  expect(within(away as HTMLElement).queryByRole("button", { name: "Connect again" })).toBeNull();
});

test("a conversation read at its end stays at its end when a line comes under the title bar", async () => {
  // Turns of their own, so no answer folds away into the work before it.
  const updates = Array.from({ length: 12 }, (_, i) => [
    {
      sessionUpdate: "user_message",
      messageId: `u${i}`,
      content: [{ type: "text", text: `Question ${i}` }],
    } as SessionUpdate,
    text(`Line ${i}. `.repeat(30), `a${i}`),
    idle({ stopReason: "end_turn" }),
  ]).flat();
  const { emit } = await mount(undefined, () => ({
    conversation: updates.reduce((c, u) => applyUpdate(c, u), emptyConversation()),
    permissions: [],
    version: updates.length,
  }));
  const log = await screen.findByRole("log", { name: "Conversation" });
  await waitFor(() => expect(log.textContent).toContain("Line 11"));
  // The window's height, as #root has it in the app: the conversation scrolls inside it.
  const root = log.closest('[data-slot="app"]')?.parentElement;
  if (root instanceof HTMLElement) root.style.height = "100%";
  await waitFor(() => expect(log.scrollHeight).toBeGreaterThan(log.clientHeight + 200));
  log.scrollTop = log.scrollHeight;
  const atEnd = () => log.scrollHeight - log.scrollTop - log.clientHeight < 2;
  await waitFor(() => expect(atEnd()).toBe(true));
  await emit({ type: "environment-status", environmentId: "local", state: "reconnecting" });
  await waitFor(() => expect(lines()).toHaveLength(1));
  await waitFor(() => expect(atEnd()).toBe(true));
});

test("with no session open the page says how the connection stands, and no line says it again", async () => {
  const script = fakeBridge({ connected: true });
  const store = new AppStore(script.bridge);
  render(
    <StoreProvider store={store}>
      <App />
    </StoreProvider>,
  );
  await act(() => store.start());
  await act(() =>
    script.emit({ type: "environment-status", environmentId: "local", state: "reconnecting" }),
  );
  await screen.findByText("Connecting to this environment…");
  expect(lines()).toEqual([]);
});

test("a daemon on another protocol is not said to be connecting: that would not end", async () => {
  const { emit } = await mount();
  await emit({
    type: "environment-status",
    environmentId: "local",
    state: "connecting",
    incompatible: { with: "daemon", supported: ["0.2"], requested: "1.0" },
  });
  expect(lines().some((l) => /Connecting to/.test(l.textContent ?? ""))).toBe(false);
  // Still said to be away, with nothing to press.
  const away = lines().find((l) => /is not connected/.test(l.textContent ?? ""));
  expect(away).toBeDefined();
  expect(within(away as HTMLElement).queryByRole("button")).toBeNull();
});

test("why an environment is not connected is said on its line", async () => {
  const { emit } = await mount();
  await emit({
    type: "environment-status",
    environmentId: "local",
    state: "closed",
    error: "ssh: connect to host build-1 port 22: Connection refused",
  });
  expect(lines()[0]?.textContent).toMatch(
    /is not connected: ssh: connect to host build-1.*Connection refused\. Your draft is kept\./,
  );
});
