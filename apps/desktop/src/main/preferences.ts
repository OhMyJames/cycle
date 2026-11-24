// How the app looks and reads, as the person chose: light or dark, the language, and whether the agent suggests what to
// say next. Kept in a file of the app's own data, apart from the locations (settings.json): a file that cannot be
// read costs a choice of colours, not the list of machines. Nothing here knows Electron: what applies a theme is handed in.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventName, EventProps } from "@cycle/analytics/events";
import {
  LANGUAGE_CHOICES,
  type LanguageChoice,
  type Preferences,
  type PreferencesState,
  THEME_CHOICES,
  type ThemeChoice,
} from "@cycle/ui/api";

export const DEFAULT_PREFERENCES: Preferences = {
  theme: "system",
  language: "system",
  promptSuggestions: true,
};

const isTheme = (value: unknown): value is ThemeChoice =>
  (THEME_CHOICES as readonly unknown[]).includes(value);
const isLanguage = (value: unknown): value is LanguageChoice =>
  (LANGUAGE_CHOICES as readonly unknown[]).includes(value);

/** What is understood of what was read or asked: a value that is not one of the choices is not taken. */
export const preferencesOf = (value: unknown): Partial<Preferences> => {
  if (typeof value !== "object" || value === null) return {};
  const { theme, language, promptSuggestions } = value as Record<string, unknown>;
  return {
    ...(isTheme(theme) ? { theme } : {}),
    ...(isLanguage(language) ? { language } : {}),
    ...(typeof promptSuggestions === "boolean" ? { promptSuggestions } : {}),
  };
};

export type PreferencesStore = {
  load(): Promise<Preferences>;
  save(preferences: Preferences): Promise<void>;
};

/**
 * Preferences in a JSON file, written whole and renamed into place. A file that is missing or cannot be read gives the
 * defaults (follow the system), and so does a value this version does not know (a language a newer one added): the app
 * opens either way. What the file holds besides is written back as it was.
 */
export const filePreferencesStore = (path: string): PreferencesStore => {
  let rest: Record<string, unknown> = {};
  // A choice the file held that this version does not know (a language a newer one added): written back for as long
  // as the person leaves that choice on following the system here.
  let unknown: Partial<Record<keyof Preferences, unknown>> = {};
  // One save at a time: two at once would write the same temporary file.
  let saving: Promise<void> = Promise.resolve();
  const write = async (preferences: Preferences): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    const written = {
      ...rest,
      ...preferences,
      ...(preferences.theme === "system" && "theme" in unknown ? { theme: unknown.theme } : {}),
      ...(preferences.language === "system" && "language" in unknown
        ? { language: unknown.language }
        : {}),
    };
    await writeFile(temporary, `${JSON.stringify(written, null, 2)}\n`);
    await rename(temporary, path);
  };
  return {
    async load() {
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
        const understood = preferencesOf(parsed);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const { theme, language, ...others } = parsed as Record<string, unknown>;
          rest = others;
          unknown = {
            ...(theme !== undefined && understood.theme === undefined ? { theme } : {}),
            ...(language !== undefined && understood.language === undefined ? { language } : {}),
          };
        }
        return { ...DEFAULT_PREFERENCES, ...understood };
      } catch {
        return { ...DEFAULT_PREFERENCES };
      }
    },
    save(preferences) {
      const done = saving.then(
        () => write(preferences),
        () => write(preferences),
      );
      saving = done;
      return done;
    },
  };
};

export type PreferencesControl = {
  state(): PreferencesState;
  /** Takes what is understood of `change`, keeps it, applies it. What is not one of the choices changes nothing. */
  set(change: unknown): Promise<PreferencesState>;
};

/** The preferences of one run of the app: read once, applied at once (before a window is made), then as they change. */
export const startPreferences = async (options: {
  store: PreferencesStore;
  /** The system's locale, read when asked: `system` follows it. */
  systemLanguage: () => string;
  /** Makes the whole window light, dark, or as the system is. */
  applyTheme: (theme: ThemeChoice) => void;
  track?: <N extends EventName>(name: N, props: EventProps<N>) => void;
}): Promise<PreferencesControl> => {
  let current = await options.store.load();
  options.applyTheme(current.theme);
  const state = (): PreferencesState => ({ ...current, systemLanguage: options.systemLanguage() });
  let changing: Promise<unknown> = Promise.resolve();
  const apply = async (change: unknown): Promise<PreferencesState> => {
    const next = { ...current, ...preferencesOf(change) };
    const theme = next.theme !== current.theme;
    const language = next.language !== current.language;
    const suggestions = next.promptSuggestions !== current.promptSuggestions;
    if (!theme && !language && !suggestions) return state();
    // Kept first: if it cannot be, nothing changes and the person is told, instead of a look that is gone at the next start.
    await options.store.save(next);
    current = next;
    if (theme) {
      options.applyTheme(next.theme);
      options.track?.("theme_changed", { theme: next.theme });
    }
    if (language) options.track?.("language_changed", { language: next.language });
    if (suggestions)
      options.track?.("prompt_suggestions_toggled", { enabled: next.promptSuggestions });
    return state();
  };
  return {
    state,
    set(change) {
      // One at a time: a change made while another is being kept starts from what that one came to, not from before it.
      const done = changing.then(
        () => apply(change),
        () => apply(change),
      );
      changing = done;
      return done;
    },
  };
};

/** Preferences that are kept nowhere: a test, or a run that was given none. */
export const memoryPreferencesStore = (): PreferencesStore => {
  let kept = { ...DEFAULT_PREFERENCES };
  return {
    load: async () => ({ ...kept }),
    save: async (preferences) => {
      kept = { ...preferences };
    },
  };
};
