import { expect, test } from "bun:test";
import { folderFiles, ownerFiles, serversOf } from "../src/owner-files.ts";

test("the owner's files are read from the Claude Code home it is moved to", () => {
  const files = ownerFiles({ CLAUDE_CONFIG_DIR: "/x/home" }, "/x/home");
  expect(files).toContain("/x/home/.claude.json");
  expect(files).toContain("/x/home/settings.json");
  expect(files).toContain("/x/home/skills");
  expect(files).toContain("/x/home/commands");
  expect(files).toContain("/x/home/plugins/installed_plugins.json");
});

test("the user's own settings file is beside the home when it is not moved", () => {
  const files = ownerFiles({}, "/u/.claude");
  const config = files.find((path) => path.endsWith(".claude.json"));
  expect(config?.startsWith("/u/.claude/")).toBe(false);
});

test("a folder brings commands, skills and settings of its own", () => {
  expect(folderFiles("/p")).toEqual([
    "/p/.claude/commands",
    "/p/.claude/skills",
    "/p/.claude/settings.json",
    "/p/.claude/settings.local.json",
  ]);
});

test("only the servers in Claude Code's user config say whether the owner's servers changed", () => {
  const before = JSON.stringify({ numStartups: 3, mcpServers: { a: { command: "a" } } });
  // Claude Code counts its starts and keeps its caches in the same file.
  const rewritten = JSON.stringify({
    numStartups: 4,
    cache: [1],
    mcpServers: { a: { command: "a" } },
  });
  const added = JSON.stringify({ numStartups: 4, mcpServers: { a: { command: "a" }, b: {} } });
  expect(serversOf(rewritten)).toBe(serversOf(before));
  expect(serversOf(added)).not.toBe(serversOf(before));
  expect(serversOf("{}")).toBe(serversOf('{"mcpServers":null}'));
  expect(serversOf("not json")).toBe("unreadable");
});
