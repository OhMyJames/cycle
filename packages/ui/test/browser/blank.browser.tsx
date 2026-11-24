// The blank page of a new session (CYCL-55): where it runs in one line above the box, the folders it already has
// sessions in, and one state with one way on when something stands between it and its first message.
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { App, StoreProvider } from "../../src/react/index.ts";
import { AppStore } from "../../src/store/index.ts";
import { fakeBridge, summary } from "../fake-bridge.ts";
import { chosenFolder, openFolders } from "./blank.ts";
import { boxText, press, ready, write } from "./box.ts";

afterEach(cleanup);

const mount = async (configure?: (script: ReturnType<typeof fakeBridge>) => void) => {
  const script = fakeBridge({ connected: true });
  // Two folders with sessions on this computer: /work (newest) and /srv/api.
  script.bridge.sessions = async (environmentId: string) => [
    summary("s1", environmentId),
    { ...summary("s3", environmentId), cwd: "/srv/api", updatedAt: "2019-12-01T00:00:00.000Z" },
  ];
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
  return { store, user, ...script, emit };
};

const png = (name: string) =>
  new File([Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])], name, { type: "image/png" });
const picker = () => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("no file input");
  return input;
};

const newSession = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("button", { name: "New session" }));
  await screen.findByRole("heading", { name: "New session" });
};

test("the folder's menu offers the folders with sessions, and the one chosen is where the session starts", async () => {
  const { user, named } = await mount();
  await newSession(user);
  expect(await chosenFolder()).toBe("/work");
  const menu = await openFolders(user);
  // Newest first, each named by its last part with its path under it; the one chosen is marked.
  const items = within(menu).getAllByRole("menuitem");
  expect(items.map((item) => item.textContent)).toEqual([
    "work/work",
    "api/srv/api",
    "Browse…",
    "Enter a path…",
  ]);
  await user.click(within(menu).getByRole("menuitem", { name: /^api/ }));
  expect(await chosenFolder()).toBe("/srv/api");
  await waitFor(() =>
    expect(document.activeElement?.closest('[data-slot="composer"]')).not.toBeNull(),
  );
  expect(named("track")).toContainEqual(["track", "blank_folder_chosen", { via: "recent" }]);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "Fix the build");
  await press(box, "Enter");
  await waitFor(() => expect(named("createSession")).toHaveLength(1));
  expect(named("createSession")[0]?.[2]).toMatchObject({ cwd: "/srv/api" });
  // How long the page was open is reported in a word; nothing of what was written or where.
  const sent = named("track").find((call) => call[1] === "blank_sent");
  expect(sent).toEqual(["track", "blank_sent", { waited: "under_10s" }]);
  expect(JSON.stringify(named("track"))).not.toContain("/srv/api");
  expect(JSON.stringify(named("track"))).not.toContain("Fix the build");
});

test("a path typed is used with Enter, and is reported only as typed", async () => {
  const { user, named } = await mount();
  await newSession(user);
  const menu = await openFolders(user);
  await user.click(within(menu).getByRole("menuitem", { name: "Enter a path…" }));
  const dialog = await screen.findByRole("dialog", { name: "Enter a folder path" });
  const field = within(dialog).getByRole("textbox", { name: "Folder" });
  // The field has the focus, with the folder there is to start from.
  await waitFor(() => expect(document.activeElement).toBe(field));
  expect((field as HTMLInputElement).value).toBe("/work");
  await user.clear(field);
  await user.type(field, "/srv/new{Enter}");
  expect(await chosenFolder()).toBe("/srv/new");
  // With the folder settled, the focus is in the box, to write the message.
  await waitFor(() =>
    expect(document.activeElement?.closest('[data-slot="composer"]')).not.toBeNull(),
  );
  expect(named("track")).toContainEqual(["track", "blank_folder_chosen", { via: "typed" }]);
});

test("the page has no menu of its own: the settings are the box's chips", async () => {
  const { user } = await mount();
  await newSession(user);
  expect(screen.queryByRole("button", { name: "Settings for the new session" })).toBeNull();
  expect(screen.queryByText("The session starts when you send the first message.")).toBeNull();
});

