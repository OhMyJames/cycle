import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import type { ProviderInfo, ProviderModel } from "../../src/api.ts";
import { fakeBridge } from "../fake-bridge.ts";
import { openSettings } from "./account-menu.ts";
import { renderApp } from "./render-app.tsx";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const model = (id: string, name = id): ProviderModel => ({
  id,
  name,
  reasoning: true,
  images: false,
  contextWindow: 200_000,
  maxTokens: 16_384,
});

const mine: ProviderInfo = {
  id: "lab",
  name: "Lab",
  kind: "custom",
  api: "openai-completions",
  baseUrl: "https://llm.lab.example/v1",
  hasKey: true,
  models: [model("tiny")],
};

const mount = async (providers: ProviderInfo[] = []) => {
  const script = fakeBridge({
    connected: true,
    providers: {
      list: providers,
      kinds: [{ id: "openrouter", name: "OpenRouter" }],
      catalog: { openrouter: [model("acme/fast", "Fast"), model("acme/deep", "Deep")] },
    },
  });
  const store = await renderApp(script.bridge);
  const user = userEvent.setup();
  await openSettings(user);
  await user.click(await screen.findByRole("tab", { name: "Codex" }));
  const group = (await screen.findByRole("heading", { name: "Model providers" })).closest(
    '[data-slot="page-group"]',
  ) as HTMLElement;
  return { user, store, group: within(group), ...script };
};

test("a provider is listed by name, kind, models and whether a key is saved, never by the key", async () => {
  const { group } = await mount([mine]);
  const row = (await group.findByText("Lab")).closest('[data-slot="page-row"]') as HTMLElement;
  expect(within(row).getByText("Custom endpoint")).toBeTruthy();
  expect(within(row).getByText("1 model")).toBeTruthy();
  expect(within(row).getByText("Key saved")).toBeTruthy();
  expect(within(row).getByText("https://llm.lab.example/v1")).toBeTruthy();
});

test("with none, the group says so and the way to add one is there once", async () => {
  const { group } = await mount();
  expect(await group.findByText("No providers yet.")).toBeTruthy();
  expect(group.getAllByRole("button", { name: "Add provider" })).toHaveLength(1);
});

