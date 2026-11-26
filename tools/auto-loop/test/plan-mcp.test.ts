import { afterEach, expect, test } from "bun:test";
import { PlanTracker, planningTracker, toIssue } from "../src/plan-mcp.ts";
import { resolveLoopFields } from "../src/project.ts";
import type { PlanningTracker } from "../src/types.ts";
import { config, FakeTracker, issue } from "./helpers.ts";

const fieldsOf = (reply: unknown) => {
  const r = resolveLoopFields(reply);
  return "fields" in r ? r.fields : null;
};

const names = ["开发", "验证", "QA", "等 CI", "评审", "等合并"];
const fields = (over: { options?: string[]; skipStarted?: boolean } = {}) => ({
  ok: true,
  data: [
    {
      id: 7,
      name: "Loop 阶段",
      fieldType: "select",
      options: (over.options ?? names).map((value, i) => ({ id: 100 + i, value })),
    },
    ...(over.skipStarted ? [] : [{ id: 8, name: "Loop 阶段开始于", fieldType: "datetime" }]),
  ],
});

test("field and option ids are resolved by name", () => {
  expect(fieldsOf(fields())).toEqual({
    phaseFieldId: 7,
    startedFieldId: 8,
    optionIds: { dev: 100, verify: 101, qa: 102, ci: 103, review: 104, merge: 105 },
  });
});

test("a missing field or option means do not write, without throwing", () => {
  expect(fieldsOf(fields({ skipStarted: true }))).toBeNull();
  expect(fieldsOf(fields({ options: names.slice(0, 5) }))).toBeNull();
  expect(fieldsOf({ ok: true, data: [] })).toBeNull();
  expect(fieldsOf("nonsense")).toBeNull();
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// A tracker whose catalog has every tool (`full`), or only the most used, with the rest behind execute_read/write.
// `via` is the execute_* tool a call went through, or null when the tool was called by its own name. `replies` gives
// a tool's reply by its own name (or a function of the call's arguments); anything else replies `{"ok":true}`.
const ALWAYS_LISTED = new Set(["get_issue_by_number", "list_issues"]);
const tracker = (catalog: "full" | "trimmed" = "full", replies: Record<string, unknown> = {}) => {
  const calls: { name: string; arguments: Record<string, unknown>; via: string | null }[] = [];
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const { name, arguments: args } = JSON.parse(init.body).params;
    const wrapped = name === "execute_read" || name === "execute_write";
    // The reads the tracker only calls by name are listed in both catalogs.
    if (wrapped === (catalog === "full") && !ALWAYS_LISTED.has(name))
      return new Response(
        JSON.stringify({
          result: { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] },
        }),
      );
    const call = wrapped ? { ...args, via: name } : { name, arguments: args, via: null };
    calls.push(call);
    const given = replies[call.name];
    const reply = typeof given === "function" ? given(call.arguments) : (given ?? { ok: true });
    return new Response(
      JSON.stringify({ result: { content: [{ type: "text", text: JSON.stringify(reply) }] } }),
    );
  }) as unknown as typeof fetch;
  const t = new PlanTracker({
    url: "http://x",
    key: "k",
    projectKey: "CYC",
    columns: { todo: 22, inProgress: 23, inReview: 34, blocked: 35, done: 24, canceled: 25 },
  });
  return { t, calls };
};

test("setting a phase writes the option and the time; clearing writes an empty list and null", async () => {
  const { t, calls } = tracker();
  t.setLoopFields(fieldsOf(fields()));
  const at = new Date("2026-11-26T01:02:03Z");
  await t.setLoopPhase(issue(), "qa", at);
  await t.setLoopPhase(issue(), null, at);
  expect(calls.map((c) => c.arguments)).toEqual([
    { issueId: 1, fieldId: 7, optionIds: [102] },
    { issueId: 1, fieldId: 8, value: "2026-11-26T01:02:03.000Z" },
    { issueId: 1, fieldId: 7, optionIds: [] },
    { issueId: 1, fieldId: 8, value: null },
  ]);
});

