import { expect, test } from "bun:test";
import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
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
import { config } from "./helpers.ts";

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

const allColumns: [number, string, string, number][] = [
  [30, "Backlog", "backlog", 0],
  [31, "Icebox", "backlog", 8],
  [1, "a", "unstarted", 1],
  [2, "b", "started", 2],
  [3, "c", "started", 3],
  [4, "d", "started", 4],
  [5, "e", "completed", 5],
  [6, "f", "canceled", 6],
];
const withResearch = () => {
  const p = project(allColumns);
  p.data.issueTypes.push({ id: 23, name: "Research" });
  return p;
};
const documents = [
  { id: 13, title: "调研：agy 怎么接入 Cycle（CYC-157）", parentId: null },
  { id: 10, title: "调研", parentId: null },
  { id: 11, title: "CYC-121 调研", parentId: 10 },
];
const research = { type: "Research", folder: "调研", documents };

test("research off: the Research type is not taken, even when the project has it", () => {
  const setup = resolveProject(withResearch(), names);
  expect(setup.allowedTypeIds).toEqual([1, 2]);
  expect(setup.research).toBeNull();
});

test("research on: the type is taken, and the first backlog column and the folder are resolved", () => {
  const setup = resolveProject(withResearch(), names, research);
  expect(setup.allowedTypeIds).toEqual([1, 2, 23]);
  expect(setup.research).toEqual({ typeId: 23, backlogColumn: 30, folderId: 10 });
});

test("research on: a missing type, backlog column or folder names the Project and what is missing", () => {
  expect(() => resolveProject(project(allColumns), names, research)).toThrow(
    'project X: no issue type named "Research"',
  );
  const noBacklog = withResearch();
  noBacklog.data.columns = noBacklog.data.columns.filter((c) => c.stateType !== "backlog");
  expect(() => resolveProject(noBacklog, names, research)).toThrow("project X: no backlog column");
  expect(() =>
    resolveProject(withResearch(), names, { ...research, documents: documents.slice(0, 1) }),
  ).toThrow('project X: no document named "调研"');
  expect(() =>
    resolveProject(withResearch(), names, {
      ...research,
      documents: [...documents, { id: 50, title: "调研", parentId: null }],
    }),
  ).toThrow('project X: 2 documents named "调研" (2 at the top level)');
});

test("research folder: a title used twice is resolved to the one at the top of the tree", () => {
  const setup = resolveProject(withResearch(), names, {
    ...research,
    documents: [...documents, { id: 51, title: "调研", parentId: 18 }],
  });
  expect(setup.research?.folderId).toBe(10);
});

// The planning node (CYC-322).
const planningNames = {
  pending: "待批准",
  awaitingAnswer: "待回答",
  skip: "Loop 跳过",
  fullProcess: "完整流程",
};
const withPlanning = () => {
  const p = project(allColumns, [
    { id: 7, name: "auto" },
    { id: 40, name: "待批准" },
    { id: 41, name: "待回答" },
    { id: 42, name: "Loop 跳过" },
    { id: 12, name: "完整流程" },
  ]) as ReturnType<typeof project> & { data: { issueTemplates: Record<string, unknown>[] } };
  p.data.issueTypes.push({ id: 17, name: "Epic" });
  p.data.issueTemplates = [
    { id: 1, name: "Feature", typeId: 1, descriptionTemplate: "## 验收标准\n" },
    { id: 3, name: "Feature（完整流程）", typeId: 1, descriptionTemplate: "## 文档清单\n" },
    { id: 2, name: "Bug", typeId: 2, descriptionTemplate: "## 现象\n" },
    { id: 4, name: "Epic", typeId: 17, descriptionTemplate: "## 目标\n" },
  ];
  return p;
};

test("planning off: nothing is resolved or required, even when the project has none of it", () => {
  const setup = resolveProject(project(allColumns), names);
  expect(setup.planning).toBeNull();
  expect(resolveProject(withPlanning(), names).planning).toBeNull();
  expect(config().planning).toBeNull();
});

test("planning on: labels, the first backlog column, Epic and the Feature and Bug templates are resolved", () => {
  const setup = resolveProject(withPlanning(), names, undefined, planningNames);
  expect(setup.planning).toEqual({
    labels: { pending: 40, awaitingAnswer: 41, skip: 42, fullProcess: 12 },
    backlogColumn: 30,
    epicTypeId: 17,
    templates: { feature: "## 验收标准\n", bug: "## 现象\n" },
  });
  // Planning adds no type the loop may take.
  expect(setup.allowedTypeIds).toEqual([1, 2]);
});