test("the agent is chosen first, by its logo and name, as a chip like the others, on the page's one left edge (CYCL-220)", async () => {
  const configSchema = {
    type: "object",
    properties: {
      mode: { type: "string", title: "Mode", oneOf: [{ const: "auto", title: "Auto" }] },
    },
  };
  const { user } = await mount((script) => {
    script.bridge.agents = async () => [
      { id: "claude", name: "Claude", available: true, promptCapabilities: {}, configSchema },
      { id: "codex", name: "Codex", available: true, promptCapabilities: {}, configSchema },
    ];
  });
  await newSession(user);
  const agentChip = await screen.findByRole("button", { name: "Agent: Claude" });
  const where = screen.getByRole("group", { name: "Where the session runs" });
  // First in the line, before where it runs.
  expect(where.querySelector("button")).toBe(agentChip);
  expect(agentChip.querySelector('[data-slot="agent-logo"]')).not.toBeNull();
  // The same chip as the folder's and the box's: no edge, the same size and colour.
  const folder = await screen.findByRole("button", { name: /^(Folder: |Choose a folder)/ });
  const mode = await screen.findByRole("button", { name: /^Mode: / });
  const look = (el: Element) => {
    const s = getComputedStyle(el);
    return [s.fontSize, s.fontWeight, s.color, s.height, s.borderTopColor, s.backgroundColor];
  };
  expect(look(agentChip)).toEqual(look(folder));
  expect(look(agentChip)).toEqual(look(mode));
  expect(getComputedStyle(agentChip).borderTopColor).toBe("rgba(0, 0, 0, 0)");

  await user.click(agentChip);
  await user.click(await screen.findByRole("menuitemradio", { name: "Codex" }));
  const chosen = await screen.findByRole("button", { name: "Agent: Codex" });
  expect(chosen.textContent).toBe("Codex");

  // One left edge: the box's outer border. The heading's words, the chips' contents and the bar's start on it.
  const hero = screen.getByRole("heading", { name: "What should we work on?" });
  const box = document.querySelector('[data-slot="composer-box"]');
  if (box === null) throw new Error("no box");
  const edge = box.getBoundingClientRect().left;
  // Where an element's content starts: inside its border and padding.
  const start = (el: Element) => {
    const s = getComputedStyle(el);
    return (
      el.getBoundingClientRect().left +
      Number.parseFloat(s.borderLeftWidth) +
      Number.parseFloat(s.paddingLeft)
    );
  };
  expect(start(hero)).toBeCloseTo(edge, 0);
  expect(start(chosen)).toBeCloseTo(edge, 0);
  // The bar is drawn again for the agent now chosen.
  const bar = await screen.findByRole("button", { name: /^Mode: / });
  expect(start(bar)).toBeCloseTo(edge, 0);
  // The page's heading, larger than the title bar's.
  const title = screen.getByRole("heading", { name: "New session" });
  expect(Number.parseFloat(getComputedStyle(hero).fontSize)).toBeGreaterThan(
    Number.parseFloat(getComputedStyle(title).fontSize),
  );
});

test("an environment that drops says so with a way back, and the draft and its images stay", async () => {
  const { user, named, emit } = await mount((script) => {
    script.bridge.agents = async () => [
      {
        id: "fake",
        name: "Fake",
        available: true,
        promptCapabilities: { image: {} },
        configSchema: {},
      },
    ];
  });
  await newSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "keep this");
  await user.upload(picker(), png("shot.png"));
  expect(await screen.findByRole("button", { name: "Remove shot.png" })).toBeTruthy();
  await emit({
    type: "environment-status",
    environmentId: "local",
    state: "closed",
    error: "connection refused",
  });
  expect(await screen.findByText("Not connected to This computer.")).toBeTruthy();
  // The draft can still be written: said here, once, and not by the box.
  expect(screen.getAllByText("You can keep editing your draft.")).toHaveLength(1);
  expect(screen.getAllByText("connection refused").length).toBeGreaterThan(0);
  // The page's own way back, beside what it says (the sidebar has one too).
  const stage = document.querySelector<HTMLElement>('[data-slot="blank-stage"]');
  if (stage === null) throw new Error("no blank page");
  await user.click(within(stage).getByRole("button", { name: "Connect again" }));
  expect(named("connect")).toHaveLength(1);
  expect(named("track")).toContainEqual(["track", "blank_connect_pressed", {}]);
  await emit({
    type: "environment-status",
    environmentId: "local",
    state: "connected",
    capabilities: { queue: true, files: true, folders: true },
  });
  await waitFor(() => expect(screen.queryByText("Not connected to This computer.")).toBeNull());
  expect(boxText(box)).toBe("keep this");
  expect(screen.getByRole("button", { name: "Remove shot.png" })).toBeTruthy();
  expect(await chosenFolder()).toBe("/work");
  // And it goes as it was written, with its image.
  await press(box, "Enter");
  await waitFor(() => expect(named("prompt")).toHaveLength(1));
  const sent = named("prompt")[0]?.[3] as { type: string }[];
  expect(sent.map((block) => block.type)).toEqual(["text", "image"]);
});

test("with no agent the page says why once, and the box takes nothing", async () => {
  let asked = 0;
  const { user } = await mount((script) => {
    script.bridge.agents = async () => {
      asked += 1;
      return [];
    };
  });
  await newSession(user);
  expect(await screen.findByText("No agent is available on This computer.")).toBeTruthy();
  // One reason, not a second one under it about the folder.
  expect(screen.queryByText("Choose a folder for the agent to work in.")).toBeNull();
  const box = await screen.findByRole("textbox", { name: "Message" });
  expect(box.getAttribute("contenteditable")).toBe("false");
  const before = asked;
  await user.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(asked).toBeGreaterThan(before));
});

