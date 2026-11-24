import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocationConfig } from "@cycle/ui";
import { fileSettings, LOCAL_LOCATION } from "../src/main/settings.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const fileIn = async (content?: unknown) => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-settings-"));
  dirs.push(dir);
  const path = join(dir, "settings.json");
  if (content !== undefined) await writeFile(path, JSON.stringify(content));
  return path;
};

test("no file: this computer, and nothing else", async () => {
  expect(await fileSettings(await fileIn()).load()).toEqual([LOCAL_LOCATION]);
});

test("the format before locations, a list of hosts, is read as remote locations with the same ids", async () => {
  const path = await fileIn({
    hosts: [
      { id: "ssh-box", name: "Box", kind: "ssh", host: "me@box", command: ["cycle", "proxy"] },
      { id: "ssh-alias", name: "Alias", kind: "ssh", host: "alias" },
    ],
  });
  expect(await fileSettings(path).load()).toEqual([
    LOCAL_LOCATION,
    {
      id: "ssh-box",
      name: "Box",
      kind: "remote",
      transport: { type: "ssh", host: "me@box", command: ["cycle", "proxy"] },
    },
    { id: "ssh-alias", name: "Alias", kind: "remote", transport: { type: "ssh", host: "alias" } },
  ]);
});

test("what is saved is the new format, and is read back as it was", async () => {
  const path = await fileIn({ hosts: [{ id: "ssh-box", name: "Box", kind: "ssh", host: "box" }] });
  const settings = fileSettings(path);
  const loaded = await settings.load();
  await settings.save(loaded);
  const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  expect(Object.keys(written)).toEqual(["locations"]);
  expect(written.locations).toEqual([
    { id: "ssh-box", name: "Box", kind: "remote", transport: { type: "ssh", host: "box" } },
  ]);
  expect(await fileSettings(path).load()).toEqual(loaded);
});

// `environments` was the name of the list from 2026-11-18 to 2026-11-24; the entries are the same.
const far = {
  id: "ssh-far",
  name: "Far",
  kind: "remote",
  transport: { type: "ssh", host: "far", command: ["cycle", "proxy"] },
};

test("a file of the format named environments is read, with the same ids", async () => {
  const path = await fileIn({ environments: [far] });
  expect(await fileSettings(path).load()).toEqual([LOCAL_LOCATION, far as LocationConfig]);
});

test("saving a file read from environments writes locations, and no environments or hosts", async () => {
  const strange = { id: "cloud-1", name: "Cloud", kind: "cloud" };
  const path = await fileIn({ theme: "dark", environments: [far, strange], hosts: [] });
  const settings = fileSettings(path);
  await settings.save(await settings.load());
  const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  expect(written).toEqual({ theme: "dark", locations: [far, strange] });
  expect(await fileSettings(path).load()).toEqual([LOCAL_LOCATION, far as LocationConfig]);
});

test("an older app's additions to environments, after a newer one wrote locations, are kept, and saved into locations", async () => {
  const near = {
    id: "ssh-near",
    name: "Near",
    kind: "remote",
    transport: { type: "ssh", host: "near" },
  };
  // The newer app wrote `locations` with near; an older one, which reads only `environments`, then added far there,
  // and also still has near under the same id with an older name: the one in `locations` is the one kept.
  const oldNear = { ...near, name: "Near (old)" };
  const hostsOnly = { id: "ssh-legacy", name: "Legacy", kind: "ssh", host: "legacy" };
  const path = await fileIn({
    locations: [near],
    environments: [oldNear, far],
    hosts: [hostsOnly],
  });
  const settings = fileSettings(path);
  expect((await settings.load()).map((l) => [l.id, l.name])).toEqual([
    ["local", "This computer"],
    ["ssh-near", "Near"],
    [far.id, far.name],
    ["ssh-legacy", "Legacy"],
  ]);
  await settings.save(await settings.load());
  const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  expect(Object.keys(written)).toEqual(["locations"]);
  expect((written.locations as { id: string }[]).map((l) => l.id)).toEqual([
    "ssh-near",
    far.id,
    "ssh-legacy",
  ]);
});

test("an entry with no id in an older file's environments or hosts is not shown, and is written back, once", async () => {
  const valid = { id: "ssh-far", name: "Far", kind: "ssh", host: "far" };
  const damaged = { name: "x", kind: "ssh" };
  const path = await fileIn({ environments: [valid, damaged], hosts: [damaged, { kind: "ssh" }] });
  const settings = fileSettings(path);
  expect((await settings.load()).map((l) => l.id)).toEqual(["local", "ssh-far"]);
  await settings.save(await settings.load());
  const written = JSON.parse(await readFile(path, "utf8")) as { locations: unknown[] };
  expect(written.locations.slice(1)).toEqual([damaged, { kind: "ssh" }]);
  expect((await settings.load()).map((l) => l.id)).toEqual(["local", "ssh-far"]);
});

test("a save that fails leaves what the file holds to compare with: the next one still writes back what it did not know", async () => {
  const noted = {
    id: "ssh-far",
    name: "Far",
    kind: "remote",
    transport: { type: "ssh", host: "far" },
    note: "kept",
  };
  const path = await fileIn({ locations: [noted] });
  const settings = fileSettings(path);
  const [local, read] = await settings.load();
  if (local === undefined || read === undefined) throw new Error("not read");
  const dir = join(path, "..");
  await chmod(dir, 0o500);
  try {
    await expect(settings.save([local, { ...read, name: "Renamed" }])).rejects.toThrow();
  } finally {
    await chmod(dir, 0o700);
  }
  await settings.save([local, read]);
  const written = JSON.parse(await readFile(path, "utf8")) as { locations: unknown[] };
  expect(written.locations).toEqual([noted]);
});

