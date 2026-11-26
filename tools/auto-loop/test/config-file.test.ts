import { expect, test } from "bun:test";
import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfigFile,
  parseConfigFile,
  parseConfigFiles,
  readTuning,
  tuningToConfig,
  writeConfigFile,
} from "../src/config-file.ts";
import { resolveProject } from "../src/project.ts";
import { acquireLock } from "../src/store.ts";

const full = { repoRoot: "/r", projectKey: "CYC", stateDir: "/s", planKey: "k" };

test("a missing required field is named", () => {
  for (const name of ["repoRoot", "projectKey", "stateDir", "planKey"] as const) {
    const { [name]: _, ...rest } = full;
    expect(() => parseConfigFile(JSON.stringify(rest))).toThrow(`missing required ${name}`);
  }
});

test("relative paths are refused", () => {
  expect(() => parseConfigFile(JSON.stringify({ ...full, repoRoot: "rel" }))).toThrow("absolute");
});

test("written with 0600, and a wider file is refused on load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "al-cfg-"));
  const path = join(dir, "c.json");
  await writeFile(path, "{}", { mode: 0o644 });
  await writeConfigFile(path, full);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await loadConfigFile(path)).projectKey).toBe("CYC");
  await chmod(path, 0o644);
  await expect(loadConfigFile(path)).rejects.toThrow("too open");
});

test("the lock follows the configured stateDir", async () => {
  const a = await mkdtemp(join(tmpdir(), "al-a-"));
  const b = await mkdtemp(join(tmpdir(), "al-b-"));
  const releaseA = await acquireLock(a, () => true, 1);
  const releaseB = await acquireLock(b, () => true, 2);
  await expect(acquireLock(a, () => true, 3)).rejects.toThrow("another loop");
  await releaseA();
  await releaseB();
});

const project = (cols: [number, string, string, number][], labels = [{ id: 7, name: "auto" }]) => ({
  data: {
    columns: cols.map(([id, name, stateType, position]) => ({ id, name, stateType, position })),
    issueTypes: [
      { id: 1, name: "Feature" },
      { id: 2, name: "Bug" },
    ],
    labels,
  },
});
const names = { projectKey: "X", autoLabel: "auto", featureType: "Feature", bugType: "Bug" };

test("columns are chosen by stateType in board order, not by name", () => {
  const setup = resolveProject(
    project([
      [9, "Fertig", "completed", 3],
      [3, "Hold", "started", 6],
      [1, "Neu", "unstarted", 1],
      [2, "Läuft", "started", 2],
      [4, "Prüfung", "started", 5],
      [8, "Zu", "canceled", 4],
      [5, "Später", "unstarted", 7],
    ]),
    names,
  );
  expect(setup.columns).toEqual({
    todo: 1,
    inProgress: 2,
    inReview: 4,
    blocked: 3,
    done: 9,
    canceled: 8,
  });
  expect(setup.autoLabelId).toBe(7);
  expect(setup.allowedTypeIds).toEqual([1, 2]);
});

test("a project missing a column or label fails with what is missing", () => {
  expect(() => resolveProject(project([[1, "a", "unstarted", 1]]), names)).toThrow("in-progress");
  const cols: [number, string, string, number][] = [
    [1, "a", "unstarted", 1],
    [2, "b", "started", 2],
    [3, "c", "started", 3],
    [4, "d", "started", 4],
    [5, "e", "completed", 5],
    [6, "f", "canceled", 6],
  ];
  expect(() => resolveProject(project(cols, []), names)).toThrow('label named "auto"');
});

test("workers must be a positive integer, and the error names the Project's position", () => {
  const base = { repoRoot: "/r", projectKey: "A", stateDir: "/s", planKey: "k" };
  expect(parseConfigFiles(JSON.stringify({ ...base, workers: 2 }))[0]?.workers).toBe(2);
  expect(parseConfigFiles(JSON.stringify(base))[0]?.workers).toBeUndefined();
  for (const bad of [0, -1, 1.5, "2"])
    expect(() =>
      parseConfigFiles(
        JSON.stringify({ projects: [base, { ...base, stateDir: "/t", workers: bad }] }),
      ),
    ).toThrow("projects[1]: invalid workers");
});

const base = { repoRoot: "/r", projectKey: "A", stateDir: "/s", planKey: "k" };

test("tuning: written fields are used, the others stay unset so the defaults apply", () => {
  const [file] = parseConfigFiles(
    JSON.stringify({
      ...base,
      tuning: { maxFixRounds: 5, ciTimeoutMinutes: 45, intervalSeconds: 10 },
    }),
  );
  expect(file?.tuning).toEqual({ maxFixRounds: 5, ciTimeoutMinutes: 45, intervalSeconds: 10 });
  expect(tuningToConfig(file?.tuning ?? {})).toEqual({ maxFixRounds: 5, ciTimeoutMs: 45 * 60_000 });
  expect(parseConfigFiles(JSON.stringify(base))[0]?.tuning).toBeUndefined();
});

test("tuning: out of range, wrong type or unknown fields are errors that name the field", () => {
  const bad: [Record<string, unknown>, string][] = [
    [{ maxFixRounds: 0 }, "tuning.maxFixRounds"],
    [{ maxFixRounds: 11 }, "tuning.maxFixRounds"],
    [{ turnTimeoutMinutes: 0 }, "tuning.turnTimeoutMinutes"],
    [{ ciPollIntervalSeconds: "30" }, "tuning.ciPollIntervalSeconds"],
    [{ maxQaRetries: 1.5 }, "tuning.maxQaRetries"],
    [{ intervalSeconds: -1 }, "tuning.intervalSeconds"],
    [{ ciChecks: ["x"] }, "tuning"],
  ];
  for (const [tuning, name] of bad)
    expect(() => parseConfigFiles(JSON.stringify({ ...base, tuning }))).toThrow(name);
  expect(() => parseConfigFiles(JSON.stringify({ ...base, tuning: 3 }))).toThrow("tuning");
});

test("readTuning reads one Project's tuning and throws on an unreadable file or a bad field", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tuning-"));
  const path = join(dir, "c.json");
  const other = { ...base, projectKey: "B", stateDir: "/t", tuning: { maxFixRounds: 99 } };
  await writeFile(
    path,
    JSON.stringify({ projects: [{ ...base, tuning: { maxCiRetries: 4 } }, other] }),
  );
  expect(await readTuning(path, "A")).toEqual({ maxCiRetries: 4 });
  await expect(readTuning(path, "B")).rejects.toThrow("tuning.maxFixRounds");
  await expect(readTuning(path, "C")).rejects.toThrow("not found");
  await writeFile(path, JSON.stringify(base));
  expect(await readTuning(path, "A")).toEqual({});
  await writeFile(path, "{ nope");
  await expect(readTuning(path, "A")).rejects.toThrow("cannot be read");
  await expect(readTuning(join(dir, "missing.json"), "A")).rejects.toThrow("cannot be read");
});
