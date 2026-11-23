import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { userEvent } from "vitest/browser";
import { createTranslator, SOURCE_LOCALE } from "../../src/i18n.ts";
import { enUS } from "../../src/messages/en-US.ts";
import { withEffortFor } from "../../src/react/config-form.tsx";
import { I18nProvider } from "../../src/react/i18n.tsx";
import { formatElapsed, InlineAiStatus } from "../../src/react/inline-ai-status.tsx";
import { SettingChips } from "../../src/react/setting-chips.tsx";

afterEach(cleanup);

const translator = createTranslator(SOURCE_LOCALE, enUS);
const wrap = (ui: React.ReactNode) =>
  render(<I18nProvider translator={translator}>{ui}</I18nProvider>);

describe("InlineAiStatus", () => {
  test("formats elapsed seconds concisely via i18n and clamps negatives", () => {
    expect(formatElapsed(-3, translator.t)).toBe("0s");
    expect(formatElapsed(5, translator.t)).toBe("5s");
    expect(formatElapsed(60, translator.t)).toBe("1m");
    expect(formatElapsed(75, translator.t)).toBe("1m 15s");
  });

  test("renders thinking state with status role and the morph loader; the words do not breathe", () => {
    const { container } = wrap(
      <InlineAiStatus kind="thinking" label="Thinking…" since={Date.now()} />,
    );
    const step = container.querySelector('[data-slot="step"]');
    expect(step?.getAttribute("data-step")).toBe("thinking");
    const status = within(container).getByRole("status");
    const label = status.querySelector('[data-slot="step-label"]');
    expect(label?.textContent).toBe("Thinking…");
    // The brand's loader, not a spinner or a pulsing icon.
    expect(status.querySelector('[data-slot="morph-loader"]')?.getAttribute("data-state")).toBe(
      "thinking",
    );
    expect(status.querySelector('[data-slot="spinner"], [data-slot="step-pulse"]')).toBeNull();
    expect(getComputedStyle(label as Element).animationIterationCount).not.toBe("infinite");
  });

  test("approval waits in its own colour, with the slow loader and no time", () => {
    const { container } = wrap(
      <InlineAiStatus kind="approval" label="Waiting for your answer" since={Date.now() - 5000} />,
    );
    const step = container.querySelector('[data-slot="step"]');
    expect(step?.getAttribute("data-step")).toBe("approval");
    expect(container.querySelector('[data-slot="morph-loader"]')?.getAttribute("data-state")).toBe(
      "waiting",
    );
    expect(container.querySelector('[data-slot="step-elapsed"]')).toBeNull();
  });

  test("quiet, it keeps its height and shows nothing, but a screen reader still hears it", () => {
    const { container } = wrap(
      <InlineAiStatus kind="working" label="Running a command" since={Date.now() - 5000} quiet />,
    );
    const step = container.querySelector('[data-slot="step"]') as HTMLElement;
    expect(step.getBoundingClientRect().height).toBe(28);
    expect(step.querySelector('[data-slot="morph-loader"]')).toBeNull();
    expect(step.querySelector('[data-slot="step-elapsed"]')).toBeNull();
    expect(within(container).getByRole("status").textContent).toBe("Running a command");
  });

  test("shows elapsed time outside the live region after 1s, counted from when the step started", async () => {
    const { container, rerender } = wrap(
      <InlineAiStatus kind="working" label="Working…" since={Date.now()} />,
    );
    // Hidden during the first second.
    expect(container.querySelector('[data-slot="step-elapsed"]')).toBeNull();

    // A step that started earlier (a line drawn again) goes on from where it was.
    rerender(
      <I18nProvider translator={translator}>
        <InlineAiStatus kind="working" label="Working…" since={Date.now() - 2200} />
      </I18nProvider>,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-slot="step-elapsed"]')?.textContent).toBe("2s"),
    );

    // The ticks stay outside role="status", so they do not spam screen readers.
    const status = within(container).getByRole("status");
    const elapsed = container.querySelector('[data-slot="step-elapsed"]');
    expect(status.contains(elapsed)).toBe(false);

    // A new step counts from its own start.
    rerender(
      <I18nProvider translator={translator}>
        <InlineAiStatus kind="working" label="Working…" since={Date.now()} />
      </I18nProvider>,
    );
    expect(container.querySelector('[data-slot="step-elapsed"]')).toBeNull();
  });
});

