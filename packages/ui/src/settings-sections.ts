// The sections of the settings page, in the order they are listed. The words are also what the analytics name them by
// (`settings_section_shown`): a test holds the two lists together. No React here, so that test can read it.
export const SETTINGS_SECTIONS = [
  "general",
  "appearance",
  "environments",
  "shortcuts",
  "harness",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
