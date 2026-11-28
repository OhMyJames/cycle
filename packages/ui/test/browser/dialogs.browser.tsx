import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { AgentInfo } from "../../src/api.ts";
import { ConfirmDialog, FormDialog } from "../../src/react/dialogs.tsx";
import { HarnessDefaultsFields } from "../../src/react/harness-settings.tsx";
import { LocationDialog } from "../../src/react/index.ts";
import { findAlert } from "./alert.ts";

afterEach(cleanup);

const agent: AgentInfo = { id: "a", name: "Alpha", available: true, configSchema: {} };

/** As the Harness page mounts it: asking again starts it over, reading again. */
function Defaults(props: {
  read: (agent: string) => Promise<Record<string, string> | undefined>;
  onSave: (agent: string, config: Record<string, string>) => Promise<boolean | undefined>;
}) {
  const [attempt, setAttempt] = useState(0);
  return (
    <HarnessDefaultsFields
      key={attempt}
      agent={agent}
      read={props.read}
      onSave={props.onSave}
      revision={0}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  );
}

test("a location dialog that is opened again is empty: what was added is not added twice", async () => {
  const user = userEvent.setup();
  const saved: string[] = [];
  const view = (open: boolean) => (
    <LocationDialog open={open} onOpenChange={() => {}} onSave={(e) => void saved.push(e.id)} />
  );
  const { rerender } = render(view(true));
  await user.type(await screen.findByLabelText("Address"), "me@box");
  rerender(view(false));
  rerender(view(true));
  expect(((await screen.findByLabelText("Address")) as HTMLInputElement).value).toBe("");
  expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
});

test("a location is not added twice by a double click", async () => {
  const user = userEvent.setup();
  let calls = 0;
  let finish: () => void = () => {};
  render(
    <LocationDialog
      open
      onOpenChange={() => {}}
      onSave={() => {
        calls++;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      }}
    />,
  );
  await user.type(await screen.findByLabelText("Address"), "me@box");
  const add = screen.getByRole("button", { name: "Add" });
  // Two presses in a row, as a double click lands: the second must not save again.
  await user.dblClick(add);
  expect(calls).toBe(1);
  await act(async () => finish());
});

test("agent defaults can be saved only once they are read, and a save that failed is not said to be saved", async () => {
  const user = userEvent.setup();
  let release: (value: Record<string, string>) => void = () => {};
  const read = () =>
    new Promise<Record<string, string> | undefined>((resolve) => {
      release = resolve;
    });
  const saved: string[] = [];
  render(
    <Defaults
      read={read}
      onSave={async (agent) => {
        saved.push(agent);
        return saved.length > 1;
      }}
    />,
  );
  const save = await screen.findByRole("button", { name: "Save" });
  // Not read yet: what the form holds is not this agent's.
  expect(save.hasAttribute("disabled")).toBe(true);
  await act(async () => release({}));
  expect(save.hasAttribute("disabled")).toBe(false);
  // A save that did not go through is not said to be saved.
  await user.click(save);
  expect(saved).toEqual(["a"]);
  expect(screen.queryByText("Saved")).toBeNull();
  await user.click(save);
  expect(await screen.findByText("Saved")).toBeTruthy();
});