describe("SettingChips picker", () => {
  const effortSchema = {
    type: "object",
    properties: {
      model: {
        type: "string",
        title: "Model",
        oneOf: [
          { const: "default", title: "Default model" },
          { const: "opus", title: "Opus", _meta: { "cycle/efforts": ["low", "high", "max"] } },
          { const: "haiku", title: "Haiku", _meta: { "cycle/efforts": [] } },
          { const: "odd", title: "Odd" },
        ],
      },
      effort: {
        type: "string",
        title: "Effort",
        oneOf: ["default", "low", "medium", "high", "max"].map((v) => ({ const: v, title: v })),
      },
    },
  };

  const shortSchema = {
    type: "object",
    properties: {
      mode: {
        type: "string",
        title: "Permission mode",
        oneOf: [
          {
            const: "auto",
            title: "Auto",
            description: "Reviews each action.",
            _meta: { "cycle/recommended": true },
          },
          { const: "plan", title: "Plan mode", description: "Changes nothing." },
          {
            const: "bypass",
            title: "Bypass permissions",
            description: "Runs without asking.",
            _meta: { "cycle/danger": true },
          },
        ],
      },
    },
  };

  const longModelSchema = {
    type: "object",
    properties: {
      model: {
        type: "string",
        title: "Model",
        oneOf: [
          { const: "default", title: "Default model" },
          { const: "opus-4", title: "Claude Opus" },
          { const: "sonnet-4", title: "Claude Sonnet" },
          { const: "haiku-4", title: "Claude Haiku" },
          { const: "custom", title: "Custom endpoint" },
        ],
      },
    },
  };

  const twoChipSchema = {
    type: "object",
    properties: {
      ...shortSchema.properties,
      ...longModelSchema.properties,
    },
  };

  // The chips are the SDK's menu (one behaviour with every other menu in the app): these pin what a picker needs of it.
  const frame = () =>
    act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  /** Opened by the pointer the menu itself has the focus and nothing is highlighted until a key moves; by the keyboard
   *  its first item has both. */
  const highlighted = (menu: HTMLElement) => menu.querySelector("[data-highlighted]");

  test("a short menu opens on its first item with the session's choice ticked, arrows move without choosing (danger mode too), Enter and Space commit", async () => {
    const user = userEvent.setup();
    const calls: [string, string][] = [];
    wrap(
      <SettingChips
        settings={{ schema: shortSchema, value: { mode: "auto" } }}
        disabled={false}
        onSet={(k, v) => calls.push([k, v])}
      />,
    );

    const chip = screen.getByRole("button", { name: "Permission mode: Auto" });
    expect(chip.getAttribute("aria-haspopup")).toBe("menu");

    // ArrowDown on the trigger opens the menu on its first item, as every menu does; the tick says what the session has.
    chip.focus();
    await user.keyboard("{ArrowDown}");
    await frame();
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("combobox")).toBeNull();

    const menu = screen.getByRole("menu", { name: "Permission mode" });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items).toHaveLength(3);
    expect(document.activeElement).toBe(items[0] ?? null);

    // ArrowUp wraps to the last item (Bypass permissions) without choosing it.
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(items[2] ?? null);
    expect(calls).toHaveLength(0);

    // Home jumps to first, End jumps to last.
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(items[0] ?? null);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(items[2] ?? null);
    expect(calls).toHaveLength(0);

    // Escape closes without changing the setting and gives the focus back to the chip.
    await user.keyboard("{Escape}");
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(chip);
    expect(calls).toHaveLength(0);

    // Choosing the current choice again with Space closes without asking for anything.
    await user.keyboard("{Enter}");
    await frame();
    expect(document.activeElement?.textContent).toContain("Auto");
    await user.keyboard(" ");
    expect(calls).toHaveLength(0);
    expect(chip.getAttribute("aria-expanded")).toBe("false");

    // Re-open with the pointer: the first arrow lands on the first item, the next on Plan mode, and Enter commits.
    await user.click(chip);
    await frame();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(calls).toEqual([["mode", "plan"]]);
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(chip);
  });

  test("a long model list has no filter: it opens on its first item however it opens, and composing keys are left alone", async () => {
    const user = userEvent.setup();
    const calls: [string, string][] = [];
    wrap(
      <SettingChips
        settings={{ schema: longModelSchema, value: { model: "opus-4" } }}
        disabled={false}
        onSet={(k, v) => calls.push([k, v])}
      />,
    );

    const chip = screen.getByRole("button", { name: "Model: Claude Opus" });
    expect(chip.getAttribute("aria-haspopup")).toBe("menu");
    await user.click(chip);
    await frame();
    const menu = screen.getByRole("menu", { name: "Model" });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items).toHaveLength(5);
    expect(highlighted(menu)).toBeNull();
    expect(within(menu).getByRole("menuitemradio", { checked: true }).textContent).toBe(
      "Claude Opus",
    );

    // Composing (standard, and Safari's keyCode 229) neither commits nor closes.
    const active = document.activeElement as HTMLElement;
    fireEvent.keyDown(active, { key: "Enter", isComposing: true });
    fireEvent.keyDown(active, { key: "Enter", isComposing: false, keyCode: 229 });
    expect(calls).toHaveLength(0);
    expect(chip.getAttribute("aria-expanded")).toBe("true");

    await user.keyboard("{ArrowDown}");
    expect(highlighted(menu)).toBe(items[0] ?? null);
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(calls).toEqual([["model", "sonnet-4"]]);
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(chip);

    // Opened from the keyboard, the list has the focus at once.
    await user.keyboard("{ArrowDown}");
    await frame();
    expect(screen.getByRole("menu", { name: "Model" }).contains(document.activeElement)).toBe(true);
  });

  test("closes on outside click, Tab, switching chips, and becoming disabled", async () => {
    const user = userEvent.setup();
    const { rerender } = wrap(
      <div>
        <button type="button">Outside</button>
        <SettingChips
          settings={{ schema: twoChipSchema, value: { mode: "auto", model: "default" } }}
          disabled={false}
          onSet={() => {}}
        />
      </div>,
    );

    const modeChip = screen.getByRole("button", { name: "Permission mode: Auto" });
    const modelChip = screen.getByRole("button", { name: "Model: Default model" });
    const outside = screen.getByRole("button", { name: "Outside" });

    // Outside click closes popover.
    await user.click(modeChip);
    expect(modeChip.getAttribute("aria-expanded")).toBe("true");
    await user.click(outside);
    expect(modeChip.getAttribute("aria-expanded")).toBe("false");

    // Switching to another chip closes the first.
    await user.click(modeChip);
    expect(modeChip.getAttribute("aria-expanded")).toBe("true");
    await user.click(modelChip);
    expect(modeChip.getAttribute("aria-expanded")).toBe("false");
    expect(modelChip.getAttribute("aria-expanded")).toBe("true");

    // Tab closes popover.
    await user.keyboard("{Tab}");
    expect(modelChip.getAttribute("aria-expanded")).toBe("false");

    // Becoming disabled while open closes the popover and sets data-disabled.
    await user.click(modeChip);
    expect(modeChip.getAttribute("aria-expanded")).toBe("true");
    rerender(
      <I18nProvider translator={translator}>
        <div>
          <button type="button">Outside</button>
          <SettingChips
            settings={{ schema: twoChipSchema, value: { mode: "auto", model: "default" } }}
            disabled={true}
            onSet={() => {}}
          />
        </div>
      </I18nProvider>,
    );
    expect(modeChip.getAttribute("aria-expanded")).toBe("false");
    expect((modeChip as HTMLButtonElement).disabled).toBe(true);
  });

  test("Model and Effort are two chips on the right, each with its own menu", async () => {
    const user = userEvent.setup();
    const calls: [string, string][] = [];
    const schema = {
      type: "object",
      properties: {
        mode: {
          type: "string",
          title: "Permission mode",
          oneOf: [{ const: "auto", title: "Auto" }],
        },
        model: {
          type: "string",
          title: "Model",
          oneOf: [
            { const: "default", title: "Default model", description: "Default description." },
            { const: "opus", title: "Opus", description: "Most capable." },
            { const: "sonnet", title: "Sonnet", description: "Balanced." },
          ],
        },
        effort: {
          type: "string",
          title: "Effort",
          oneOf: [
            { const: "default", title: "Default", description: "Model default depth." },
            { const: "low", title: "Low", description: "Minimal reasoning." },
            { const: "high", title: "High", description: "Deeper reasoning." },
          ],
        },
      },
    };

    const { rerender } = wrap(
      <div>
        <div data-testid="left">
          <SettingChips
            side="left"
            settings={{ schema, value: { mode: "auto", model: "opus", effort: "high" } }}
            disabled={false}
            onSet={(k, v) => calls.push([k, v])}
          />
        </div>
        <div data-testid="right">
          <SettingChips
            side="right"
            settings={{ schema, value: { mode: "auto", model: "opus", effort: "high" } }}
            disabled={false}
            onSet={(k, v) => calls.push([k, v])}
          />
        </div>
      </div>,
    );

    // Permission mode stays on the left; Model and Effort sit on the right, each a chip of its own.
    expect(
      within(screen.getByTestId("left")).getByRole("button", { name: "Permission mode: Auto" }),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId("left")).queryByRole("button", { name: /Model|Effort/ }),
    ).toBeNull();
    const right = within(screen.getByTestId("right"));
    expect(right.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Model: Opus",
      "Effort: High",
    ]);
    const modelChip = right.getByRole("button", { name: "Model: Opus" });
    const effortChip = right.getByRole("button", { name: "Effort: High" });

    // The Model menu is the models only, without their descriptions.
    expect(modelChip.getAttribute("aria-haspopup")).toBe("menu");
    await user.click(modelChip);
    screen.getByRole("menu", { name: "Model" });
    expect(screen.queryByText("Most capable.")).toBeNull();
    expect(screen.queryByRole("menu", { name: "Effort" })).toBeNull();
    await user.click(screen.getByRole("menuitemradio", { name: /Sonnet/ }));
    expect(calls.at(-1)).toEqual(["model", "sonnet"]);
    expect(modelChip.getAttribute("aria-expanded")).toBe("false");

    // The Effort menu lists the levels by name (what each does is in its title); the model's default is named as such.
    await user.click(effortChip);
    const levels = screen.getByRole("menu", { name: "Effort" });
    expect(
      within(levels)
        .getAllByRole("menuitemradio")
        .map((o) => o.textContent),
    ).toEqual(["Model default", "Low", "High"]);
    expect(within(levels).getByRole("menuitemradio", { name: "Low" }).title).toBe(
      "Minimal reasoning.",
    );
    expect(
      within(levels).getByRole("menuitemradio", { checked: true }).textContent?.startsWith("High"),
    ).toBe(true);
    // The keyboard goes through it as through the others: the list has the focus, arrows move, Enter chooses.
    await frame();
    expect(highlighted(levels)).toBeNull();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(calls.at(-1)).toEqual(["effort", "low"]);
    expect(effortChip.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(effortChip);

    // Until the session has the new level, the chip says the one it has: no level shown that it may not get.
    expect(effortChip.getAttribute("aria-label")).toBe("Effort: High");

    // The model's default reads as the default effort on the chip; a session with none on record reads "Not set".
    const show = (value: Record<string, string>) =>
      rerender(
        <I18nProvider translator={translator}>
          <SettingChips
            side="right"
            settings={{ schema, value }}
            disabled={false}
            onSet={(k, v) => calls.push([k, v])}
          />
        </I18nProvider>,
      );
    show({ mode: "auto", model: "sonnet", effort: "default" });
    const byDefault = screen.getByRole("button", { name: "Effort: Model default" });
    expect(byDefault.textContent).toBe("Default effort");
    show({ mode: "auto", model: "sonnet" });
    expect(screen.getByRole("button", { name: "Effort: Not set" })).toBeTruthy();
  });

  test("a choice on its way is what the next one is measured against, so the last choice is the one that lands", async () => {
    const user = userEvent.setup();
    const calls: [string, string][] = [];
    const answers: (() => void)[] = [];
    const onSet = (k: string, v: string) => {
      calls.push([k, v]);
      return new Promise<void>((resolve) => answers.push(resolve));
    };
    const render = (value: Record<string, string>) => (
      <I18nProvider translator={translator}>
        <SettingChips settings={{ schema: effortSchema, value }} disabled={false} onSet={onSet} />
      </I18nProvider>
    );
    const { rerender } = wrap(render({ model: "odd", effort: "high" }));
    const pick = async (level: string) => {
      await user.click(screen.getByRole("button", { name: /^Effort:/ }));
      await user.click(screen.getByRole("menuitemradio", { name: level }));
    };

    // Low is asked for and has not landed: the chip still says High. Low again sends nothing more.
    await pick("low");
    await pick("low");
    expect(calls).toEqual([["effort", "low"]]);
    expect(screen.getByRole("button", { name: "Effort: high" })).toBeTruthy();
    // Back to High, the level the session has, while Low is on its way: High is asked for, so it is what lands.
    await pick("high");
    expect(calls).toEqual([
      ["effort", "low"],
      ["effort", "high"],
    ]);

    // A request that settles with no change (refused) leaves nothing on its way: the same choice can be made again.
    rerender(render({ model: "odd", effort: "medium" }));
    await pick("max");
    await act(async () => answers.at(-1)?.());
    await pick("max");
    expect(calls.slice(2)).toEqual([
      ["effort", "max"],
      ["effort", "max"],
    ]);
  });

  test("the Effort chip sits right after the Model chip, wherever the schema lists it", () => {
    const { effort, model } = effortSchema.properties;
    wrap(
      <I18nProvider translator={translator}>
        <SettingChips
          settings={{
            schema: {
              type: "object",
              properties: { effort, mode: shortSchema.properties.mode, model },
            },
            value: { model: "odd", effort: "high", mode: "auto" },
          }}
          disabled={false}
          onSet={() => {}}
        />
      </I18nProvider>,
    );
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Permission mode: Auto",
      "Model: Odd",
      "Effort: high",
    ]);
  });

  test("effort follows the model's own levels: none hides it, a few narrow it, the level in force stays shown", async () => {
    const user = userEvent.setup();
    const calls: [string, string][] = [];
    const render = (value: Record<string, string>) => (
      <I18nProvider translator={translator}>
        <SettingChips
          settings={{ schema: effortSchema, value }}
          disabled={false}
          onSet={(k, v) => calls.push([k, v])}
        />
      </I18nProvider>
    );
    const { rerender } = wrap(render({ model: "opus", effort: "max" }));
    const levels = async () => {
      await user.click(screen.getByRole("button", { name: /^Effort:/ }));
      const names = within(screen.getByRole("menu", { name: "Effort" }))
        .getAllByRole("menuitemradio")
        .map((o) => o.textContent);
      await user.keyboard("{Escape}");
      return names;
    };

    // Opus takes low, high and max: the menu offers those and the model's default, nothing else.
    expect(await levels()).toEqual(["Model default", "low", "high", "max"]);
    // Choosing a model in a session that exists only asks for the model: its agent resets the effort.
    await user.click(screen.getByRole("button", { name: "Model: Opus" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Haiku" }));
    expect(calls).toEqual([["model", "haiku"]]);

    // With Haiku chosen, there is no effort to show.
    rerender(render({ model: "haiku", effort: "default" }));
    expect(screen.queryByRole("button", { name: /^Effort:/ })).toBeNull();

    // A model that does not say keeps every level.
    // "default" is the medium one, written after it, not a row of its own.
    rerender(render({ model: "odd", effort: "default" }));
    expect(screen.getByRole("button", { name: /^Effort: medium/ }).textContent).toBe(
      "medium (default)",
    );
    const odd = await levels();
    expect(odd).toHaveLength(4);
    expect(odd).toContain("medium (default)");
    expect(odd).not.toContain("Model default");
    await user.click(screen.getByRole("button", { name: /^Effort:/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "high" }));
    // The agent answers: the session is on high now, and going back to the default asks it to clear the override.
    rerender(render({ model: "odd", effort: "high" }));
    await user.click(screen.getByRole("button", { name: /^Effort:/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "medium (default)" }));
    expect(calls.slice(-2)).toEqual([
      ["effort", "high"],
      ["effort", "default"],
    ]);
    // Set to medium itself: a row of its own beside the default, so it is seen and can be cleared.
    rerender(render({ model: "odd", effort: "medium" }));
    expect(await levels()).toEqual(["low", "medium (default)", "medium", "high", "max"]);
    await user.click(screen.getByRole("button", { name: /^Effort:/ }));
    await user.click(screen.getByRole("menuitemradio", { name: "medium (default)" }));
    expect(calls.at(-1)).toEqual(["effort", "default"]);

    // A level the model does not list, still in force until the agent answers, is shown as it is, not as "Not set".
    rerender(render({ model: "opus", effort: "medium" }));
    expect(screen.getByRole("button", { name: "Effort: medium" })).toBeTruthy();
    expect(await levels()).toEqual(["Model default", "low", "medium", "high", "max"]);
  });

  test("a new session's effort goes back to default when the chosen model does not take it", () => {
    const defaults = { model: "default", effort: "default" };
    expect(withEffortFor(effortSchema, { model: "haiku", effort: "max" }, defaults)).toEqual({
      model: "haiku",
      effort: "default",
    });
    expect(withEffortFor(effortSchema, { model: "opus", effort: "medium" }, defaults)).toEqual({
      model: "opus",
      effort: "default",
    });
    // Taken, not known, or no level chosen: left as it is.
    expect(withEffortFor(effortSchema, { model: "opus", effort: "max" }, defaults)).toEqual({
      model: "opus",
      effort: "max",
    });
    expect(withEffortFor(effortSchema, { model: "odd", effort: "max" }, defaults)).toEqual({
      model: "odd",
      effort: "max",
    });
    expect(withEffortFor(effortSchema, { model: "haiku" }, defaults)).toEqual({ model: "haiku" });
  });
});