test("an entry this version does not understand is not shown, and is not lost when settings are saved", async () => {
  const strange = { id: "cloud-1", name: "Cloud", kind: "cloud", region: "eu" };
  const broken = { id: "no-host", name: "Broken", kind: "ssh" };
  const path = await fileIn({
    locations: [
      strange,
      { id: "far", name: "Far", kind: "remote", transport: { type: "ssh", host: "far" } },
      broken,
    ],
  });
  const settings = fileSettings(path);
  const loaded = await settings.load();
  expect(loaded.map((e) => e.id)).toEqual(["local", "far"]);
  await settings.save([
    ...loaded,
    { id: "new", name: "New", kind: "remote", transport: { type: "ssh", host: "new" } },
  ]);
  const written = JSON.parse(await readFile(path, "utf8")) as { locations: { id: string }[] };
  expect(written.locations.map((e) => e.id)).toEqual(["far", "new", "cloud-1", "no-host"]);
  expect(written.locations).toContainEqual(strange);
  expect(written.locations).toContainEqual(broken);
});

test("this computer is not kept in the file, and an entry that says it is is ignored", async () => {
  const path = await fileIn({ locations: [{ id: "local", name: "Mine", kind: "local" }] });
  const settings = fileSettings(path);
  expect(await settings.load()).toEqual([LOCAL_LOCATION]);
  await settings.save([LOCAL_LOCATION]);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ locations: [] });
});

test("a file that is not JSON does not keep the app from opening: it is kept beside, and this computer is what is left", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-settings-"));
  dirs.push(dir);
  const path = join(dir, "settings.json");
  await writeFile(path, "{ not json");
  expect(await fileSettings(path).load()).toEqual([LOCAL_LOCATION]);
  const kept = (await readdir(dir)).filter((f) => f.startsWith("settings.json.broken-"));
  expect(kept).toHaveLength(1);
  expect(await readFile(join(dir, kept[0] as string), "utf8")).toBe("{ not json");
});

test("an address ssh would read as an option is not a location, and is left as it was", async () => {
  const entry = {
    id: "x",
    name: "X",
    kind: "remote",
    transport: { type: "ssh", host: "-oProxyCommand=touch /tmp/x" },
  };
  const path = await fileIn({ locations: [entry] });
  const settings = fileSettings(path);
  expect(await settings.load()).toEqual([LOCAL_LOCATION]);
  await settings.save([LOCAL_LOCATION]);
  expect(JSON.parse(await readFile(path, "utf8")).locations).toEqual([entry]);
});

test("saves made at once are all written, one after the other", async () => {
  const path = await fileIn();
  const settings = fileSettings(path);
  await settings.load();
  const box = (n: number): LocationConfig => ({
    id: `box${n}`,
    name: `Box ${n}`,
    kind: "remote",
    transport: { type: "ssh", host: `box${n}` },
  });
  await Promise.all(
    [1, 2, 3, 4, 5].map((n) =>
      settings.save([LOCAL_LOCATION, ...[1, 2, 3, 4, 5].slice(0, n).map(box)]),
    ),
  );
  expect(JSON.parse(await readFile(path, "utf8")).locations).toHaveLength(5);
});

test("what an entry has that this version does not know, and the other keys of the file, are written back", async () => {
  const path = await fileIn({
    theme: "dark",
    locations: [
      {
        id: "far",
        name: "Far",
        kind: "remote",
        icon: "box",
        transport: { type: "ssh", host: "far", port: 2222 },
      },
    ],
  });
  const settings = fileSettings(path);
  const [, far] = await settings.load();
  // Unchanged: as it was. Renamed: what we know changes, and the rest of the file stays.
  await settings.save([LOCAL_LOCATION, far as never]);
  const same = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  expect(same.theme).toBe("dark");
  expect((same.locations as unknown[])[0]).toEqual({
    id: "far",
    name: "Far",
    kind: "remote",
    icon: "box",
    transport: { type: "ssh", host: "far", port: 2222 },
  });
});

test("a command that is not a list of words leaves the entry as it is, and not running something else", async () => {
  const entry = {
    id: "far",
    name: "Far",
    kind: "remote",
    transport: { type: "ssh", host: "far", command: "cycle proxy" },
  };
  const path = await fileIn({ locations: [entry] });
  const settings = fileSettings(path);
  expect(await settings.load()).toEqual([LOCAL_LOCATION]);
  await settings.save([LOCAL_LOCATION]);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ locations: [entry] });
});

test("an entry that says it is local but is not this computer is not a second way in", async () => {
  const laptop = { id: "laptop", name: "Laptop", kind: "local" };
  const path = await fileIn({ locations: [laptop] });
  expect((await fileSettings(path).load()).map((e) => e.id)).toEqual(["local"]);
});

test("a location saved with the id of an entry that cannot be read is the one that stays", async () => {
  const path = await fileIn({ locations: [{ id: "ssh-box", name: "Odd", kind: "cloud" }] });
  const settings = fileSettings(path);
  await settings.load();
  await settings.save([
    LOCAL_LOCATION,
    { id: "ssh-box", name: "Box", kind: "remote", transport: { type: "ssh", host: "box" } },
  ]);
  const written = JSON.parse(await readFile(path, "utf8")) as { locations: { name: string }[] };
  expect(written.locations.map((e) => e.name)).toEqual(["Box"]);
});
