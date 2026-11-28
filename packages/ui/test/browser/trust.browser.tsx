import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { userEvent } from "vitest/browser";
import { chosenFolder, typeFolder } from "./blank.ts";
import { boxText, press, ready, write } from "./box.ts";
import { mountApp } from "./mount.tsx";

afterEach(cleanup);

/** The app on a daemon that keeps folder trust, with `trusted` as the decision for every folder. */
const mount = async (trusted: boolean | null) => {
  const app = await mountApp(
    { capabilities: { queue: true, files: true, folders: true, trust: true } },
    {
      configure: (script) => {
        const decided = new Map<string, boolean>();
        script.bridge.readTrust = async (_location, path) => {
          script.calls.push(["readTrust", _location, path]);
          const value = decided.get(path) ?? trusted;
          return { path, trusted: value, from: value === null ? null : path };
        };
        script.bridge.setTrust = async (_location, path, value) => {
          script.calls.push(["setTrust", _location, path, value]);
          decided.set(path, value);
          return { path, trusted: value, from: path };
        };
      },
    },
  );
  await screen.findAllByRole("option");
  return app;
};

/** Opens a blank conversation in `path` and sends its first message: what makes the session, and so what asks. */
const startIn = async (user: ReturnType<typeof userEvent.setup>, path: string) => {
  await user.click(await screen.findByRole("button", { name: "New session" }));
  await typeFolder(user, path);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "Fix the build");
  await press(box, "Enter");
  return box;
};
const question = () => screen.findByRole("dialog", { name: "Trust this folder?" });

test("a folder nobody has decided on is asked about before the session starts, and the answer is kept first", async () => {
  const { user, named, calls } = await mount(null);
  await startIn(user, "/srv/app");
  const dialog = await question();
  expect(within(dialog).getByText("/srv/app", { selector: "code" })).toBeTruthy();
  expect(named("createSession")).toHaveLength(0);
  await user.click(within(dialog).getByRole("button", { name: "Trust and start" }));
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
  await waitFor(() => expect(named("prompt")).toHaveLength(1));
  const order = calls
    .map((c) => c[0])
    .filter((n) => n === "setTrust" || n === "createSession" || n === "prompt");
  expect(order).toEqual(["setTrust", "createSession", "prompt"]);
  expect(named("setTrust")[0]).toEqual(["setTrust", "local", "/srv/app", true]);
});

test("the question can be left, and a session can start without trusting the folder", async () => {
  const { user, named } = await mount(null);
  const box = await startIn(user, "/srv/app");
  await user.click(await within(await question()).findByRole("button", { name: "Back" }));
  // Back in the blank conversation, with the folder and the message, and nothing started or decided.
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Trust this folder?" })).toBeNull(),
  );
  expect(await chosenFolder()).toBe("/srv/app");
  expect(boxText(box)).toBe("Fix the build");
  expect(named("setTrust")).toHaveLength(0);
  expect(named("createSession")).toHaveLength(0);
  await press(box, "Enter");
  await user.click(
    await within(await question()).findByRole("button", { name: "Start without trusting" }),
  );
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
  expect(named("setTrust")[0]).toEqual(["setTrust", "local", "/srv/app", false]);
});

test("a folder already decided on is not asked about", async () => {
  const { user, named } = await mount(false);
  await startIn(user, "/srv/app");
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
  expect(named("setTrust")).toHaveLength(0);
  expect(screen.queryByText("Trust this folder?")).toBeNull();
});

test("the workspace menu trusts the shown folder after saying what that allows, and stops trusting it at once", async () => {
  const { user, named } = await mount(null);
  await user.click(screen.getByRole("button", { name: "Workspace actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Trust this folder" }));
  const confirm = await screen.findByRole("alertdialog");
  expect(within(confirm).getByText("Trust this folder?")).toBeTruthy();
  await user.click(within(confirm).getByRole("button", { name: "Trust folder" }));
  await waitFor(() => expect(named("setTrust")).toHaveLength(1));
  expect(named("setTrust")[0]?.[3]).toBe(true);

  await user.click(screen.getByRole("button", { name: "Workspace actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Stop trusting this folder" }));
  await waitFor(() => expect(named("setTrust")).toHaveLength(2));
  expect(named("setTrust")[1]?.[3]).toBe(false);
});

test("an answer that cannot be kept says why, starts nothing, and can be given again", async () => {
  const { user, named, bridge } = await mount(null);
  const working = bridge.setTrust;
  bridge.setTrust = async () => {
    throw new Error("disk full");
  };
  await startIn(user, "/srv/app");
  const dialog = await question();
  await user.click(await within(dialog).findByRole("button", { name: "Trust and start" }));
  expect((await within(dialog).findByRole("alert")).textContent).toContain("disk full");
  expect(named("createSession")).toHaveLength(0);
  bridge.setTrust = working;
  await user.click(within(dialog).getByRole("button", { name: "Trust and start" }));
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
});

test("a folder nobody has decided on is marked before the first message, and one decided on is not", async () => {
  const { user } = await mount(null);
  await user.click(await screen.findByRole("button", { name: "New session" }));
  const mark = await screen.findByText("Not trusted yet");
  // It describes the folder's button, so it is heard with the folder rather than as a stop of its own.
  const folder = await screen.findByRole("button", { name: /^Folder: / });
  expect(folder.getAttribute("aria-describedby")).toBe(mark.id);
  cleanup();
  const decided = await mount(true);
  await decided.user.click(await screen.findByRole("button", { name: "New session" }));
  await screen.findByRole("button", { name: /^Folder: / });
  await waitFor(() => expect(decided.named("readTrust").length).toBeGreaterThan(0));
  expect(screen.queryByText("Not trusted yet")).toBeNull();
});