test("a known service: its models are ticked from the list, the key goes once, and the form submits on Enter", async () => {
  const { user, group, calls } = await mount();
  await user.click(await group.findByRole("button", { name: "Add provider" }));
  const form = within(await screen.findByRole("dialog", { name: "Add a provider" }));
  // The first field has the focus.
  expect(document.activeElement).toBe(form.getByRole("combobox", { name: "Service" }));
  // The native box is hidden under its mark: the label is what a pointer presses.
  await user.click(await form.findByText("Fast"));
  expect((form.getByRole("checkbox", { name: /Fast/ }) as HTMLInputElement).checked).toBe(true);
  expect((form.getByRole("button", { name: "Add provider" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  const key = form.getByLabelText("API key") as HTMLInputElement;
  expect(key.type).toBe("password");
  await user.click(key);
  await user.keyboard("sk-secret{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const saved = calls.find(([name]) => name === "saveProvider");
  expect(saved?.[2]).toMatchObject({
    kind: "openrouter",
    api: null,
    baseUrl: null,
    apiKey: "sk-secret",
    models: [{ id: "acme/fast" }],
  });
  expect(await group.findByText("Key saved")).toBeTruthy();
  expect(document.body.textContent).not.toContain("sk-secret");
});

test("editing never shows the key; a new address says the key must be entered again; Cancel is left of the primary action", async () => {
  const { user, group } = await mount([mine]);
  await user.click(await group.findByRole("button", { name: "Actions for Lab" }));
  await user.click(await screen.findByRole("menuitem", { name: "Edit" }));
  const form = within(await screen.findByRole("dialog", { name: "Edit Lab" }));
  expect(form.getByText("Key saved")).toBeTruthy();
  expect(form.queryByLabelText("API key")).toBeNull();
  const footer = screen
    .getByRole("dialog", { name: "Edit Lab" })
    .querySelector("[data-dialog-footer]");
  expect([...(footer?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
    "Cancel",
    "Save provider",
  ]);
  expect(form.queryByText(/stays with the address/)).toBeNull();
  const address = form.getByLabelText("Address");
  await user.clear(address);
  await user.type(address, "https://other.example/v1");
  expect(await form.findByText(/stays with the address it was saved for/)).toBeTruthy();
  await user.click(form.getByRole("button", { name: "Replace key" }));
  const key = form.getByLabelText("API key") as HTMLInputElement;
  expect(key.value).toBe("");
});

test("a custom endpoint is described by hand: protocol, address, a row for each model", async () => {
  const { user, group, calls } = await mount();
  await user.click(await group.findByRole("button", { name: "Add provider" }));
  const form = within(await screen.findByRole("dialog", { name: "Add a provider" }));
  await user.click(form.getByRole("combobox", { name: "Service" }));
  await user.click(await screen.findByRole("option", { name: "Custom endpoint" }));
  await user.type(await form.findByLabelText("Address"), "https://llm.example/v1");
  await user.type(form.getByLabelText("Model id"), "tiny");
  await user.click(form.getByText("Images"));
  await user.click(form.getByRole("button", { name: "Add provider" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(calls.find(([name]) => name === "saveProvider")?.[2]).toMatchObject({
    kind: "custom",
    api: "openai-completions",
    baseUrl: "https://llm.example/v1",
    models: [{ id: "tiny", name: "tiny", images: true, contextWindow: 128000 }],
  });
});

test("removing asks first, with the focus on Cancel, and a second Enter removes nothing", async () => {
  const { user, group, calls } = await mount([mine]);
  await user.click(await group.findByRole("button", { name: "Actions for Lab" }));
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Remove Lab?" });
  await waitFor(() =>
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })),
  );
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(calls.some(([name]) => name === "removeProvider")).toBe(false);

  await user.click(await group.findByRole("button", { name: "Actions for Lab" }));
  await user.click(await screen.findByRole("menuitem", { name: "Remove" }));
  await user.click(await screen.findByRole("button", { name: "Remove provider" }));
  await waitFor(() => expect(calls.some(([name]) => name === "removeProvider")).toBe(true));
  expect(await group.findByText("No providers yet.")).toBeTruthy();
});

test("the model menu of a new session heads the owner's models with their provider, the agent's own first", async () => {
  const script = fakeBridge({ connected: true });
  const choice = (id: string, provider: { id: string; name: string }) => ({
    const: `${provider.id}/${id}`,
    title: id,
    description: provider.name,
    _meta: { "cycle/efforts": ["low", "high"], "cycle/provider": provider },
  });
  script.bridge.agents = async () => [
    {
      id: "codex",
      name: "Codex",
      available: true,
      promptCapabilities: {},
      configSchema: {
        type: "object",
        properties: {
          model: {
            type: "string",
            title: "Model",
            default: "gpt-5",
            oneOf: [
              { const: "gpt-5", title: "GPT-5" },
              choice("small", { id: "lab", name: "Lab" }),
              choice("big", { id: "lab", name: "Lab" }),
              choice("router", { id: "or", name: "OpenRouter" }),
            ],
          },
        },
      },
    },
  ];
  await renderApp(script.bridge);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "New session" }));
  await screen.findByRole("heading", { name: "New session" });
  await user.click(await screen.findByRole("button", { name: /^Model: / }));
  const menu = within(await screen.findByRole("menu", { name: "Model" }));
  expect(menu.getAllByRole("menuitemradio").map((o) => o.textContent)).toEqual([
    "GPT-5",
    "small",
    "big",
    "router",
  ]);
  // One heading for each provider, none for the agent's own, which come first.
  const headings = [...document.querySelectorAll('[data-slot="menu-group-label"]')].map(
    (h) => h.textContent,
  );
  expect(headings).toEqual(["Model", "Lab", "OpenRouter"]);
  expect(menu.getByRole("group", { name: "Lab" })).toBeTruthy();
});
