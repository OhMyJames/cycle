import { expect, test } from "bun:test";
import { createTranslator, type Messages, SOURCE_LOCALE } from "../src/i18n.ts";
import { enUS } from "../src/messages/en-US.ts";

const en = createTranslator(SOURCE_LOCALE, enUS);

test("fills placeholders, and leaves one that has no value as it is", () => {
  expect(en.t("workspace.on", { location: "build-1" })).toBe("On build-1");
  expect(en.t("workspace.on")).toBe("On {location}");
});

test("chooses the plural form of the language, and writes the number as the language does", () => {
  const sessions = createTranslator(SOURCE_LOCALE, {
    n: { one: "{count} session", other: "{count} sessions" },
  });
  expect(sessions.t("n", { count: 1 })).toBe("1 session");
  expect(sessions.t("n", { count: 1234 })).toBe("1,234 sessions");
  // Another language groups digits its own way.
  const de = createTranslator("de-DE", {
    "x.count": { one: "{count} Sitzung", other: "{count} Sitzungen" },
  });
  expect(de.t("x.count", { count: 1234 })).toBe("1.234 Sitzungen");
});

test("a language with more plural forms than English uses them, and falls back to other", () => {
  const pl = createTranslator("pl-PL", {
    k: { one: "{count} sesja", few: "{count} sesje", other: "{count} sesji" },
  });
  expect(pl.t("k", { count: 1 })).toBe("1 sesja");
  expect(pl.t("k", { count: 3 })).toBe("3 sesje");
  expect(pl.t("k", { count: 12 })).toBe("12 sesji");
});

test("a key a language lacks falls back to the source language; one nobody has is shown as it is", () => {
  const fr = createTranslator("fr-FR", { "search.empty": "Aucune session." }, enUS);
  expect(fr.t("search.empty")).toBe("Aucune session.");
  expect(fr.t("search.label")).toBe("Search sessions");
  expect(fr.t("no.such.key")).toBe("no.such.key");
});

test("a parameter is text, never markup or a template", () => {
  expect(en.t("workspace.on", { location: "<b>{location}</b>" })).toBe("On <b>{location}</b>");
});

test("dates and numbers come from the locale", () => {
  expect(en.number(1234567.5)).toBe("1,234,567.5");
  expect(en.date(Date.UTC(2026, 10, 18), { timeZone: "UTC", dateStyle: "medium" })).toBe(
    "Nov 18, 2026",
  );
});

test("every plural message of the source language has an other form", () => {
  for (const [key, message] of Object.entries(enUS as Messages)) {
    if (typeof message !== "string") expect(typeof message.other, key).toBe("string");
  }
});
