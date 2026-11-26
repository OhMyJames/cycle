import {
  type Config,
  type DocumentEntry,
  defaultConfig,
  type Exec,
  type ExecResult,
  type Issue,
  type IssueComment,
  type NewIssue,
  type Priority,
  type SessionRole,
  type Sessions,
  type Stage,
  type Tracker,
  type TurnResult,
} from "../src/types.ts";

export const WT = "/wt/auto/cyc-1";
export const CHECKED = "What I checked:\n- read a.ts\n- ran git diff\n";
export const PASS = `${CHECKED}<verdict>{"pass":true,"findings":[]}</verdict>`;

export const REVIEW_MERGE = `${CHECKED}<review>{"decision":"merge","summary":"looks safe to auto-merge","reasons":["scoped to work item","tests cover the behavior"]}</review>`;

export const issue = (over: Partial<Issue> = {}): Issue => ({
  id: 1,
  number: 1,
  key: "CYC-1",
  title: "title",
  description: "",
  priority: "medium",
  createdAt: "2026-11-25T00:00:00.000Z",
  columnId: 22,
  labelIds: [11],
  typeId: 20,
  subtaskCount: 0,
  blockerColumnIds: [],
  parentId: null,
  ...over,
});

export const config = (over: Partial<Config> = {}): Config => ({
  ...defaultConfig({
    repoRoot: "/repo",
    stateDir: "/state",
    columns: { todo: 22, inProgress: 23, inReview: 34, blocked: 35, done: 24, canceled: 25 },
    autoLabelId: 11,
    allowedTypeIds: [20, 25],
    featureTypeId: 20,
    bugTypeId: 25,
  }),
  ...over,
});

/** A work item that passes the preflight. */
export const readyDescription = `## 背景与证据
x

## 范围
x

## 非目标
x

## 涉及面
x

## 验收标准

1. 开关可用。验证：\`bun test tools/auto-loop/test/a.test.ts\`
2. 门禁通过。验证：\`bun run check\`
`;

export const fullBug = `## 现象
x

## 复现步骤
x

## 预期与实际
x

## 环境与版本
x

## 严重度
x

## 验收标准

1. 好。验证：\`bun run check\`
`;

export const done = (text = "<progress>done: x\nnext: y</progress>"): TurnResult => ({
  stopReason: "end_turn",
  text,
  timedOut: false,
});

export class FakeTracker implements Tracker {
  moves: string[] = [];
  comments: string[] = [];
  /** `KEY:phase` per write, `KEY:clear` per clear. */
  phases: string[] = [];
  failPhase = false;
  /** A test can hold `listTodo`, `get` and `move` open until it releases them. */
  gates: { listTodo?: Promise<void>; get?: Promise<void>; move?: Promise<void> } = {};
  constructor(public issues: Issue[]) {}
  async listTodo() {
    const snapshot = this.issues.filter((i) => i.columnId === 22);
    await this.gates.listTodo;
    return snapshot;
  }
  async get(number: number) {
    await this.gates.get;
    const found = this.issues.find((i) => i.number === number);
    if (!found) throw new Error("no issue");
    return found;
  }
  async move(i: Issue, stage: Stage) {
    await this.gates.move;
    this.moves.push(`${i.key}:${stage}`);
    const col = { todo: 22, inProgress: 23, inReview: 34, blocked: 35, done: 24 }[stage];
    const found = this.issues.find((x) => x.number === i.number);
    if (found) found.columnId = col;
  }
  async comment(i: Issue, text: string) {
    this.comments.push(`${i.key}:${text}`);
  }
  async setLoopPhase(i: Issue, phase: string | null, _at?: Date, _signal?: AbortSignal) {
    if (this.failPhase) throw new Error("field write failed");
    this.phases.push(`${i.key}:${phase ?? "clear"}`);
  }
  documents: DocumentEntry[] = [{ id: 10, title: "调研", parentId: null }];
  /** Every document written, with its content. */
  written: { id: number; parentId: number; title: string; content: string }[] = [];
  /** `KEY:docId` per link. */
  docLinks: string[] = [];
  /** `KEY:relates:toId` per link. */
  issueLinks: string[] = [];
  async listDocuments() {
    return this.documents;
  }
  async createDocument(parentId: number, title: string, content: string) {
    const id = 1000 + this.written.length;
    this.written.push({ id, parentId, title, content });
    this.documents.push({ id, title, parentId });
    return { id };
  }
  async linkDocument(i: Issue, docId: number) {
    this.docLinks.push(`${i.key}:${docId}`);
  }
  async setDescription(i: Issue, description: string) {
    const found = this.issues.find((x) => x.number === i.number);
    if (!found) throw new Error("no issue");
    found.description = description;
  }
  async createIssue(input: NewIssue) {
    const number = Math.max(0, ...this.issues.map((i) => i.number)) + 1;
    const created = issue({
      id: 2000 + number,
      number,
      key: `CYC-${number}`,
      title: input.title,
      description: input.description,
      priority: input.priority ?? null,
      columnId: input.columnId,
      labelIds: [],
      typeId: input.typeId,
      parentId: input.parentId,
    });
    this.issues.push(created);
    return { id: created.id, number };
  }
  async linkIssues(i: Issue, toId: number, kind: "relates" | "blocks") {
    this.issueLinks.push(`${i.key}:${kind}:${toId}`);
  }
  /** Comments by issue key, oldest first. */
  threads: Record<string, IssueComment[]> = {};
  async listBacklog() {
    return this.issues.filter((i) => i.columnId === 21);
  }
  async listInProgress() {
    return this.issues.filter((i) => i.columnId === 23);
  }
  async listComments(i: Issue) {
    return this.threads[i.key] ?? [];
  }
  #found(i: Issue): Issue {
    const found = this.issues.find((x) => x.number === i.number);
    if (!found) throw new Error("no issue");
    return found;
  }
  async setTitle(i: Issue, title: string) {
    this.#found(i).title = title;
  }
  async setType(i: Issue, typeId: number) {
    this.#found(i).typeId = typeId;
  }
  async setPriority(i: Issue, priority: Priority | null) {
    this.#found(i).priority = priority;
  }
  async addLabel(i: Issue, labelId: number) {
    const found = this.#found(i);
    if (!found.labelIds.includes(labelId)) found.labelIds = [...found.labelIds, labelId];
  }
  async removeLabel(i: Issue, labelId: number) {
    const found = this.#found(i);
    found.labelIds = found.labelIds.filter((id) => id !== labelId);
  }
}

