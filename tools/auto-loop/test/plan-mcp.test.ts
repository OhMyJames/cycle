import { afterEach, expect, test } from "bun:test";
import { PlanTracker, toIssue } from "../src/plan-mcp.ts";
import { resolveLoopFields } from "../src/project.ts";
import { issue } from "./helpers.ts";

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
// a tool's reply by its own name; anything else replies `{"ok":true}`.
const tracker = (catalog: "full" | "trimmed" = "full", replies: Record<string, unknown> = {}) => {
  const calls: { name: string; arguments: Record<string, unknown>; via: string | null }[] = [];
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const { name, arguments: args } = JSON.parse(init.body).params;
    const wrapped = name === "execute_read" || name === "execute_write";
    if (wrapped === (catalog === "full"))
      return new Response(
        JSON.stringify({
          result: { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] },
        }),
      );
    const call = wrapped ? { ...args, via: name } : { name, arguments: args, via: null };
    calls.push(call);
    const reply = replies[call.name] ?? { ok: true };
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
