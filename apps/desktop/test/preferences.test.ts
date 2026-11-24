import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENTS } from "@cycle/analytics/events";
import { CONNECTORS_SECTIONS, LANGUAGE_CHOICES, SETTINGS_SECTIONS, THEME_CHOICES } from "@cycle/ui";
import {
  DEFAULT_PREFERENCES,
  filePreferencesStore,
  memoryPreferencesStore,
  startPreferences,
} from "../src/main/preferences.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const fileIn = async (content?: string) => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-preferences-"));
  dirs.push(dir);
  const path = join(dir, "preferences.json");
  if (content !== undefined) await writeFile(path, content);
  return path;
};

test("no file, or one that is not JSON: the app follows the system", async () => {
  expect(await filePreferencesStore(await fileIn()).load()).toEqual(DEFAULT_PREFERENCES);
  expect(await filePreferencesStore(await fileIn("{ not json")).load()).toEqual(
    DEFAULT_PREFERENCES,
  );
});

test("a choice is still there after the app starts again", async () => {
  const path = await fileIn();
  const applied: string[] = [];
  const first = await startPreferences({
    store: filePreferencesStore(path),
    systemLanguage: () => "en-GB",
    applyTheme: (theme) => applied.push(theme),
  });
  expect(first.state()).toEqual({
    theme: "system",
    language: "system",
    promptSuggestions: true,
    worktreeAgents: [],
    systemLanguage: "en-GB",
  });
  expect(await first.set({ theme: "dark" })).toMatchObject({ theme: "dark", language: "system" });
  expect(await first.set({ language: "zh-CN" })).toMatchObject({
    theme: "dark",
    language: "zh-CN",
  });
  // The start applies what was read; a change of theme applies it; a change of language leaves the theme alone.
  expect(applied).toEqual(["system", "dark"]);

  const again: string[] = [];
  const second = await startPreferences({
    store: filePreferencesStore(path),
    systemLanguage: () => "en-GB",
    applyTheme: (theme) => again.push(theme),
  });
  expect(second.state()).toMatchObject({
    theme: "dark",
    language: "zh-CN",
    promptSuggestions: true,
  });
  // Suggestions of what to say next are on until turned off (CYCL-225), and stay off once they are.
  expect(await second.set({ promptSuggestions: false })).toMatchObject({
    promptSuggestions: false,
  });
  const third = await startPreferences({
    store: filePreferencesStore(path),
    systemLanguage: () => "en-GB",
    applyTheme: () => {},
  });
  expect(third.state()).toMatchObject({ theme: "dark", promptSuggestions: false });
  // Before a window is made: the first thing drawn is already dark.
  expect(again).toEqual(["dark"]);
});

test("a value that is not one of the choices is not taken, from the file or from the page", async () => {
  const path = await fileIn(JSON.stringify({ theme: "sepia", language: "tlh", later: { a: 1 } }));
  const store = filePreferencesStore(path);
  expect(await store.load()).toEqual(DEFAULT_PREFERENCES);
  const control = await startPreferences({
    store,
    systemLanguage: () => "en-US",
    applyTheme: () => {},
  });
  expect(await control.set({ theme: "<script>", language: 7 })).toMatchObject(DEFAULT_PREFERENCES);
  expect(await control.set("dark")).toMatchObject(DEFAULT_PREFERENCES);
  await control.set({ theme: "light" });
  // What a newer version kept in the file is written back as it was: its other keys, and the language this version
  // does not know, which the person has not chosen over here.
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    later: { a: 1 },
    theme: "light",
    language: "tlh",
    promptSuggestions: true,
    worktreeAgents: [],
  });
  // Once the person chooses a language here, theirs is what is kept.
  await control.set({ language: "zh-CN" });
  expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ language: "zh-CN" });
});

