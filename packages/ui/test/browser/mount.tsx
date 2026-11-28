import type { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { act, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import type { AppEvent, PermissionRequest, SessionSnapshot } from "../../src/api.ts";
import { applyUpdate, emptyConversation } from "../../src/model/index.ts";
import { fakeBridge } from "../fake-bridge.ts";
import { ready } from "./box.ts";
import { renderApp } from "./render-app.tsx";

export type FakeOptions = NonNullable<Parameters<typeof fakeBridge>[0]>;
export type Script = ReturnType<typeof fakeBridge>;

/** The app on a connected fake bridge; `configure` changes the bridge before the app starts. */
export const mountApp = async (
  options: FakeOptions = {},
  hooks: { configure?: ((script: Script) => void) | undefined } = {},
) => {
  const script = fakeBridge({ connected: true, ...options });
  hooks.configure?.(script);
  const store = await renderApp(script.bridge);
  const user = userEvent.setup();
  // An event arrives outside React's own calls: say so, or each one warns.
  const emit = (event: AppEvent) => act(() => script.emit(event));
  return { ...script, script, store, user, emit };
};

/** A session's snapshot, made of these updates. */
export const history = (...updates: SessionUpdate[]): SessionSnapshot => ({
  conversation: updates.reduce((c, u) => applyUpdate(c, u), emptyConversation()),
  permissions: [],
  version: updates.length,
});

/**
 * The session `s1`, open, with these updates in it. `click: "act"` presses the row inside `act` where it is found
 * (for a row whose name changes as the session's state arrives); `box` waits for the message box.
 */
export const openSession = async <Box extends boolean = false>(
  updates: SessionUpdate[],
  options: {
    fake?: FakeOptions;
    configure?: (script: Script) => void;
    row?: RegExp;
    click?: "user" | "act";
    box?: Box;
  } = {},
) => {
  const script = fakeBridge({
    connected: true,
    snapshot: () => history(...updates),
    ...options.fake,
  });
  options.configure?.(script);
  const store = await renderApp(script.bridge);
  const user = userEvent.setup();
  const row = await screen.findByRole("option", { name: options.row ?? /work/ });
  if (options.click === "act") await act(() => row.click());
  else await user.click(row);
  const log = await screen.findByRole("log", { name: "Conversation" });
  const found =
    options.box === true ? await screen.findByRole("textbox", { name: "Message" }) : null;
  if (found !== null) await ready(found);
  const box = found as Box extends true ? HTMLElement : undefined;
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
  const tracked = () =>
    script.calls.filter(([name]) => name === "track").map(([, event, props]) => [event, props]);
  return { ...script, script, store, user, log, box, emit, ask, tracked };
};

/** The Loop page on a connected fake bridge. `options` stays live: a test can change what the bridge answers later. */
export const mountLoop = async (
  options: FakeOptions,
  at: "overview" | "board" | "none" = "overview",
  hooks: { configure?: ((script: Script) => void) | undefined } = {},
) => {
  const live = { connected: true, ...options };
  const fake = fakeBridge(live);
  hooks.configure?.(fake);
  const store = await renderApp(fake.bridge);
  const user = userEvent.setup();
  if (at !== "none") await user.click(await screen.findByRole("button", { name: "Loop" }));
  if (at === "board") await user.click(await screen.findByRole("button", { name: "Kanban" }));
  return { user, options: live, store, ...fake };
};
