// What every group of what a location keeps says (the vault, providers, connectors, plugins), said once here: the pages
// only say their words and their rows.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { ResourceGroup } from "../../src/react/page-layout.tsx";
import { findAlert } from "./alert.ts";

afterEach(cleanup);

const says = {
  loading: "Reading the things…",
  unreadable: "The things could not be read.",
  retry: "Try again",
  empty: "No things yet.",
  emptyBody: "Add one to use it.",
};

function group(props: {
  items: readonly string[] | undefined;
  error?: string;
  status?: string;
  onAdd?: () => void;
  onRetry?: () => void;
}) {
  const view = render(
    <ResourceGroup
      lead="Things kept on Local."
      items={props.items}
      error={props.error}
      onRetry={props.onRetry ?? (() => {})}
      says={says}
      add={props.onAdd !== undefined ? { label: "Add thing", onAdd: props.onAdd } : undefined}
      status={props.status !== undefined ? <p role="status">{props.status}</p> : undefined}
    >
      {(items) => (
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </ResourceGroup>,
  );
  return within(view.container);
}

test("while it is read, it says so, and there is nothing to add to yet", async () => {
  const shown = group({ items: undefined, onAdd: () => {} });
  expect(shown.getByRole("status").textContent).toContain("Reading the things…");
  expect(shown.queryByRole("button", { name: "Add thing" })).toBeNull();
});

test("with none, it says so, and the way to add one is there once, in what says so", async () => {
  let added = 0;
  const shown = group({ items: [], onAdd: () => added++ });
  expect(shown.getByText("No things yet.")).toBeTruthy();
  expect(shown.getByText("Add one to use it.")).toBeTruthy();
  const add = shown.getAllByRole("button", { name: "Add thing" });
  expect(add).toHaveLength(1);
  await userEvent.setup().click(add[0] as HTMLElement);
  expect(added).toBe(1);
});

test("with some, they are listed, and the way to add one is there once, at the heading", async () => {
  let added = 0;
  const shown = group({ items: ["alpha", "beta"], onAdd: () => added++ });
  expect(shown.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["alpha", "beta"]);
  expect(shown.queryByText("No things yet.")).toBeNull();
  const add = shown.getAllByRole("button", { name: "Add thing" });
  expect(add).toHaveLength(1);
  expect(add[0]?.closest('[data-slot="page-group-head"]')).not.toBeNull();
  await userEvent.setup().click(add[0] as HTMLElement);
  expect(added).toBe(1);
});

test("a group nothing can be added to offers no way to", () => {
  const shown = group({ items: [] });
  expect(shown.getByText("No things yet.")).toBeTruthy();
  expect(shown.queryByRole("button")).toBeNull();
});

test("what could not be read says why in the system's words, with the way to read it again, and is not loading", async () => {
  let retried = 0;
  group({ items: undefined, error: "Not connected", onRetry: () => retried++ });
  const failed = await findAlert();
  expect(within(failed).getByText("The things could not be read.")).toBeTruthy();
  expect(within(failed).getByText("Not connected")).toBeTruthy();
  expect(screen.queryByText("Reading the things…")).toBeNull();
  await userEvent.setup().click(within(failed).getByRole("button", { name: "Try again" }));
  expect(retried).toBe(1);
});

test("what was read before stays under why it could not be read again", async () => {
  const shown = group({ items: ["alpha"], error: "Not connected" });
  expect((await findAlert()).textContent).toContain("Not connected");
  expect(shown.getByText("alpha")).toBeTruthy();
});

test("what is under way is said between why it could not be read and the list", () => {
  const shown = group({ items: ["alpha"], error: "Not connected", status: "Waiting for sign-in" });
  const order = [
    ...(shown.getByText("The things could not be read.").closest("section")?.children ?? []),
  ].map((el) => el.getAttribute("role") ?? el.tagName.toLowerCase());
  expect(order.indexOf("alert")).toBeLessThan(order.indexOf("status"));
  expect(order.indexOf("status")).toBeLessThan(order.indexOf("ul"));
});
