import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { StorageAgent, StorageCleanAnswer } from "../../src/api.ts";
import { fakeBridge } from "../fake-bridge.ts";
import { openSettings } from "./account-menu.ts";
import { renderApp } from "./render-app.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const claude = (over: Partial<StorageAgent> = {}): StorageAgent => ({
  agent: "claude",
  name: "Claude",
  managed: true,
  items: [
    { id: "bun-cache", kind: "cache", bytes: 1_800_000_000 },
    { id: "npm-cache", kind: "cache", bytes: 100_000_000 },
    { id: "projects", kind: "history", bytes: 518_000_000 },
  ],
  ...over,
});

const mount = async (
  storage: { agents: StorageAgent[]; cleanAnswer?: StorageCleanAnswer },
  capable = true,
) => {
  const script = fakeBridge({
    connected: true,
    capabilities: { queue: true, files: true, folders: true, agentSetup: true, storage: capable },
    storage,
  });
  script.bridge.agents = async () => [
    { id: "claude", name: "Claude", available: true, configSchema: {} },
  ];
  await renderApp(script.bridge);
  const user = userEvent.setup();
  await openSettings(user);
  await user.click(await screen.findByRole("tab", { name: "Claude" }));
  return { user, ...script };
};

const storageGroup = async () =>
  within(
    (await screen.findByRole("heading", { name: "Storage" })).closest(
      '[data-slot="page-group"]',
    ) as HTMLElement,
  );

test("the Storage group shows caches and session records, and clearing asks first, then says what it freed", async () => {
  const { user, named } = await mount({
    agents: [claude()],
    cleanAnswer: { cleaned: true, freedBytes: 1_900_000_000 },
  });
  const group = await storageGroup();
  expect(await group.findByText("1.9 GB")).toBeTruthy();
  expect(group.getByText("518 MB")).toBeTruthy();
  // The records are only shown: one button, for the caches.
  expect(group.getAllByRole("button")).toHaveLength(1);

  await user.click(group.getByRole("button", { name: "Clear caches" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Clear the caches of Claude?" });
  expect(within(dialog).getByText(/Logins and session records stay/)).toBeTruthy();
  expect(named("cleanStorage")).toEqual([]);
  await user.click(within(dialog).getByRole("button", { name: "Clear caches" }));
  await waitFor(() => expect(named("cleanStorage")).toEqual([["cleanStorage", "local", "claude"]]));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(await group.findByText("Cleared 1.9 GB.")).toBeTruthy();
  // Nothing left to clear.
  expect((group.getByRole("button", { name: "Clear caches" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

test("a refusal is said in the dialog, which stays open for another try", async () => {
  const { user } = await mount({
    agents: [claude()],
    cleanAnswer: { cleaned: false, problem: "busy", message: "x" },
  });
  const group = await storageGroup();
  await user.click(await group.findByRole("button", { name: "Clear caches" }));
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Clear caches" }));
  expect(
    await within(dialog).findByText(
      "A session of Claude is working. Clear caches when it has finished.",
    ),
  ).toBeTruthy();
});

test("an agent whose home is the owner's own folder is not measured and has no button", async () => {
  await mount({ agents: [claude({ managed: false, items: [] })] });
  const group = await storageGroup();
  expect(await group.findByText("Its home is a folder of your own.")).toBeTruthy();
  expect(group.queryByRole("button")).toBeNull();
});

test("an agent that has stored nothing yet says so", async () => {
  await mount({ agents: [claude({ items: [] })] });
  expect(await (await storageGroup()).findByText("Nothing stored yet.")).toBeTruthy();
});

test("a daemon without the capability shows no Storage group and is not asked", async () => {
  const { named } = await mount({ agents: [claude()] }, false);
  await screen.findByText("Runtime");
  expect(screen.queryByRole("heading", { name: "Storage" })).toBeNull();
  expect(named("readStorage")).toEqual([]);
});