test("without resolved fields nothing is written", async () => {
  const { t, calls } = tracker();
  await t.setLoopPhase(issue(), "dev", new Date());
  expect(calls).toEqual([]);
});

test("a field of the wrong type is not taken", () => {
  const bad = fields();
  (bad.data[1] as { fieldType: string }).fieldType = "text";
  expect(fieldsOf(bad)).toBeNull();
  expect(fieldsOf({ data: [{ ...bad.data[0], id: null }, bad.data[1]] })).toBeNull();
});

test("a field scoped to one issue type, or a name that matches twice, is not taken", () => {
  const scoped = fields();
  (scoped.data[1] as { issueTypeId?: number }).issueTypeId = 3;
  expect(fieldsOf(scoped)).toBeNull();
  const twice = fields();
  twice.data.push({ ...(twice.data[1] as object) } as never);
  expect(fieldsOf(twice)).toBeNull();
});

test("a problem is named so the warning can say what is wrong", () => {
  const bad = fields();
  (bad.data[1] as { fieldType: string }).fieldType = "text";
  expect(resolveLoopFields(bad)).toEqual({
    problem: "「Loop 阶段开始于」 must be a datetime field",
  });
  expect(resolveLoopFields(fields({ options: names.slice(0, 5) }))).toEqual({
    problem: "「Loop 阶段」 has no option 「等合并」",
  });
});

test("the fields are read and written by the tools' own names, or through execute_* where the catalog is trimmed", async () => {
  for (const catalog of ["full", "trimmed"] as const) {
    const { t, calls } = tracker(catalog);
    await t.getCustomFields();
    t.setLoopFields(fieldsOf(fields()));
    await t.setLoopPhase(issue(), "dev", new Date("2026-11-26T01:02:03Z"));
    expect(calls.map((c) => c.name)).toEqual([
      "list_custom_fields",
      "set_issue_field_value",
      "set_issue_field_value",
    ]);
  }
});

const allNames = [...names, "调研", "调研 QA"];

test("the two research options are optional: without them the six phases still resolve", () => {
  expect(fieldsOf(fields({ options: allNames }))?.optionIds).toEqual({
    dev: 100,
    verify: 101,
    qa: 102,
    ci: 103,
    review: 104,
    merge: 105,
    research: 106,
    researchQa: 107,
  });
  expect(fieldsOf(fields({ options: [...names, "调研"] }))?.optionIds).toEqual({
    dev: 100,
    verify: 101,
    qa: 102,
    ci: 103,
    review: 104,
    merge: 105,
    research: 106,
  });
  // The six stay required even when the research options are there.
  expect(resolveLoopFields(fields({ options: ["调研", "调研 QA", ...names.slice(1)] }))).toEqual({
    problem: "「Loop 阶段」 has no option 「开发」",
  });
});

test("a research phase whose option is missing writes nothing; one that is there is written", async () => {
  const { t, calls } = tracker();
  t.setLoopFields(fieldsOf(fields()));
  await t.setLoopPhase(issue(), "research", new Date("2026-11-26T01:02:03Z"));
  expect(calls).toEqual([]);
  t.setLoopFields(fieldsOf(fields({ options: allNames })));
  await t.setLoopPhase(issue(), "researchQa", new Date("2026-11-26T01:02:03Z"));
  expect(calls.map((c) => c.arguments)).toEqual([
    { issueId: 1, fieldId: 7, optionIds: [107] },
    { issueId: 1, fieldId: 8, value: "2026-11-26T01:02:03.000Z" },
  ]);
});

// Replies in itsaplan's shape, `{ ok, status, data }` (list_documents as read from infra.CYC, trimmed).
const replies = {
  list_documents: {
    ok: true,
    status: 200,
    data: [
      { id: 10, projectId: 5, parentId: null, title: "调研", archivedAt: null },
      { id: 11, projectId: 5, parentId: 10, title: "CYC-121 调研", archivedAt: null },
    ],
  },
  create_document: { ok: true, status: 201, data: { id: 41, parentId: 10, title: "CYC-445 t" } },
  create_issue: {
    ok: true,
    status: 201,
    data: { id: 900, sequenceNumber: 460, identifier: "CYC-460", parentId: 5 },
  },
};

