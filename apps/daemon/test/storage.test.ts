import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { ConfigSchema } from "../src/config.ts";
import { HARNESSES } from "../src/harnesses.ts";
import { Daemon } from "../src/index.ts";
import { type AgentHome, agentHomesOf, cleanStorage, readStorage } from "../src/storage.ts";
import { connectClient, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

let dir: string;
let outside: string;
let dispose: () => Promise<void>;
let disposeOutside: () => Promise<void>;
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
  ({ dir: outside, dispose: disposeOutside } = await tempDir());
});
afterEach(async () => {
  await dispose();
  await disposeOutside();
});

const file = async (path: string, size = 4096) => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "x".repeat(size));
};

/** A home like an agent's, with caches, the things that must stay, and a history. */
const seed = async (home: string) => {
  await file(join(home, ".bun", "install", "cache", "pkg.tgz"), 8192);
  await file(join(home, ".npm", "_cacache", "index"));
  await file(join(home, "Library", "Caches", "electron", "zip"));
  await file(join(home, ".gemini", "antigravity-cli", "oauth_creds.json"));
  await file(join(home, ".local", "state", "x"));
  await file(join(home, "Library", "Application Support", "state.json"));
  await file(join(home, "plugins", "p", "plugin.json"));
  await file(join(home, "projects", "p", "session.jsonl"), 8192);
  await file(join(home, "code", "work.ts"));
};

const homes = (...of: string[]): AgentHome[] =>
  of.map((h, i) => ({ agent: `a${i}`, name: `A${i}`, home: h }));

test("it measures the caches and the histories of a home, and nothing else", async () => {
  const home = join(dir, "claude");
  await seed(home);
  const [agent] = await readStorage(homes(home), dir);
  expect(agent?.managed).toBe(true);
  expect(agent?.items.map((i) => [i.id, i.kind]).sort()).toEqual([
    ["bun-cache", "cache"],
    ["library-caches", "cache"],
    ["npm-cache", "cache"],
    ["projects", "history"],
  ]);
  expect(agent?.items.find((i) => i.id === "bun-cache")?.bytes).toBeGreaterThanOrEqual(8192);
});

test("clearing removes the cache folders and leaves a login, a plugin, a history and the agent's own work", async () => {
  const home = join(dir, "claude");
  await seed(home);
  const result = await cleanStorage(homes(home), dir, "a0");
  expect(result.cleaned).toBe(true);
  expect(result.cleaned && result.freedBytes).toBeGreaterThanOrEqual(8192);
  for (const gone of [".bun/install/cache", ".npm/_cacache", "Library/Caches"])
    expect(existsSync(join(home, gone))).toBe(false);
  for (const kept of [
    ".gemini/antigravity-cli/oauth_creds.json",
    ".local/state/x",
    "Library/Application Support/state.json",
    "plugins/p/plugin.json",
    "projects/p/session.jsonl",
    "code/work.ts",
  ])
    expect(existsSync(join(home, kept))).toBe(true);
});

test("a cache folder that is a link is not followed, and what it points to stays", async () => {
  const home = join(dir, "claude");
  await file(join(outside, "precious.txt"));
  await mkdir(join(home, ".npm"), { recursive: true });
  await symlink(outside, join(home, ".npm", "_cacache"));
  await mkdir(join(home, "Library"), { recursive: true });
  await symlink(outside, join(home, "Library", "Caches"));
  expect((await readStorage(homes(home), dir))[0]?.items).toEqual([]);
  expect((await cleanStorage(homes(home), dir, "a0")).cleaned).toBe(true);
  expect(existsSync(join(outside, "precious.txt"))).toBe(true);
});

test("a home that is a link to somewhere outside the data folder is the owner's: nothing is measured or removed", async () => {
  await seed(outside);
  const home = join(dir, "claude");
  await symlink(outside, home);
  const [agent] = await readStorage(homes(home), dir);
  expect(agent).toMatchObject({ managed: false, items: [] });
  expect(await cleanStorage(homes(home), dir, "a0")).toMatchObject({
    cleaned: false,
    problem: "unmanaged",
  });
  expect(existsSync(join(outside, ".bun", "install", "cache", "pkg.tgz"))).toBe(true);
});

