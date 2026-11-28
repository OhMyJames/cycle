import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { SessionSummary } from "../../src/api.ts";
import { summary } from "../fake-bridge.ts";
import { mountApp } from "./mount.tsx";

afterEach(cleanup);

const row = (id: string, title: string): SessionSummary => ({ ...summary(id), title });

const mount = async (fail?: string) => {
  const renamed: unknown[][] = [];
  const { user, store } = await mountApp(
    {},
    {
      configure: (script) => {
        script.bridge.sessions = async () => [row("a", "First"), row("b", "Second")];
        script.bridge.renameSession = async (...args) => {
          renamed.push(args);
          if (fail !== undefined) throw new Error(fail);
        };
      },
    },
  );
  await screen.findAllByRole("option");
  return { user, renamed, store };
};

const field = () => screen.findByRole("textbox", { name: "Session name" });
const header = () => document.querySelector('[data-slot="main-header"]') as HTMLElement;

const openFirst = async (user: Awaited<ReturnType<typeof mount>>["user"]) => {
  await user.click(screen.getByRole("option", { name: /First/ }));
  return within(header()).findByRole("button", { name: "First" });
};

test("the header's title is edited where it is: Enter keeps it, and the focus comes back to it", async () => {
  const { user, renamed } = await mount();
  const title = await openFirst(user);
  await user.click(title);
  const input = (await field()) as HTMLInputElement;
  expect(document.activeElement).toBe(input);
  // It starts with the title selected, so typing replaces it.
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe("First".length);
  await user.keyboard("  Renamed  {Enter}");
  expect(renamed).toEqual([["local", "a", "Renamed", "header"]]);
  // The new title shows at once, not the old one until the list catches up.
  const back = await within(header()).findByRole("button", { name: "Renamed" });
  await waitFor(() => expect(document.activeElement).toBe(back));
});

test("Escape, an empty title or the same one ask for nothing and keep the title", async () => {
  const { user, renamed } = await mount();
  await user.click(await openFirst(user));
  await field();
  await user.keyboard("Other{Escape}");
  expect(screen.queryByRole("textbox", { name: "Session name" })).toBeNull();
  await user.click(within(header()).getByRole("button", { name: "First" }));
  await user.clear(await field());
  await user.keyboard("{Enter}");
  await user.click(within(header()).getByRole("button", { name: "First" }));
  await field();
  await user.keyboard("{Enter}");
  expect(renamed).toEqual([]);
  expect(within(header()).getByRole("button", { name: "First" })).toBeTruthy();
});

test("the Enter that confirms an input method's text does not keep the title", async () => {
  const { user, renamed } = await mount();
  await user.click(await openFirst(user));
  const input = await field();
  await user.keyboard("新标题");
  fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
  expect(renamed).toEqual([]);
  expect(screen.getByRole("textbox", { name: "Session name" })).toBe(input);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(renamed).toEqual([["local", "a", "新标题", "header"]]);
});

test("the header's menu renames in place too, and leaving the field keeps what is typed", async () => {
  const { user, renamed } = await mount();
  await openFirst(user);
  await user.click(screen.getByRole("button", { name: "Session actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const input = await field();
  await waitFor(() => expect(document.activeElement).toBe(input));
  await user.keyboard("From the menu");
  await user.click(document.body);
  await waitFor(() => expect(renamed).toEqual([["local", "a", "From the menu", "header"]]));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a rename that fails says why beside the title, which is back as it was", async () => {
  const { user } = await mount("Session locked");
  await user.click(await openFirst(user));
  await field();
  await user.keyboard("Nope{Enter}");
  const alert = await within(header()).findByRole("alert");
  expect(alert.textContent).toContain("Session locked");
  expect(within(header()).getByRole("button", { name: "First" })).toBeTruthy();
});

test("a row of the sidebar is renamed in place by a double click or F2", async () => {
  const { user, renamed } = await mount();
  const second = screen.getByRole("option", { name: /Second/ });
  await user.dblClick(second);
  const input = await field();
  expect(second.contains(input)).toBe(true);
  // Its keys are the field's: the list does not walk or search on them.
  await user.keyboard("{Home}Two {ArrowDown}{Enter}");
  expect(renamed).toEqual([["local", "b", "Two Second", "sidebar"]]);
  const renamedRow = await screen.findByRole("option", { name: /Two Second/ });
  await waitFor(() => expect(document.activeElement).toBe(renamedRow));
  await user.keyboard("{F2}");
  await field();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("textbox", { name: "Session name" })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(renamedRow));
  expect(renamed).toHaveLength(1);
});

test("a row whose rename fails says why under its title", async () => {
  const { user } = await mount("Session locked");
  const second = screen.getByRole("option", { name: /Second/ });
  await user.dblClick(second);
  await field();
  await user.keyboard("Nope{Enter}");
  const alert = await within(second).findByRole("alert");
  expect(alert.textContent).toContain("Session locked");
  expect(second.textContent).toContain("Second");
});
