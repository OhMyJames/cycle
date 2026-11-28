import { expect, test } from "bun:test";
import {
  mentionableSessions,
  mentionQuery,
  mentionRow,
  SESSION_CHIP_MAX_CHARS,
  SESSION_ROWS,
  sessionChipText,
  sessionIdOfUri,
  sessionLabel,
  sessionUri,
} from "../src/mention.ts";

test("an @ at the start or after a space begins a name, up to the caret", () => {
  expect(mentionQuery("@")).toBe("");
  expect(mentionQuery("@src/ma")).toBe("src/ma");
  expect(mentionQuery("look at @ma")).toBe("ma");
  expect(mentionQuery("line one\nline two @a")).toBe("a");
});

test("an @ inside a word, a space in the name, or no @ at all, begins nothing", () => {
  expect(mentionQuery("mail me at a@b.c")).toBeUndefined();
  expect(mentionQuery("@src/main.ts ")).toBeUndefined();
  expect(mentionQuery("@a @")).toBe("");
  expect(mentionQuery("no at here")).toBeUndefined();
  expect(mentionQuery("@@")).toBeUndefined();
  expect(mentionQuery(`@${"a".repeat(81)}`)).toBeUndefined();
});

test("a file is shown by its name with its folder beside it, a folder with a slash", () => {
  expect(mentionRow("src/lib/a.ts", "file")).toEqual({ name: "a.ts", folder: "src/lib" });
  expect(mentionRow("README.md", "file")).toEqual({ name: "README.md", folder: "" });
  expect(mentionRow("src/lib", "folder")).toEqual({ name: "lib/", folder: "src" });
});

const session = (sessionId: string, title: string, extra: object = {}) => ({
  locationId: "local",
  sessionId,
  title,
  archived: false,
  lastSeq: 1,
  updatedAt: "2020-01-01T00:00:00.000Z",
  ...extra,
});

test("the sessions an @ may name: same location, not this one, not archived, the most recent first", () => {
  const sessions = [
    session("here", "Login here"),
    session("old", "Login old", { updatedAt: "2019-01-01T00:00:00.000Z" }),
    session("new", "Login new", { updatedAt: "2021-01-01T00:00:00.000Z" }),
    session("away", "Login away", { locationId: "ssh-x" }),
    session("archived", "Login archived", { archived: true }),
    session("other", "Something else"),
  ];
  const named = (query: string) =>
    mentionableSessions(
      sessions,
      query,
      { locationId: "local", sessionId: "here" },
      (s) => s.title,
    ).map((s) => s.sessionId);
  expect(named("LOG")).toEqual(["new", "old"]);
  expect(named("")).toEqual(["new", "other", "old"]);
  // A blank conversation has no session of its own.
  expect(
    mentionableSessions(sessions, "here", { locationId: "local" }, (s) => s.title).map(
      (s) => s.sessionId,
    ),
  ).toEqual(["here"]);
  const many = Array.from({ length: 20 }, (_, i) => session(`s${i}`, `t${i}`));
  expect(mentionableSessions(many, "", { locationId: "local" }, (s) => s.title)).toHaveLength(
    SESSION_ROWS,
  );
});

test("a session is said by its title on one line, without Markdown's marks, and never as nothing", () => {
  expect(sessionLabel("Fix the *login*  bug\n`now`")).toBe("Fix the login bug now");
  expect(sessionLabel("x".repeat(100))).toHaveLength(60);
  expect(sessionLabel("**")).toBe("session");
});

test("a session chip truncates labels longer than 20 characters with an ellipsis", () => {
  expect(SESSION_CHIP_MAX_CHARS).toBe(20);
  expect(sessionChipText("short")).toBe("short");
  expect(sessionChipText("a".repeat(20))).toBe("a".repeat(20));
  expect(sessionChipText("a".repeat(21))).toBe(`${"a".repeat(20)}...`);
  expect(sessionChipText("帮我看一下 咱们现在 itsaplan 里面，有哪些 workitem 过期了")).toBe(
    "帮我看一下 咱们现在 itsaplan...",
  );
  // Surrogate pairs and ZWJ grapheme clusters count as one character and are never split.
  expect(sessionChipText("😀".repeat(25))).toBe(`${"😀".repeat(20)}...`);
  expect(sessionChipText("👨‍👩‍👧‍👦".repeat(21))).toBe(`${"👨‍👩‍👧‍👦".repeat(20)}...`);
});

test("sessionIdOfUri parses cycle://session/ addresses and rejects anything else", () => {
  expect(sessionIdOfUri(sessionUri("s2"))).toBe("s2");
  expect(sessionIdOfUri(sessionUri("a/b c"))).toBe("a/b c");
  expect(sessionIdOfUri("cycle://session/")).toBeUndefined();
  expect(sessionIdOfUri("cycle://session/%E0%A4%A")).toBeUndefined();
  expect(sessionIdOfUri("file:///work/a.ts")).toBeUndefined();
  expect(sessionIdOfUri(null)).toBeUndefined();
});