test("a home given as the data folder itself, or one outside it, is not managed", async () => {
  await seed(outside);
  expect((await readStorage(homes(dir, outside), dir)).map((a) => a.managed)).toEqual([
    false,
    false,
  ]);
  expect((await cleanStorage(homes(dir), dir, "a0")).cleaned).toBe(false);
});

test("a home not made yet is managed and empty, and an unknown agent is told so", async () => {
  expect(await readStorage(homes(join(dir, "codex")), dir)).toEqual([
    { agent: "a0", name: "A0", managed: true, items: [] },
  ]);
  expect(await cleanStorage(homes(join(dir, "codex")), dir, "nobody")).toMatchObject({
    cleaned: false,
    problem: "unknown_agent",
  });
});

test("through the daemon: it says it has storage, reads the sizes, clears, and refuses while a turn of that agent runs", async () => {
  const home = join(dir, "fake");
  await seed(home);
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fake = fakeAgent({ onPrompt: () => held });
  const daemon = await Daemon.start({
    dataDir: dir,
    agents: [fake.definition],
    agentHomes: () => [{ agent: "fake", name: "Fake", home }],
  });
  try {
    const c = await connectClient(daemon);
    const caps = (c.init._meta as Record<string, { storage?: boolean }>)["cycle/capabilities"];
    expect(caps?.storage).toBe(true);
    const read = (await c.agent.request("_cycle/storage/read" as never, {} as never)) as {
      agents: { agent: string; items: { id: string }[] }[];
    };
    expect(read.agents[0]?.items.map((i) => i.id)).toContain("bun-cache");

    const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
    await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
    await c.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    await until(() => daemon.activity().some((a) => a.turn), "the turn to run");
    expect(
      await c.agent.request("_cycle/storage/clean" as never, { agent: "fake" } as never),
    ).toMatchObject({
      cleaned: false,
      problem: "busy",
    });
    expect(existsSync(join(home, ".bun", "install", "cache", "pkg.tgz"))).toBe(true);

    release();
    await until(() => daemon.activity().length === 0, "the turn to end");
    expect(
      await c.agent.request("_cycle/storage/clean" as never, { agent: "fake" } as never),
    ).toMatchObject({
      cleaned: true,
    });
    expect(existsSync(join(home, ".bun", "install", "cache"))).toBe(false);
  } finally {
    release();
    await daemon.close();
  }
});

test("each harness's managed directory is what its own storageDir says, even when host HOME is inherited", () => {
  const config = ConfigSchema.parse({ codex: { configDir: "/data/mine/codex" } });
  const found = Object.fromEntries(
    agentHomesOf(HARNESSES, config, "/data", {
      PATH: "/usr/bin",
      HOME: "/Users/real-host-home",
    }).map((h) => [h.agent, h.home]),
  );
  expect(found.claude).toBe("/data/claude");
  expect(found.codex).toBe("/data/mine/codex");
  expect(found.agy).toBe("/data/agy");
});

test("a link to another place in the same home does not get that place removed", async () => {
  const home = join(dir, "claude");
  await file(join(home, "plugins", "_cacache", "keep.txt"));
  await symlink(join(home, "plugins"), join(home, ".npm"));
  expect((await cleanStorage(homes(home), dir, "a0")).cleaned).toBe(true);
  expect(existsSync(join(home, "plugins", "_cacache", "keep.txt"))).toBe(true);
  expect((await readStorage(homes(home), dir))[0]?.items).toEqual([]);
});

test("a turn that starts while it clears stops it: what is already gone stays gone, the rest stays", async () => {
  const home = join(dir, "claude");
  await seed(home);
  let asked = 0;
  const result = await cleanStorage(homes(home), dir, "a0", () => ++asked > 1);
  expect(result).toMatchObject({ cleaned: false, problem: "busy" });
  const left = [".bun/install/cache", ".npm/_cacache", "Library/Caches"].filter((p) =>
    existsSync(join(home, p)),
  );
  expect(left.length).toBe(2);
});