test("agent defaults that cannot be read are not replaced by an empty form: they cannot be saved over", async () => {
  let reads = 0;
  render(
    <Defaults
      read={() => (reads++ === 0 ? Promise.reject(new Error("no")) : Promise.resolve({}))}
      onSave={async () => true}
    />,
  );
  expect(await screen.findByText(/could not be read/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
  // The way on: reading them again.
  await userEvent.setup().click(screen.getByRole("button", { name: "Read settings again" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false),
  );
});

test("location dialog keeps user input on failure, avoids id collisions, and supports editing", async () => {
  const user = userEvent.setup();
  const saved: { id: string; name: string; host: string }[] = [];
  let fail = true;
  render(
    <LocationDialog
      open
      onOpenChange={() => {}}
      existingIds={new Set(["ssh-me-box"])}
      onSave={async (e) => {
        if (fail) return "Disk full";
        saved.push({ id: e.id, name: e.name, host: e.kind === "remote" ? e.transport.host : "" });
        return undefined;
      }}
    />,
  );
  await user.type(await screen.findByLabelText("Address"), "me@box");
  await user.click(screen.getByRole("button", { name: "Add" }));
  expect((await findAlert()).textContent).toContain("Disk full");
  expect(((await screen.findByLabelText("Address")) as HTMLInputElement).value).toBe("me@box");
  fail = false;
  await user.click(screen.getByRole("button", { name: "Add" }));
  expect(saved).toEqual([{ id: "ssh-me-box-2", name: "me@box", host: "me@box" }]);
});

test("destructive confirm dialog uses destructive variant and stays open on failure", async () => {
  const user = userEvent.setup();
  let closed = false;
  render(
    <ConfirmDialog
      open
      onOpenChange={(next) => {
        if (!next) closed = true;
      }}
      title="Remove Build?"
      description="Removes settings."
      confirmLabel="Remove location"
      destructive
      onConfirm={async () => "Still busy"}
    />,
  );
  const button = await screen.findByRole("button", { name: "Remove location" });
  expect(button.getAttribute("data-variant")).toBe("destructive");
  await user.click(button);
  expect((await findAlert()).textContent).toContain("Still busy");
  expect(closed).toBe(false);
});

// What every form dialog of the app does (packages/ui/AGENTS.md), said once here: the pages only say their own fields,
// when they can be sent and what went wrong.

/** A form dialog with one field. */
function TestForm(props: {
  ready: (value: string) => boolean;
  onSubmit: (value: string) => Promise<boolean | Error>;
  onClose: (saved: boolean) => void;
}) {
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  return (
    <FormDialog
      kind="test-form"
      title="New thing"
      ready={props.ready(value)}
      submitLabel="Add thing"
      onSubmit={async () => {
        setProblem(undefined);
        const result = await props.onSubmit(value);
        if (result instanceof Error) throw result;
        if (!result) setProblem("The name is taken.");
        return result;
      }}
      onClose={props.onClose}
      problem={problem}
    >
      <label>
        Name
        <input value={value} onChange={(e) => setValue(e.currentTarget.value)} />
      </label>
    </FormDialog>
  );
}

/** The form, whose save is held until the test lets it go. */
function heldForm(options: { ready?: (value: string) => boolean } = {}) {
  const calls: string[] = [];
  const closed: boolean[] = [];
  let answer: (result: boolean | Error) => void = () => {};
  render(
    <TestForm
      ready={options.ready ?? (() => true)}
      onSubmit={(value) => {
        calls.push(value);
        return new Promise((resolve) => {
          answer = resolve;
        });
      }}
      onClose={(saved) => closed.push(saved)}
    />,
  );
  return { calls, closed, answer: (result: boolean | Error) => act(async () => answer(result)) };
}

test("a form dialog: Enter sends it, and once it went through the dialog closes, saying so", async () => {
  const user = userEvent.setup();
  const form = heldForm();
  await user.type(await screen.findByLabelText("Name"), "alpha{Enter}");
  expect(form.calls).toEqual(["alpha"]);
  await form.answer(true);
  expect(form.closed).toEqual([true]);
});

test("a form dialog: its action is off until what is filled can be sent, and Enter does not send it then", async () => {
  const user = userEvent.setup();
  const form = heldForm({ ready: (value) => value.length >= 3 });
  const add = await screen.findByRole("button", { name: "Add thing" });
  expect(add.hasAttribute("disabled")).toBe(true);
  await user.type(screen.getByLabelText("Name"), "ab{Enter}");
  expect(form.calls).toEqual([]);
  await user.type(screen.getByLabelText("Name"), "c");
  expect(add.hasAttribute("disabled")).toBe(false);
});

test("a form dialog: Cancel is left of the action, and closes it without sending", async () => {
  const user = userEvent.setup();
  const form = heldForm();
  const footer = (await screen.findByRole("button", { name: "Add thing" })).parentElement;
  const buttons = [...(footer?.querySelectorAll("button") ?? [])].map((b) => b.textContent);
  expect(buttons).toEqual(["Cancel", "Add thing"]);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(form.calls).toEqual([]);
  expect(form.closed).toEqual([false]);
});

test("a form dialog: while it is sending it is not sent again, and neither Cancel nor Escape closes it", async () => {
  const user = userEvent.setup();
  const form = heldForm();
  await user.type(await screen.findByLabelText("Name"), "alpha{Enter}");
  const add = screen.getByRole("button", { name: "Add thing" });
  expect(add.hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
  await user.keyboard("{Enter}");
  await user.keyboard("{Escape}");
  expect(form.calls).toEqual(["alpha"]);
  expect(form.closed).toEqual([]);
  expect(screen.getByRole("dialog", { name: "New thing" })).toBeTruthy();
  await form.answer(true);
  expect(form.closed).toEqual([true]);
});

test("a form dialog: a save that did not go through keeps it open with what was filled, saying why", async () => {
  const user = userEvent.setup();
  const form = heldForm();
  await user.type(await screen.findByLabelText("Name"), "alpha{Enter}");
  await form.answer(false);
  expect((await findAlert()).textContent).toBe("The name is taken.");
  expect(form.closed).toEqual([]);
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("alpha");
  // It can be sent again.
  expect(screen.getByRole("button", { name: "Add thing" }).hasAttribute("disabled")).toBe(false);
});

test("a form dialog: what was thrown is said in it, without the app's wrapping, and it stays open", async () => {
  const user = userEvent.setup();
  const form = heldForm();
  await user.type(await screen.findByLabelText("Name"), "alpha{Enter}");
  await form.answer(new Error("Error invoking remote method 'save': Error: disk full"));
  expect((await findAlert()).textContent).toBe("disk full");
  expect(form.closed).toEqual([]);
});

test("a destructive confirmation opens with the focus on Cancel, so a second Enter removes nothing", async () => {
  const user = userEvent.setup();
  let confirmed = 0;
  render(
    <ConfirmDialog
      open
      onOpenChange={() => {}}
      title="Remove Build?"
      description="Removes settings."
      confirmLabel="Remove location"
      destructive
      onConfirm={() => {
        confirmed++;
      }}
    />,
  );
  const cancel = await screen.findByRole("button", { name: "Cancel" });
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  // Cancel is first, the action after it.
  expect(
    [...(cancel.parentElement?.querySelectorAll("button") ?? [])].map((b) => b.textContent),
  ).toEqual(["Cancel", "Remove location"]);
  await user.keyboard("{Enter}");
  expect(confirmed).toBe(0);
});