test("the tracker writes call their tools with the right arguments, through execute_* when the catalog is trimmed", async () => {
  for (const catalog of ["full", "trimmed"] as const) {
    const { t, calls } = tracker(catalog, replies);
    const research = issue({ id: 827, number: 445, key: "CYC-445" });
    expect(await t.listDocuments()).toEqual([
      { id: 10, title: "调研", parentId: null },
      { id: 11, title: "CYC-121 调研", parentId: 10 },
    ]);
    expect(await t.createDocument(10, "CYC-445 t", "# report")).toEqual({ id: 41 });
    await t.linkDocument(research, 41);
    await t.setDescription(research, "## 结论\n\nsummary");
    expect(
      await t.createIssue({ typeId: 20, title: "f", description: "d", columnId: 21, parentId: 5 }),
    ).toEqual({ id: 900, number: 460 });
    await t.createIssue({ typeId: 25, title: "b", description: "d", columnId: 21, parentId: null });
    await t.linkIssues(research, 900, "relates");
    const read = catalog === "trimmed" ? "execute_read" : null;
    const write = catalog === "trimmed" ? "execute_write" : null;
    expect(calls).toEqual([
      { name: "list_documents", arguments: { projectKey: "CYC" }, via: read },
      {
        name: "create_document",
        arguments: { projectKey: "CYC", parentId: 10, title: "CYC-445 t", content: "# report" },
        via: write,
      },
      {
        name: "link_document_issue",
        arguments: { projectKey: "CYC", documentId: 41, issueId: 827 },
        via: write,
      },
      {
        name: "update_issue",
        arguments: { issueId: 827, description: "## 结论\n\nsummary" },
        via: write,
      },
      {
        name: "create_issue",
        arguments: {
          projectKey: "CYC",
          typeId: 20,
          title: "f",
          description: "d",
          columnId: 21,
          parentId: 5,
        },
        via: write,
      },
      {
        name: "create_issue",
        arguments: { projectKey: "CYC", typeId: 25, title: "b", description: "d", columnId: 21 },
        via: write,
      },
      {
        name: "link_issues",
        arguments: { issueId: 827, targetIssueId: 900, kind: "relates" },
        via: write,
      },
    ]);
  }
});

test("move to done uses the Done column", async () => {
  const { t, calls } = tracker();
  await t.move(issue({ id: 827 }), "done");
  expect(calls).toEqual([
    { name: "update_issue", arguments: { issueId: 827, columnId: 24 }, via: null },
  ]);
});

test("a create whose reply has no id fails rather than returning a made-up one", async () => {
  const doc = tracker("full", { create_document: { ok: true, data: {} } });
  await expect(doc.t.createDocument(10, "t", "c")).rejects.toThrow("create_document: no id");
  const created = tracker("full", { create_issue: { ok: true, data: { id: 3 } } });
  await expect(
    created.t.createIssue({ typeId: 1, title: "t", description: "", columnId: 1, parentId: null }),
  ).rejects.toThrow("no sequenceNumber");
});

test("toIssue reads parentId, from the field or from the parent object", () => {
  const base = { id: 827, sequenceNumber: 445, columnId: 22, subtasks: [], links: [] };
  expect(toIssue({ ...base, parentId: 5, parent: { id: 5 } }, "CYC").parentId).toBe(5);
  expect(toIssue({ ...base, parent: { id: 6 } }, "CYC").parentId).toBe(6);
  expect(toIssue({ ...base, parentId: null, parent: null }, "CYC").parentId).toBeNull();
});