test("a change is counted by its word, a choice that changes nothing is not, and one that cannot be kept changes nothing", async () => {
  const events: unknown[] = [];
  const applied: string[] = [];
  let fail = false;
  const kept = memoryPreferencesStore();
  const control = await startPreferences({
    store: {
      load: kept.load,
      save: async (preferences) => {
        if (fail) throw new Error("disk full");
        await kept.save(preferences);
      },
    },
    systemLanguage: () => "zh-Hans-CN",
    applyTheme: (theme) => applied.push(theme),
    track: (name, props) => events.push([name, props]),
  });
  await control.set({ theme: "light" });
  await control.set({ theme: "light" });
  await control.set({ language: "en-US" });
  await control.set({ promptSuggestions: false });
  await control.set({ promptSuggestions: "no" });
  await control.set({ promptSuggestions: true });
  expect(events).toEqual([
    ["theme_changed", { theme: "light" }],
    ["language_changed", { language: "en-US" }],
    ["prompt_suggestions_toggled", { enabled: false }],
    ["prompt_suggestions_toggled", { enabled: true }],
  ]);
  fail = true;
  expect(control.set({ theme: "dark" })).rejects.toThrow("disk full");
  await Promise.resolve();
  expect(control.state()).toMatchObject({ theme: "light", language: "en-US" });
  expect(applied).toEqual(["system", "light"]);
  expect(events).toHaveLength(4);
});

test("two changes made at once both hold: the second starts from what the first came to", async () => {
  const applied: string[] = [];
  const kept = memoryPreferencesStore();
  const control = await startPreferences({
    store: {
      load: kept.load,
      save: async (preferences) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        await kept.save(preferences);
      },
    },
    systemLanguage: () => "en-US",
    applyTheme: (theme) => applied.push(theme),
  });
  const [, second] = await Promise.all([
    control.set({ theme: "dark" }),
    control.set({ language: "zh-CN" }),
  ]);
  expect(second).toMatchObject({ theme: "dark", language: "zh-CN" });
  expect(await kept.load()).toEqual({
    theme: "dark",
    language: "zh-CN",
    promptSuggestions: true,
    worktreeAgents: [],
  });
  // A change that could not be kept does not stop the one after it.
  expect(applied).toEqual(["system", "dark"]);
});

test("the words the analytics take for a theme, a language and a section are the ones the app has", () => {
  expect(EVENTS.theme_changed.shape.theme.options).toEqual([...THEME_CHOICES]);
  expect(EVENTS.language_changed.shape.language.options).toEqual([...LANGUAGE_CHOICES]);
  expect(EVENTS.settings_section_shown.shape.section.options).toEqual([...SETTINGS_SECTIONS]);
  expect(EVENTS.connectors_section_shown.shape.section.options).toEqual([...CONNECTORS_SECTIONS]);
});

test("the agents that start in a worktree are kept sorted and once, counted by agent word, and anything else is not taken", async () => {
  const tracked: [string, unknown][] = [];
  const control = await startPreferences({
    store: memoryPreferencesStore(),
    systemLanguage: () => "en-US",
    applyTheme: () => {},
    track: (name, props) => tracked.push([name, props]),
  });
  expect(
    (await control.set({ worktreeAgents: ["codex", "agy", "codex", 7, ""] })).worktreeAgents,
  ).toEqual(["agy", "codex"]);
  expect(tracked).toEqual([
    ["worktree_default_toggled", { agent: "agy", enabled: true }],
    ["worktree_default_toggled", { agent: "codex", enabled: true }],
  ]);
  // The same again changes nothing; one taken away is reported as off.
  await control.set({ worktreeAgents: ["codex", "agy"] });
  await control.set({ worktreeAgents: ["codex"] });
  expect(tracked.at(-1)).toEqual(["worktree_default_toggled", { agent: "agy", enabled: false }]);
  expect(tracked).toHaveLength(3);
  expect((await control.set({ worktreeAgents: "codex" })).worktreeAgents).toEqual(["codex"]);
});
