import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { SessionSummary } from "../../src/api.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";
import { boxText, press, ready, write } from "./box.ts";
import { renderApp } from "./render-app.tsx";

afterEach(() => {
  cleanup();
  // Text is kept in the page's storage; each test starts with none.
  localStorage.clear();
});

const sessions: SessionSummary[] = [
  { ...summary("s1"), title: "alpha", lastSeq: 2 },
  { ...summary("s2"), title: "beta", lastSeq: 1 },
];

const mount = async () => {
  const script = fakeBridge({ connected: true });
  script.bridge.sessions = async () => sessions;
  script.bridge.agents = async () => [
    {
      id: "fake",
      name: "Fake",
      available: true,
      configSchema: {},
      promptCapabilities: { image: {} },
    },
  ];
  const store = await renderApp(script.bridge);
  const user = userEvent.setup();
  const open = async (title: string) => {
    await user.click(await screen.findByRole("option", { name: new RegExp(title) }));
    const box = await screen.findByRole("textbox", { name: "Message" });
    await ready(box);
    return box;
  };
  return { store, user, open, ...script };
};

const png = (name: string) =>
  new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: "image/png" });
const picker = () => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("no file input");
  return input;
};

test("what is written in one session is there when the person comes back to it, and not in another", async () => {
  const { open } = await mount();
  await write(await open("alpha"), "half a sentence");
  const beta = await open("beta");
  expect(boxText(beta)).toBe("");
  await write(beta, "something else");
  expect(boxText(await open("alpha"))).toBe("half a sentence");
  expect(boxText(await open("beta"))).toBe("something else");
});

test("sending clears the draft of that session only", async () => {
  const { open, named } = await mount();
  await write(await open("alpha"), "to send");
  await write(await open("beta"), "to keep");
  await press(await open("alpha"), "Enter");
  await waitFor(() => expect(named("prompt")).toHaveLength(1));
  expect(boxText(await open("alpha"))).toBe("");
  expect(boxText(await open("beta"))).toBe("to keep");
});

test("the images attached to a session stay with it while another is open", async () => {
  const { user, open } = await mount();
  await open("alpha");
  await user.upload(picker(), png("one.png"));
  expect(await screen.findByRole("button", { name: "Remove one.png" })).toBeTruthy();
  await open("beta");
  expect(screen.queryByRole("button", { name: "Remove one.png" })).toBeNull();
  await open("alpha");
  expect(await screen.findByRole("button", { name: "Remove one.png" })).toBeTruthy();
});

test("an image still being read when the person goes to another session lands in the one it was added to", async () => {
  const { user, open } = await mount();
  await open("alpha");
  // A file that is read when the test says so.
  let finish: (bytes: ArrayBuffer) => void = () => {};
  const slow = png("slow.png");
  Object.defineProperty(slow, "arrayBuffer", {
    value: () =>
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      }),
  });
  await user.upload(picker(), slow);
  await open("beta");
  await act(async () => finish(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer));
  // It is not in the session that is open now...
  expect(screen.queryByRole("button", { name: "Remove slow.png" })).toBeNull();
  // ...but in the one it was added to.
  await open("alpha");
  expect(await screen.findByRole("button", { name: "Remove slow.png" })).toBeTruthy();
});

test("an image still being read when its session is deleted does not bring the draft back", async () => {
  const { store, user, open } = await mount();
  await open("alpha");
  let finish: (bytes: ArrayBuffer) => void = () => {};
  const slow = png("slow.png");
  Object.defineProperty(slow, "arrayBuffer", {
    value: () =>
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      }),
  });
  await user.upload(picker(), slow);
  await act(() => store.deleteSession("s1"));
  await act(async () => finish(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]).buffer));
  expect(store.drafts.get("local:s1").attachments).toEqual([]);
});

test("a message that could not be sent is put back in the box, with the failure shown", async () => {
  const { open, bridge } = await mount();
  bridge.prompt = async () => {
    throw new Error("The daemon is not reachable");
  };
  const box = await open("alpha");
  await write(box, "do not lose me");
  await press(box, "Enter");
  // The failure is shown, and the text is in the box again.
  await screen.findByText(/The daemon is not reachable/);
  await waitFor(() => expect(boxText(box)).toBe("do not lose me"));
});

test("what was written is still there when the app starts again", async () => {
  const first = await mount();
  await write(await first.open("alpha"), "half a sentence");
  cleanup();
  const second = await mount();
  expect(boxText(await second.open("alpha"))).toBe("half a sentence");
});