test("toIssue reads the parent's number and title and the links' keys and titles, when the reply has them", () => {
  const base = { id: 824, sequenceNumber: 443, columnId: 22, subtasks: [] };
  const read = toIssue(
    {
      ...base,
      parentId: 759,
      parent: { id: 759, sequenceNumber: 381, title: "Loop 页面" },
      links: [
        {
          kind: "blocks",
          direction: "inward",
          issue: { id: 812, sequenceNumber: 431, title: "看板改版" },
        },
        { kind: "relates", direction: "outward", issue: { id: 9 } },
      ],
    },
    "CYC",
  );
  expect(read.parent).toEqual({ number: 381, key: "CYC-381", title: "Loop 页面" });
  expect(read.links).toEqual([
    { kind: "blocks", direction: "inward", key: "CYC-431", title: "看板改版" },
  ]);
  expect(read.blockerColumnIds).toEqual([-1]);
  const bare = toIssue({ ...base, parent: { id: 5 } }, "CYC");
  expect("parent" in bare).toBe(false);
  expect("links" in bare).toBe(false);
});

// The planning node's operations (CYC-322).
const raw = (over: Record<string, unknown> = {}) => ({
  id: 827,
  sequenceNumber: 445,
  columnId: 21,
  labelIds: [6, 40],
  subtasks: [],
  links: [],
  ...over,
});

test("the planning writes call update_issue, create_issue and link_issues with the right arguments", async () => {
  for (const catalog of ["full", "trimmed"] as const) {
    const { t, calls } = tracker(catalog, replies);
    const item = issue({ id: 827, number: 445, key: "CYC-445" });
    await t.setTitle(item, "new title");
    await t.setType(item, 17);
    await t.setPriority(item, "high");
    await t.setPriority(item, null);
    expect(
      await t.createIssue({
        typeId: 20,
        title: "split",
        description: "d",
        columnId: 21,
        parentId: 827,
        priority: "low",
      }),
    ).toEqual({ id: 900, number: 460 });
    await t.linkIssues(item, 900, "blocks");
    const write = catalog === "trimmed" ? "execute_write" : null;
    expect(calls).toEqual([
      { name: "update_issue", arguments: { issueId: 827, title: "new title" }, via: write },
      { name: "update_issue", arguments: { issueId: 827, typeId: 17 }, via: write },
      { name: "update_issue", arguments: { issueId: 827, priority: "high" }, via: write },
      { name: "update_issue", arguments: { issueId: 827, priority: null }, via: write },
      {
        name: "create_issue",
        arguments: {
          projectKey: "CYC",
          typeId: 20,
          title: "split",
          description: "d",
          columnId: 21,
          parentId: 827,
          priority: "low",
        },
        via: write,
      },
      {
        name: "link_issues",
        arguments: { issueId: 827, targetIssueId: 900, kind: "blocks" },
        via: write,
      },
    ]);
  }
});

test("adding or removing one label re-reads the labels and keeps the others; no change writes nothing", async () => {
  // The tracker now has 6, 40 and 11 (a person put `auto` on since the issue was read with only 6).
  const now = { ok: true, data: raw({ labelIds: [6, 40, 11] }) };
  const { t, calls } = tracker("full", { get_issue_by_number: now });
  const stale = issue({ id: 827, number: 445, key: "CYC-445", labelIds: [6] });
  await t.addLabel(stale, 41);
  await t.removeLabel(stale, 40);
  await t.addLabel(stale, 40);
  await t.removeLabel(stale, 99);
  const writes = calls.filter((c) => c.name === "update_issue").map((c) => c.arguments);
  expect(writes).toEqual([
    { issueId: 827, labelIds: [6, 40, 11, 41] },
    { issueId: 827, labelIds: [6, 11] },
  ]);
  expect(calls.filter((c) => c.name === "get_issue_by_number")).toHaveLength(4);
  expect(calls[0]?.arguments).toEqual({ projectKey: "CYC", sequenceNumber: 445 });
});