test("a page opened in a folder starts with the box focused; one with no folder, with the folder", async () => {
  const { user } = await mount();
  await newSession(user);
  await waitFor(() =>
    expect(document.activeElement?.closest('[data-slot="composer"]')).not.toBeNull(),
  );
  cleanup();
  const again = await mount((script) => {
    script.bridge.sessions = async () => [];
  });
  await newSession(again.user);
  const folder = await screen.findByRole("button", { name: /^Choose a folder/ });
  await waitFor(() => expect(document.activeElement).toBe(folder));
});

test("a failed start sent again is reported as sent once, when its session is made", async () => {
  const { user, named, bridge } = await mount();
  let refuse = true;
  const create = bridge.createSession;
  bridge.createSession = async (...args) => {
    if (refuse) throw new Error("No such folder");
    return create(...args);
  };
  await newSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "hi");
  await press(box, "Enter");
  expect(await screen.findByText("No such folder")).toBeTruthy();
  expect(named("track").filter((call) => call[1] === "blank_sent")).toHaveLength(0);
  refuse = false;
  await waitFor(() => expect(boxText(box)).toBe("hi"));
  await press(box, "Enter");
  await waitFor(() => expect(named("prompt")).toHaveLength(1));
  expect(named("track").filter((call) => call[1] === "blank_sent")).toHaveLength(1);
});

test("the folders offered are this environment's with sessions that are not archived", async () => {
  const { user } = await mount((script) => {
    script.bridge.sessions = async (environmentId: string) => [
      summary("s1", environmentId),
      { ...summary("s4", environmentId), cwd: "/old", archived: true },
    ];
  });
  await newSession(user);
  const menu = await openFolders(user);
  expect(within(menu).queryByRole("menuitem", { name: /^old/ })).toBeNull();
  expect(within(menu).getByRole("menuitem", { name: /^work/ })).toBeTruthy();
});

test("a -32000 auth error keeps the draft, shows cycle login command, and tracks copy (CYCL-172)", async () => {
  const copied: string[] = [];
  const { user, named, bridge } = await mount((script) => {
    script.bridge.agents = async () => [
      {
        id: "agy",
        name: "Antigravity",
        available: true,
        promptCapabilities: {},
        configSchema: {},
      },
    ];
    script.bridge.copyText = async (text: string) => {
      copied.push(text);
      return true;
    };
  });
  bridge.createSession = async () => {
    throw Object.assign(
      new Error("Authentication required. Run `cycle login agy` on the daemon's machine. (-32000)"),
      { code: -32000 },
    );
  };
  await newSession(user);
  const box = await screen.findByRole("textbox", { name: "Message" });
  await ready(box);
  await write(box, "secret draft for agy");
  await press(box, "Enter");
  expect(await screen.findByText("Antigravity is not signed in on This computer.")).toBeTruthy();
  expect(screen.getByText("cycle login agy")).toBeTruthy();
  await waitFor(() => expect(boxText(box)).toBe("secret draft for agy"));
  await user.click(screen.getByRole("button", { name: "Copy command" }));
  await waitFor(() => expect(copied).toEqual(["cycle login agy"]));
  expect(named("track")).toContainEqual([
    "track",
    "agent_setup_command_copied",
    { agent: "agy", kind: "login" },
  ]);
  expect(JSON.stringify(named("track"))).not.toContain("secret draft for agy");
  expect(JSON.stringify(named("track"))).not.toContain("cycle login agy");
});

test("selecting an unavailable agy agent disables sending and shows the install command (CYCL-172)", async () => {
  let asked = 0;
  const { user } = await mount((script) => {
    script.bridge.agents = async () => {
      asked += 1;
      return [
        {
          id: "claude",
          name: "Claude Code",
          available: true,
          promptCapabilities: {},
          configSchema: {},
        },
        {
          id: "agy",
          name: "Antigravity",
          available: false,
          promptCapabilities: {},
          configSchema: {},
        },
      ];
    };
  });
  await newSession(user);
  await user.click(await screen.findByRole("button", { name: "Agent: Claude Code" }));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Antigravity (not installed)" }),
  );
  // The chip says what is chosen, with what stands in its way.
  expect(
    await screen.findByRole("button", { name: "Agent: Antigravity (not installed)" }),
  ).toBeTruthy();
  expect(await screen.findByText("Antigravity is not available on This computer.")).toBeTruthy();
  expect(
    screen.getByText("curl -fsSL https://antigravity.google/cli/install.sh | bash"),
  ).toBeTruthy();
  const box = await screen.findByRole("textbox", { name: "Message" });
  expect(box.getAttribute("contenteditable")).toBe("false");
  const before = asked;
  await user.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(asked).toBeGreaterThan(before));
});