export type Script = {
  dev: (TurnResult | Error)[];
  qa: (TurnResult | Error)[];
  review?: (TurnResult | Error)[];
  research?: (TurnResult | Error)[];
  research_qa?: (TurnResult | Error)[];
  triage?: (TurnResult | Error)[];
  shape?: (TurnResult | Error)[];
  shape_qa?: (TurnResult | Error)[];
  /** Either a persistent error for every create of this role, or a per-attempt queue (null = succeed). */
  createError?: Partial<Record<SessionRole, Error | (Error | null)[]>>;
};

export class FakeSessions implements Sessions {
  created: string[] = [];
  inputs: { role: SessionRole; model: string | undefined; effort: string | undefined }[] = [];
  turns: string[] = [];
  prompts: { sessionId: string; role: SessionRole; prompt: string; readRoots?: string[] }[] = [];
  deleted = 0;
  readonly script: {
    dev: (TurnResult | Error)[];
    qa: (TurnResult | Error)[];
    review: (TurnResult | Error)[];
    research: (TurnResult | Error)[];
    research_qa: (TurnResult | Error)[];
    triage: (TurnResult | Error)[];
    shape: (TurnResult | Error)[];
    shape_qa: (TurnResult | Error)[];
    createError: Partial<Record<SessionRole, Error | (Error | null)[]>>;
  };
  constructor(script: Script) {
    const createError: Partial<Record<SessionRole, Error | (Error | null)[]>> = {};
    for (const [role, entry] of Object.entries(script.createError ?? {})) {
      createError[role as SessionRole] = Array.isArray(entry) ? [...entry] : entry;
    }
    this.script = {
      dev: [...script.dev],
      qa: [...script.qa],
      review: script.review !== undefined ? [...script.review] : [done(REVIEW_MERGE)],
      research: [...(script.research ?? [])],
      research_qa: [...(script.research_qa ?? [])],
      triage: [...(script.triage ?? [])],
      shape: [...(script.shape ?? [])],
      shape_qa: [...(script.shape_qa ?? [])],
      createError,
    };
  }
  async create(input: { role: SessionRole; cwd: string; model?: string; effort?: string }) {
    this.inputs.push({ role: input.role, model: input.model, effort: input.effort });
    const err = this.script.createError[input.role];
    if (Array.isArray(err)) {
      const next = err.shift();
      if (next instanceof Error) throw next;
    } else if (err !== undefined) {
      throw err;
    }
    const id = `${input.role}-${this.created.length + 1}`;
    this.created.push(id);
    return {
      sessionId: id,
      cwd: input.role === "dev" || input.role === "research" ? WT : input.cwd,
      branch: "worktree-auto/cyc-1",
    };
  }
  async turn(sessionId: string, prompt: string, ctx: { role: SessionRole; readRoots?: string[] }) {
    this.turns.push(`${sessionId}: ${prompt.slice(0, 30)}`);
    this.prompts.push({
      sessionId,
      role: ctx.role,
      prompt,
      ...(ctx.readRoots !== undefined ? { readRoots: ctx.readRoots } : {}),
    });
    const next = this.script[ctx.role].shift();
    if (next === undefined) throw new Error(`no scripted ${ctx.role} turn`);
    if (next instanceof Error) throw next;
    return next;
  }
}

