import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Environment } from "@cycle/ui";
import {
  Environments,
  environmentOf,
  fileEnvironments,
  memoryEnvironments,
} from "../src/main/environments.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cv1-env-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NODE: Environment = {
  id: "env-node",
  name: "Node and Postgres",
  variables: [{ name: "DATABASE_URL", value: "postgres://secret@localhost/dev" }],
  secrets: [],
  actions: [{ id: "dev", name: "Dev server", command: { default: "npm run dev" } }],
  setup: { default: "npm ci", windows: "npm.cmd ci" },
};

const read = async (path: string) =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

test("the file holds the environments and the defaults, mode 0600, written whole", async () => {
  const path = join(dir, "environments.json");
  const store = fileEnvironments(path);
  expect(await store.load()).toEqual({ environments: [], defaults: {} });
  await store.save({ environments: [NODE], defaults: { local: { "/work": "env-node" } } });
  expect(await read(path)).toEqual({
    environments: [NODE],
    defaults: { local: { "/work": "env-node" } },
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  // No temporary file is left beside it.
  expect(await readdir(dir)).toEqual(["environments.json"]);
  expect(await fileEnvironments(path).load()).toEqual({
    environments: [NODE],
    defaults: { local: { "/work": "env-node" } },
  });
});

test("a file left readable by others is 0600 again once written", async () => {
  const path = join(dir, "environments.json");
  await writeFile(path, JSON.stringify({ environments: [], defaults: {} }), { mode: 0o644 });
  const store = fileEnvironments(path);
  await store.load();
  await store.save({ environments: [NODE], defaults: {} });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("what this version cannot read is written back as it was", async () => {
  const path = join(dir, "environments.json");
  const newer = { id: "env-new", name: "From a newer app", kind: "cloud", variables: {} };
  const withExtra = { ...NODE, color: "blue" };
  await writeFile(
    path,
    JSON.stringify({
      version: 2,
      environments: [withExtra, newer, "not even an object"],
      defaults: { local: { "/work": "env-node", "/odd": 42 }, ssh: "not a map" },
    }),
  );
  const store = fileEnvironments(path);
  // The field it does not know is not shown: the entry is the one it knows.
  expect(await store.load()).toEqual({
    environments: [NODE],
    defaults: { local: { "/work": "env-node" } },
  });
  // A default changed: the rest stays, the unchanged entry keeps its field, the unreadable ones are there.
  await store.save({ environments: [NODE], defaults: { local: { "/other": "env-node" } } });
  expect(await read(path)).toEqual({
    version: 2,
    environments: [withExtra, newer, "not even an object"],
    defaults: { local: { "/odd": 42, "/other": "env-node" }, ssh: "not a map" },
  });
  // A changed entry is written as it is now.
  const renamed = { ...NODE, name: "Renamed" };
  await store.save({ environments: [renamed], defaults: {} });
  expect((await read(path)).environments).toEqual([renamed, newer, "not even an object"]);
});

test("a file that is not JSON is kept beside, and the app starts with none", async () => {
  const path = join(dir, "environments.json");
  await writeFile(path, "{ not json");
  expect(await fileEnvironments(path).load()).toEqual({ environments: [], defaults: {} });
  const kept = (await readdir(dir)).filter((f) => f.startsWith("environments.json.broken-"));
  expect(kept).toHaveLength(1);
  expect(await readFile(join(dir, kept[0] ?? ""), "utf8")).toBe("{ not json");
});

test("an entry is read only when every part of it is one this app understands", () => {
  expect(environmentOf(NODE)).toEqual(NODE);
  expect(environmentOf({ ...NODE, variables: [{ name: "A", value: 1 }] })).toBeUndefined();
  expect(environmentOf({ ...NODE, actions: [{ id: "x", name: "X" }] })).toBeUndefined();
  expect(environmentOf({ ...NODE, setup: { default: 1 } })).toBeUndefined();
  expect(environmentOf({ id: "", name: "x", variables: [], actions: [] })).toBeUndefined();
});

test("saving checks the daemon's rules first: a refused one is not kept, and nothing of it is reported", async () => {
  const reports: [string, unknown][] = [];
  const store = memoryEnvironments();
  const environments = new Environments(store, (name, props) => reports.push([name, props]));
  expect(
    await environments.save({ ...NODE, variables: [{ name: "HOME", value: "/tmp" }] }),
  ).toEqual({ problem: "reserved_variable", name: "HOME" });
  expect(
    await environments.save({
      ...NODE,
      variables: [
        { name: "A", value: "1" },
        { name: "A", value: "2" },
      ],
    }),
  ).toEqual({ problem: "duplicate_variable", name: "A" });
  expect(await environments.save({ ...NODE, name: "  " })).toEqual({ problem: "name_missing" });
  expect(
    await environments.save({
      ...NODE,
      variables: [{ name: "BIG", value: "x".repeat(70_000) }],
    }),
  ).toEqual({ problem: "too_large", limit: 65_536 });
  expect(await environments.save("not an environment")).toMatchObject({ problem: "invalid" });
  expect(await store.load()).toEqual({ environments: [], defaults: {} });
  expect(reports).toEqual([]);

  expect(await environments.save(NODE)).toEqual({
    state: { environments: [NODE], defaults: {} },
  });
  expect(reports).toEqual([
    ["environment_config_saved", { has_setup: true, has_cleanup: false, variables: 1, actions: 1 }],
  ]);
  // Never a name, a value or a command.
  const said = JSON.stringify(reports);
  for (const secret of ["Node", "DATABASE_URL", "postgres", "npm"])
    expect(said).not.toContain(secret);
});

test("a workspace's default is kept by location and folder, and goes with its environment", async () => {
  const reports: [string, unknown][] = [];
  const store = memoryEnvironments({ environments: [NODE], defaults: {} });
  const environments = new Environments(store, (name, props) => reports.push([name, props]));
  expect(await environments.setDefault("local", "/work", "env-node")).toEqual({
    environments: [NODE],
    defaults: { local: { "/work": "env-node" } },
  });
  await environments.setDefault("ssh-box", "/work", "env-node");
  await environments.setDefault("ssh-box", "/work", null);
  expect((await environments.list()).defaults).toEqual({ local: { "/work": "env-node" } });
  // One that is not there cannot be a default.
  await expect(environments.setDefault("local", "/work", "env-gone")).rejects.toThrow();
  expect(reports).toEqual([
    ["environment_chosen", { none: false }],
    ["environment_chosen", { none: false }],
    ["environment_chosen", { none: true }],
  ]);
  expect(await environments.remove("env-node")).toEqual({ environments: [], defaults: {} });
  expect((await store.load()).defaults).toEqual({});
  expect(reports.at(-1)).toEqual(["environment_config_removed", {}]);
});

test("a session is sent the environment as it is now, without empty scripts", async () => {
  const environments = new Environments(
    memoryEnvironments({
      environments: [{ ...NODE, cleanup: { default: "  " }, actions: [] }],
      defaults: {},
    }),
  );
  expect(await environments.snapshot("env-node")).toEqual({
    id: "env-node",
    name: "Node and Postgres",
    variables: NODE.variables,
    secrets: [],
    actions: [],
    setup: { default: "npm ci", windows: "npm.cmd ci" },
  });
  expect(await environments.snapshot("nope")).toEqual({ problem: { reason: "missing" } });
});

test("a save that fails leaves what the file holds to compare with: fields and defaults it did not know are still kept", async () => {
  const path = join(dir, "environments.json");
  const withExtra = { ...NODE, note: "kept" };
  await writeFile(
    path,
    JSON.stringify({ environments: [withExtra], defaults: { other: "not a map" } }),
  );
  const store = fileEnvironments(path);
  const state = await store.load();
  await chmod(dir, 0o500);
  try {
    await expect(
      store.save({
        environments: state.environments.map((e) => ({ ...e, name: "Renamed" })),
        defaults: { other: { "/repo": NODE.id } },
      }),
    ).rejects.toThrow();
  } finally {
    await chmod(dir, 0o700);
  }
  await store.save(state);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
    environments: [withExtra],
    defaults: { other: "not a map" },
  });
});

test("one the file holds that the daemon would refuse is not sent: its action ids are empty, or one is twice", async () => {
  const action = { id: "a", name: "A", command: { default: "true" } };
  for (const actions of [[{ ...action, id: "" }], [action, { ...action, name: "B" }]]) {
    const environments = new Environments(
      memoryEnvironments({ environments: [{ ...NODE, actions }], defaults: {} }),
    );
    // Main's own check: a fix in Settings, not the daemon's `invalid_environment` (update Cycle there).
    expect(await environments.snapshot("env-node")).toEqual({
      problem: { reason: "needs_fix", name: NODE.name },
    });
    // Nor is it saved so.
    expect(await environments.save({ ...NODE, actions })).toEqual({ problem: "action_id_invalid" });
  }
});

test("a workspace's default is kept by its folder without the slashes at its end, also one read from the file", async () => {
  const environments = new Environments(
    memoryEnvironments({
      environments: [NODE],
      defaults: { local: { "/Users/me/repo/": "env-node", "/": "env-node" } },
    }),
  );
  expect((await environments.list()).defaults).toEqual({
    local: { "/Users/me/repo": "env-node", "/": "env-node" },
  });
  await environments.setDefault("local", "/Users/me/other//", "env-node");
  await environments.setDefault("local", "/Users/me/repo/", null);
  expect((await environments.list()).defaults).toEqual({
    local: { "/": "env-node", "/Users/me/other": "env-node" },
  });
});