test("the Backlog is listed by its column and read in full; unset or a full page is an error", async () => {
  const list = { ok: true, data: [{ sequenceNumber: 445 }, { sequenceNumber: 446 }] };
  const { t, calls } = tracker("full", {
    list_issues: list,
    get_issue_by_number: (args: { sequenceNumber: number }) => ({
      ok: true,
      data: raw({ id: args.sequenceNumber + 400, sequenceNumber: args.sequenceNumber }),
    }),
  });
  await expect(t.listBacklog()).rejects.toThrow("Backlog column is not resolved");
  t.setBacklogColumn(21);
  expect((await t.listBacklog()).map((i) => i.key)).toEqual(["CYC-445", "CYC-446"]);
  expect(calls.find((c) => c.name === "list_issues")?.arguments).toEqual({
    projectKey: "CYC",
    columnId: 21,
    limit: 500,
  });
  // Todo is unchanged.
  await t.listTodo();
  expect(calls.filter((c) => c.name === "list_issues")[1]?.arguments).toEqual({
    projectKey: "CYC",
    columnId: 22,
    limit: 100,
  });
  const full = tracker("full", {
    list_issues: { ok: true, data: Array.from({ length: 500 }, () => ({ sequenceNumber: 1 })) },
    get_issue_by_number: { ok: true, data: raw() },
  });
  full.t.setBacklogColumn(21);
  await expect(full.t.listBacklog()).rejects.toThrow("500 or more");
});

test("the Backlog's rows are one list_issues call, with no get per issue", async () => {
  // As list_issues returns them in infra.CYC (2026-11-26), trimmed.
  const row = {
    id: 787,
    sequenceNumber: 409,
    title: "Loop 页面：在工单详情页补充运行工作流进度与关键运行信息",
    columnId: 21,
    typeId: 20,
    labelIds: [5, 6, 12],
    updatedAt: "2026-11-26T06:08:07.007Z",
    statusSince: "2026-11-25T23:25:00.633Z",
  };
  const { t, calls } = tracker("full", { list_issues: { ok: true, data: [row] } });
  await expect(t.listBacklogRows()).rejects.toThrow("Backlog column is not resolved");
  t.setBacklogColumn(21);
  expect(await t.listBacklogRows()).toEqual([
    {
      id: 787,
      key: "CYC-409",
      number: 409,
      title: row.title,
      typeId: 20,
      labelIds: [5, 6, 12],
      columnId: 21,
      updatedAt: "2026-11-26T06:08:07.007Z",
    },
  ]);
  expect(calls.map((c) => c.name)).toEqual(["list_issues"]);
  expect(calls[0]?.arguments).toEqual({ projectKey: "CYC", columnId: 21, limit: 500 });
});

// `list_issue_activity` with filter `comments`, as read from infra.CYC (CYC-334), trimmed.
const comment = (id: number, createdAt: string, over: Record<string, unknown> = {}) => ({
  id,
  issueId: 827,
  kind: "comment",
  replyToId: null,
  actorUserId: "u1",
  actorName: "姚峰",
  body: `c${id}`,
  action: null,
  payload: {},
  createdAt,
  editedAt: null,
  reactions: [],
  ...over,
});

test("comments come from list_issue_activity, every page, replies flattened in, oldest first", async () => {
  for (const catalog of ["full", "trimmed"] as const) {
    const pages: Record<string, unknown> = {
      first: {
        ok: true,
        data: {
          items: [
            comment(1, "2026-11-25T01:00:00.000Z", {
              replies: [comment(4, "2026-11-25T04:00:00.000Z", { replyToId: 1 })],
            }),
            comment(2, "2026-11-25T02:00:00.000Z"),
          ],
          nextCursor: "p2",
        },
      },
      p2: {
        ok: true,
        data: { items: [comment(3, "2026-11-25T03:00:00.000Z")], nextCursor: null },
      },
    };
    const { t, calls } = tracker(catalog, {
      list_issue_activity: (args: { cursor?: string }) => pages[args.cursor ?? "first"],
    });
    const found = await t.listComments(issue({ id: 827, key: "CYC-445" }));
    expect(found.map((c) => [c.id, c.replyToId])).toEqual([
      [1, null],
      [2, null],
      [3, null],
      [4, 1],
    ]);
    expect(found[0]).toEqual({
      id: 1,
      replyToId: null,
      authorId: "u1",
      authorName: "姚峰",
      body: "c1",
      createdAt: "2026-11-25T01:00:00.000Z",
    });
    const read = catalog === "trimmed" ? "execute_read" : null;
    expect(calls).toEqual([
      {
        name: "list_issue_activity",
        arguments: { issueId: 827, filter: "comments", order: "asc", limit: 100 },
        via: read,
      },
      {
        name: "list_issue_activity",
        arguments: { issueId: 827, filter: "comments", order: "asc", limit: 100, cursor: "p2" },
        via: read,
      },
    ]);
  }
  const odd = tracker("full", { list_issue_activity: { ok: true, data: {} } });
  await expect(odd.t.listComments(issue())).rejects.toThrow("unrecognized list_issue_activity");
});