export type CiCheckStub = {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl?: string;
};

export type CiResponse = {
  headRefOid: string;
  statusCheckRollup: CiCheckStub[];
};

export const greenCi = (headRefOid = "abc"): CiResponse => ({
  headRefOid,
  statusCheckRollup: [
    {
      name: "check",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      detailsUrl: "https://github.com/o/r/actions/runs/10/job/101",
    },
    {
      name: "browser",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      detailsUrl: "https://github.com/o/r/actions/runs/10/job/102",
    },
    {
      name: "integration",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      detailsUrl: "https://github.com/o/r/actions/runs/10/job/103",
    },
  ],
});

export type World = {
  fail: Set<string>;
  calls: string[];
  dirty: boolean;
  qaWrites: boolean;
  headSha: string;
  ciResponses: CiResponse[];
  ciLogs: Record<string, string>;
  /** What `gh pr view --json state` says; an array is consumed one read at a time (last one sticks). */
  prState: string | string[];
  /** What `gh pr view --json state,mergeable` says after auto-merge is enabled, as [state, mergeable] (last sticks). */
  prMerge: [string, string][];
  mergeTreeOutput: string;
  /** What `git ls-files --others --ignored --directory` prints: the ignored directories in the worktree. */
  ignoredDirs: string;
  /** When set, every `git fetch` logs start/end here and takes a few ms. */
  fetchLog?: string[];
  /** Whether auto-merge is on for the PR (`--json autoMergeRequest`); `--auto` turns it on, `--disable-auto` off. */
  autoMerge?: boolean;
};

export const makeExec =
  (world: World): Exec =>
  async (argv) => {
    const line = argv.filter((a) => a !== "-c" && !a.startsWith("core.")).join(" ");
    world.calls.push(line);
    const result = (output: string, code = 0): ExecResult => ({ code, output, timedOut: false });
    if (line.includes("diff --name-only")) return result("packages/client/src/a.ts\n");
    if (line.includes("status --porcelain")) return result(world.dirty ? " M a.ts\n" : "");
    if (line.includes("ls-files -z --others --ignored"))
      return result(world.ignoredDirs.split("\n").filter(Boolean).join("\0"));
    if (line.includes("rev-parse HEAD")) return result(`${world.headSha}\n`);
    if (world.fetchLog && / fetch /.test(` ${line} `)) {
      world.fetchLog.push("start");
      await Bun.sleep(20);
      world.fetchLog.push("end");
      return result("");
    }
    for (const pattern of world.fail) if (line.includes(pattern)) return result("boom", 1);
    if (line.includes("gh pr merge") && line.includes("--disable-auto")) world.autoMerge = false;
    if (line.includes("gh pr merge") && line.includes("--auto")) world.autoMerge = true;
    if (line.includes("gh pr view") && line.includes("autoMergeRequest")) {
      return result(
        JSON.stringify({ autoMergeRequest: world.autoMerge ? { mergeMethod: "SQUASH" } : null }),
      );
    }
    if (line.includes("gh pr create")) return result("https://github.com/o/r/pull/9\n");
    if (line.includes("gh pr view") && line.includes("state,mergeable")) {
      const [state, mergeable] =
        (world.prMerge.length > 1 ? world.prMerge.shift() : world.prMerge[0]) ?? [];
      return result(JSON.stringify({ state, mergeable }));
    }
    if (line.includes("merge-tree")) return result(world.mergeTreeOutput, 1);
    if (line.includes("gh pr view") && line.includes("--json state")) {
      const state = Array.isArray(world.prState)
        ? world.prState.length > 1
          ? world.prState.shift()
          : world.prState[0]
        : world.prState;
      return result(JSON.stringify({ state }));
    }
    if (line.includes("gh pr view") && line.includes("statusCheckRollup")) {
      const next = world.ciResponses.shift() ?? greenCi(world.headSha);
      return result(JSON.stringify(next));
    }
    if (line.includes("gh run view")) {
      const jobIdx = argv.indexOf("--job");
      const key = jobIdx !== -1 ? (argv[jobIdx + 1] ?? "") : (argv[3] ?? "");
      return result(world.ciLogs[key] ?? "generic CI failure log\n");
    }
    if (line.includes("gh pr view")) return result("https://github.com/o/r/pull/9\n");
    // `bun test <path>` is judged on its summary line too, so the fake prints a real one.
    if (argv[0] === "bun" && argv[1] === "test") return result(" 3 pass\n 0 fail\n");
    return result("");
  };
