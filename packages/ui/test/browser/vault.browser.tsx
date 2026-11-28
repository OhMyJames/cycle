import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { fakeBridge } from "../fake-bridge.ts";
import { openSettings } from "./account-menu.ts";
import { renderApp } from "./render-app.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const mount = async (keys: string[] = []) => {
  const script = fakeBridge({
    connected: true,
    vault: { keys },
    environments: {
      environments: [
        {
          id: "work",
          name: "Work",
          variables: [],
          secrets: [{ name: "GH_TOKEN", from: "WORK_GH" }],
          actions: [],
        },
      ],
      defaults: {},
    },
  });
  await renderApp(script.bridge);
  const user = userEvent.setup();
  await openSettings(user);
  await user.click(await screen.findByRole("tab", { name: "Vault" }));
  const group = (await screen.findByText(/Secrets kept on/)).closest(
    '[data-slot="page-group"]',
  ) as HTMLElement;
  return { user, group: within(group), ...script };
};

test("an item is listed by name and the environments that use it, never by a value", async () => {
  const { group } = await mount(["WORK_GH", "SPARE"]);
  const used = (await group.findByText("WORK_GH")).closest('[data-slot="page-row"]') as HTMLElement;
  expect(within(used).getByText("Used by Work")).toBeTruthy();
  const spare = group.getByText("SPARE").closest('[data-slot="page-row"]') as HTMLElement;
  expect(within(spare).getByText("Not used by any environment")).toBeTruthy();
});

test("with none, the page says so and the way to add one is there once", async () => {
  const { group } = await mount();
  expect(await group.findByText("The vault is empty.")).toBeTruthy();
  expect(group.getAllByRole("button", { name: "New item" })).toHaveLength(1);
});

test("a new item: the name has the focus, the value is a password field, Enter saves, and the value is not shown after", async () => {
  const { user, group, calls } = await mount();
  await user.click(await group.findByRole("button", { name: "New item" }));
  const form = within(await screen.findByRole("dialog", { name: "New vault item" }));
  const name = form.getByLabelText("Name") as HTMLInputElement;
  expect(document.activeElement).toBe(name);
  const value = form.getByLabelText("Value") as HTMLInputElement;
  expect(value.type).toBe("password");
  expect((form.getByRole("button", { name: "Add item" }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(name, "PERSONAL_GH");
  await user.type(value, "ghp_secret-value{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls.find(([n]) => n === "setVaultItem")?.slice(1)).toEqual([
    "local",
    "PERSONAL_GH",
    "ghp_secret-value",
  ]);
  expect(await group.findByText("PERSONAL_GH")).toBeTruthy();
  expect(document.body.textContent).not.toContain("ghp_secret-value");
});

test("the details show dots for the value; Edit asks for a new value, and Remove asks first", async () => {
  const { user, group, calls } = await mount(["WORK_GH"]);
  await user.click(await group.findByRole("button", { name: "Open WORK_GH" }));
  const detail = within(await screen.findByRole("dialog", { name: "WORK_GH" }));
  expect(detail.getByRole("img", { name: "Hidden" })).toBeTruthy();
  expect(detail.getByText("Work")).toBeTruthy();

  await user.click(detail.getByRole("button", { name: "Edit" }));
  const form = within(await screen.findByRole("dialog", { name: "Edit WORK_GH" }));
  // The name is said, not a field to change.
  expect(form.queryByLabelText("Name")).toBeNull();
  expect(form.getByText("WORK_GH")).toBeTruthy();
  // The value is what has the focus, and it starts empty: the saved one is never read back.
  expect(document.activeElement).toBe(form.getByLabelText("Value"));
  expect((form.getByLabelText("Value") as HTMLInputElement).value).toBe("");
  await user.click(form.getByRole("button", { name: "Cancel" }));

  await user.click(await group.findByRole("button", { name: "Open WORK_GH" }));
  await user.click(await screen.findByRole("button", { name: "Remove" }));
  const confirm = await screen.findByRole("alertdialog", { name: "Remove WORK_GH?" });
  await user.click(within(confirm).getByRole("button", { name: "Remove item" }));
  await waitFor(() => expect(calls.some(([n]) => n === "removeVaultItem")).toBe(true));
  expect(await group.findByText("The vault is empty.")).toBeTruthy();
});