test("planning on: each missing piece names the Project and what is missing", () => {
  const on = (p: ReturnType<typeof withPlanning>) =>
    resolveProject(p, names, undefined, planningNames);
  for (const [label, name] of [
    [40, "待批准"],
    [41, "待回答"],
    [42, "Loop 跳过"],
  ] as const) {
    const p = withPlanning();
    p.data.labels = p.data.labels.filter((l) => l.id !== label);
    expect(() => on(p)).toThrow(`project X: no label named "${name}"`);
  }
  // The full-process label is only kept away from: without it, no work item carries it.
  const noFullProcess = withPlanning();
  noFullProcess.data.labels = noFullProcess.data.labels.filter((l) => l.id !== 12);
  expect(on(noFullProcess).planning?.labels.fullProcess).toBeNull();
  const noBacklog = withPlanning();
  noBacklog.data.columns = noBacklog.data.columns.filter((c) => c.stateType !== "backlog");
  expect(() => on(noBacklog)).toThrow("project X: no backlog column");
  const noEpic = withPlanning();
  noEpic.data.issueTypes = noEpic.data.issueTypes.filter((t) => t.name !== "Epic");
  expect(() => on(noEpic)).toThrow('project X: no issue type named "Epic"');
  const noBug = withPlanning();
  noBug.data.issueTemplates = noBug.data.issueTemplates.filter((t) => t.typeId !== 2);
  expect(() => on(noBug)).toThrow('project X: no issue template for type "Bug"');
  const noFeature = withPlanning();
  noFeature.data.issueTemplates = noFeature.data.issueTemplates.filter((t) => t.typeId !== 1);
  expect(() => on(noFeature)).toThrow('project X: no issue template for type "Feature"');
  // Two Feature templates and neither named "Feature": not a guess.
  const ambiguous = withPlanning();
  ambiguous.data.issueTemplates = ambiguous.data.issueTemplates.filter((t) => t.id !== 1);
  ambiguous.data.issueTemplates.push({ id: 9, name: "小档", typeId: 1, descriptionTemplate: "x" });
  expect(() => on(ambiguous)).toThrow('project X: 2 issue templates for type "Feature"');
  const empty = withPlanning();
  empty.data.issueTemplates[2] = { id: 2, name: "Bug", typeId: 2, descriptionTemplate: "" };
  expect(() => on(empty)).toThrow('project X: issue template "Bug" has no description');
});

test("planning config: absent or not enabled means off; defaults fill the rest; bad fields are named", () => {
  expect(parseConfigFile(JSON.stringify(full)).planning).toBeUndefined();
  const defaults = {
    enabled: false,
    pending: "待批准",
    awaitingAnswer: "待回答",
    skip: "Loop 跳过",
    fullProcess: "完整流程",
    maxPending: 5,
    intervalMinutes: 30,
    maxSplit: 4,
  };
  expect(parseConfigFile(JSON.stringify({ ...full, planning: {} })).planning).toEqual(defaults);
  expect(
    parseConfigFile(
      JSON.stringify({ ...full, planning: { enabled: true, pending: "approve", maxSplit: 3 } }),
    ).planning,
  ).toEqual({ ...defaults, enabled: true, pending: "approve", maxSplit: 3 });
  for (const [field, bad] of [
    ["maxPending", 0],
    ["intervalMinutes", 1.5],
    ["maxSplit", 1],
    ["pending", " "],
    ["typo", 1],
  ] as const)
    expect(() =>
      parseConfigFile(JSON.stringify({ ...full, planning: { enabled: true, [field]: bad } })),
    ).toThrow("planning");
});

test("research config: absent or not enabled means off; defaults fill the rest", () => {
  expect(parseConfigFile(JSON.stringify(full)).research).toBeUndefined();
  expect(
    parseConfigFile(JSON.stringify({ ...full, research: { enabled: false } })).research?.enabled,
  ).toBe(false);
  expect(
    parseConfigFile(JSON.stringify({ ...full, research: { enabled: true } })).research,
  ).toEqual({
    enabled: true,
    type: "Research",
    folder: "调研",
    readRoots: ["/r"],
    maxFollowups: 5,
  });
});

test("research config: readRoots expand ~ and must be absolute; bad fields are named", () => {
  const roots = (readRoots: string[]) =>
    parseConfigFile(JSON.stringify({ ...full, research: { enabled: true, readRoots } })).research
      ?.readRoots;
  expect(roots(["~/x/../y", "/a/b/"])).toEqual([join(homedir(), "y"), "/a/b"]);
  expect(roots(["~"])).toEqual([homedir()]);
  expect(() => roots(["rel/dir"])).toThrow("research.readRoots must be absolute");
  expect(() => roots(["~other/x"])).toThrow("research.readRoots must be absolute");
  expect(() => roots([])).toThrow("research.readRoots");
  expect(() =>
    parseConfigFile(JSON.stringify({ ...full, research: { enabled: true, maxFollowups: -1 } })),
  ).toThrow("research.maxFollowups");
  expect(() =>
    parseConfigFile(JSON.stringify({ ...full, research: { enabled: true, typo: 1 } })),
  ).toThrow("research");
  expect(() => parseConfigFile(JSON.stringify({ ...full, research: {} }))).toThrow(
    "research.enabled",
  );
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

test("the network retry values are tunable and become milliseconds", () => {
  const t = parseConfigFiles(
    JSON.stringify({
      ...base,
      tuning: { maxNetworkRetries: 2, networkRetryDelaysSeconds: [5, 20] },
    }),
  );
  expect(JSON.stringify(t)).toContain("networkRetryDelaysSeconds");
  expect(tuningToConfig({ maxNetworkRetries: 2, networkRetryDelaysSeconds: [5, 20] })).toEqual({
    maxNetworkRetries: 2,
    networkRetryDelaysMs: [5000, 20000],
  });
  expect(() =>
    parseConfigFiles(JSON.stringify({ ...base, tuning: { networkRetryDelaysSeconds: [] } })),
  ).toThrow("networkRetryDelaysSeconds");
});

test("model and effort per role are optional, and a blank one is refused", () => {
  const plain = parseConfigFile(JSON.stringify(full));
  expect(plain.devModel).toBeUndefined();
  expect(plain.reviewEffort).toBeUndefined();
  const set = parseConfigFile(
    JSON.stringify({ ...full, devModel: "opus", qaEffort: "high", reviewModel: "sonnet" }),
  );
  expect([set.devModel, set.qaEffort, set.reviewModel]).toEqual(["opus", "high", "sonnet"]);
  for (const name of [
    "devModel",
    "qaModel",
    "reviewModel",
    "devEffort",
    "qaEffort",
    "reviewEffort",
  ])
    for (const value of ["", "  "])
      expect(() => parseConfigFile(JSON.stringify({ ...full, [name]: value }))).toThrow(
        `invalid ${name}`,
      );
});
