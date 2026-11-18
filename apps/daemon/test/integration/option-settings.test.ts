/**
 * What the owner's settings do with the modes agents offer, over the wire, pinned before options are
 * one list (step 18). A daemon over a harness that runs nothing, in a folder of its own.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Daemon,
  type OpenProviders,
  diskFile,
  openProviders,
  startDaemon,
} from "../../src/index.ts";
import { FakeHarness } from "../fake-harness.ts";
import { type WireClient, connect } from "./wire-client.ts";

let root: string;
let providers: OpenProviders;
let n = 0;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "cycle-option-settings-"));
  providers = await openProviders(
    diskFile(join(root, "providers.json")),
    "gateway-token",
    join(root, "provider-models.json"),
  );
});

afterAll(() => {
  providers?.stop();
  rmSync(root, { recursive: true, force: true });
});

/** A daemon whose home holds `settings`, as an older or a newer daemon wrote it. */
async function within(
  settings: Record<string, unknown>,
  run: (client: WireClient, home: string) => Promise<void>,
) {
  const home = join(root, `home${++n}`);
  Bun.spawnSync(["mkdir", "-p", home]);
  writeFileSync(join(home, "settings.json"), JSON.stringify(settings));
  const daemon: Daemon = await startDaemon({
    harness: new FakeHarness().asAgents(),
    providers: providers.store,
    home,
  });
  const client = connect(daemon.url);
  try {
    await client.opened;
    await run(client, home);
  } finally {
    client.close();
    await daemon.stop();
  }
}

const base = { model: null, effort: null, worktree: false, projects: [] };

/** The modes new sessions start in, for a daemon whose settings file holds `settings`. */
const modes = async (settings: Record<string, unknown>) => {
  let seen: unknown;
  await within({ ...base, ...settings }, async (client) => {
    seen = (await client.call("settings.get", {})).modes;
  });
  return seen;
};

test("what new sessions start in is the owner's choice for the agent, else the old choice, else its default", async () => {
  expect(await modes({ modes: { fake: "plan" }, mode: "fullAccess" })).toEqual({ fake: "plan" });
  expect(await modes({ modes: {}, mode: "readOnly" })).toEqual({ fake: "readOnly" });
  expect(await modes({ modes: {}, mode: "fullAccess" })).toEqual({ fake: "fullAccess" });
  expect(await modes({ modes: {} })).toEqual({ fake: "auto" });
  // A kept choice the agent no longer offers is read as its default.
  expect(await modes({ modes: { fake: "gone" } })).toEqual({ fake: "auto" });
});

test("settings.set refuses a mode the agent does not offer, in its words, and keeps what it had", async () => {
  await within({ ...base, modes: { fake: "plan" } }, async (client, home) => {
    expect(client.call("settings.set", { modes: { fake: "root" } })).rejects.toThrow(
      "fake has no mode named root.",
    );
    expect(client.call("settings.set", { modes: { nobody: "auto" } })).rejects.toThrow(
      "nobody has no mode named auto.",
    );
    expect((await client.call("settings.get", {})).modes).toEqual({ fake: "plan" });
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).modes).toEqual({
      fake: "plan",
    });
  });
});

test("settings.set accepts the mode that never asks as a default, and a new session starts in it", async () => {
  // Today's behavior, pinned so the owner decides it apart from the refactor: the red line says
  // `fullAccess` is never a default and nothing turns it on for the owner.
  await within({ ...base, modes: {} }, async (client) => {
    const set = await client.call("settings.set", { modes: { fake: "fullAccess" } });
    expect(set.modes).toEqual({ fake: "fullAccess" });
    expect((await client.call("settings.get", {})).modes).toEqual({ fake: "fullAccess" });
    expect((await client.call("session.create", { cwd: "/project" })).mode).toBe("fullAccess");
  });
});