const planning = {
  labels: { pending: 40, awaitingAnswer: 41, skip: 42, fullProcess: null },
  backlogColumn: 21,
  epicTypeId: 17,
  templates: { feature: "f", bug: "b" },
  maxPending: 5,
  intervalMinutes: 30,
  maxSplit: 4,
};
const planningConfig = { ...config(), planning };

test("the planning tracker binds its two labels, Epic, Backlog and the Feature and Bug types", async () => {
  const item = issue({ id: 5, number: 5, key: "CYC-5", columnId: 21, labelIds: [6] });
  const fake = new FakeTracker([item]);
  const p = planningTracker(fake, planningConfig);
  await p.markPending(item);
  await p.markAwaitingAnswer(item);
  expect(item.labelIds).toEqual([6, 40, 41]);
  await p.unmarkAwaitingAnswer(item);
  await p.unmarkPending(item);
  expect(item.labelIds).toEqual([6]);
  await p.makeEpic(item);
  expect(item.typeId).toBe(17);
  await p.setPriority(item, "urgent");
  await p.setTitle(item, "t2");
  expect([item.priority, item.title]).toEqual(["urgent", "t2"]);
  const bug = await p.createIssue({
    kind: "Bug",
    title: "b",
    description: "d",
    parentId: 5,
    priority: "high",
  });
  const feature = await p.createIssue({
    kind: "Feature",
    title: "f",
    description: "d",
    parentId: 5,
    priority: "low",
  });
  const created = fake.issues.filter((i) => i.parentId === 5);
  expect(created.map((i) => [i.number, i.typeId, i.columnId, i.priority, i.labelIds])).toEqual([
    [bug.number, 25, 21, "high", []],
    [feature.number, 20, 21, "low", []],
  ]);
  await p.linkBlocks(item, bug.id);
  expect(fake.issueLinks).toEqual([`CYC-5:blocks:${bug.id}`]);
  expect((await p.listBacklog()).map((i) => i.key)).toEqual(["CYC-5", "CYC-6", "CYC-7"]);
  expect(fake.moves).toEqual([]);
});

// The planner cannot move a work item or put on any other label: the type has no method for it. Checked by the
// compiler (`Lacks` of a key the type has is `false`, and `true satisfies false` does not compile) and at run time.
type Lacks<K extends PropertyKey> = K extends keyof PlanningTracker ? false : true;
const lacks = {
  move: true satisfies Lacks<"move">,
  addLabel: true satisfies Lacks<"addLabel">,
  removeLabel: true satisfies Lacks<"removeLabel">,
  setType: true satisfies Lacks<"setType">,
  linkIssues: true satisfies Lacks<"linkIssues">,
  setLoopPhase: true satisfies Lacks<"setLoopPhase">,
  markSkip: true satisfies Lacks<"markSkip">,
};

test("the planning tracker has no move, no generic label, type or link, and nothing for auto or skip", () => {
  const p = planningTracker(new FakeTracker([]), planningConfig);
  for (const name of Object.keys(lacks)) expect(name in p).toBe(false);
  expect(Object.keys(p).sort()).toEqual([
    "comment",
    "createIssue",
    "get",
    "linkBlocks",
    "listBacklog",
    "listBacklogRows",
    "listComments",
    "listInProgress",
    "listTodo",
    "makeEpic",
    "markAwaitingAnswer",
    "markPending",
    "setDescription",
    "setPriority",
    "setTitle",
    "unmarkAwaitingAnswer",
    "unmarkPending",
  ]);
});
