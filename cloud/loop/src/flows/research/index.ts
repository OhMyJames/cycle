// The research flow (CYC-447): a Research work item, answered by a read-only session and published by the loop.
//
// claimed → research → research_qa → publishing → done, as a one-node Task Graph (CYC-545): a `research` node, then
// `qa-n` nodes, and a `fix-n` research node (a new session) after each QA that does not pass. The sessions only read;
// the loop checks the reply, has it judged, and publishes it. There is no install, no commit, no push and no pull request.

import type { StoreOps } from "../../db/store.ts";
import type { Save, StepResult } from "../../engine/flow.ts";
import {
  type Accepted,
  type BlockArgs,
  Blocked,
  branchOf,
  type Flow,
  type FlowHost,
  type Opening,
  type Phase,
  type PhaseDef,
  tail,
} from "../../engine/flow.ts";
import { writeIntent } from "../../engine/reconcile.ts";
import {
  appendFixNode,
  appendQaNode,
  buildGraph,
  type TaskGraph,
  type TaskNode,
  updateGraphNode,
} from "../../graph.ts";
import { conclusionIsEmpty } from "../../preflight.ts";
import {
  formatFindings,
  researchBrief,
  researchContinueBrief,
  researchFixBrief,
  researchQaBrief,
  researchReworkNote,
} from "../../prompts/index.ts";
import { findSecrets } from "../../secrets.ts";
import { type ResearchState, type RunRecord, researchOf } from "../../store.ts";
import { type Config, type Issue, SessionLost, type TurnResult } from "../../types.ts";
import { judge, newQaSession, nextRound } from "../dev/qa.ts";
import { blockTicket, tellTicket, ticketStillMine, ticketStillWanted } from "../ticket.ts";
import { checkResearch, parseResearch, replaceConclusion } from "./output.ts";

export class ResearchFlow implements Flow {
  readonly kind = "research";
  readonly #host: FlowHost;
  readonly phases: Partial<Record<Phase, PhaseDef>>;
  readonly firstPhase = "research";
  readonly qa: Flow["qa"];

  constructor(host: FlowHost) {
    this.#host = host;
    this.phases = {
      // A research run that has just been claimed already shows 调研, not 开发.
      claimed: { field: "research", step: ({ run, issue, save }) => this.#claim(run, issue, save) },
      research: {
        field: "research",
        step: ({ run, issue, announce, save }) => this.#research(run, issue, announce, save),
        announces: true,
      },
      research_qa: {
        field: "researchQa",
        step: ({ run, issue, save }) => this.#researchQa(run, issue, save),
      },
      publishing: {
        field: "researchQa",
        step: ({ run, issue, save }) => this.#publish(run, issue, save),
      },
    };
    this.qa = {
      role: "research_qa",
      title: (key) => `[${key}] Research QA`,
      subject: "调研内容",
      readRoots: (config) => host.need(config.research ?? undefined).readRoots,
    };
  }

  /** Turned off with a run under way: it waits in the state directory until research is on again. */
  enabled(config: Config): boolean {
    return config.research !== null;
  }

  /** A research work item has questions, not criteria: its book is empty, kept so a resume reads it as for any run. */
  open(accepted: Accepted): Opening {
    if (accepted.kind !== "research")
      throw new Error(`a ${accepted.kind} work item is not a research run`);
    return {
      specs: [],
      state: {
        kind: "research",
        research: {
          questions: accepted.questions,
          output: null,
          docId: null,
          docLinked: false,
          conclusionDone: false,
          followups: [],
          commented: false,
        },
      },
      // `runKind` is what `stats` tells the runs apart by (`kind` is taken: it is the event's name).
      claimed: { runKind: "research", questions: accepted.questions.length },
    };
  }

  wouldTake(issue: Issue, accepted: Accepted): StepResult {
    if (accepted.kind !== "research")
      throw new Error(`a ${accepted.kind} work item is not a research run`);
    this.#host.d.log(
      `dry run: would take ${issue.key} (research, ${accepted.questions.length} questions)`,
    );
    return {
      status: "would-take",
      key: issue.key,
      kind: "research",
      questions: accepted.questions.length,
    };
  }

  stillWanted(run: RunRecord) {
    return ticketStillWanted(this.#host, run);
  }

  stillMine(run: RunRecord) {
    return ticketStillMine(this.#host, run);
  }

  /** A person's put-back changes nothing of its own: the record says how far publishing got. */
  async putBack(run: RunRecord): Promise<RunRecord> {
    return run;
  }

  /** Nothing to check again: it goes on from its own phase, and what it has published is in its record. */
  recheck(): Phase | undefined {
    return undefined;
  }

  block(args: BlockArgs) {
    return blockTicket(this.#host, args, {
      firstPhase: "research",
      session: `调研会话「[${args.run.key}] Research」`,
      // A research block can quote what the sessions wrote (QA's findings, draft titles), and the tracker is their
      // only way out: the same check as before publishing, naming the kinds only.
      redact: (said) => {
        const leaked = findSecrets(said);
        return leaked.length > 0
          ? `卡住的原因里有疑似凭据（${leaked.join("、")}），没有贴出原文；详情在调研会话和 QA 会话里。`
          : said;
      },
    });
  }

  /** A research run never had a pull request: its work item in Done is all there is to wait for. */
  async whenDone(): Promise<"remove"> {
    return "remove";
  }

  // ---- phases ----

  async #newSession(
    run: RunRecord,
    issue: Issue,
  ): Promise<{ sessionId: string; cwd: string; branch: string | null }> {
    const { config } = this.#host.d;
    return this.#host.d.sessions.create({
      role: "research",
      run: run.key,
      agent: config.devAgent,
      ...(config.devModel ? { model: config.devModel } : {}),
      ...(config.devEffort ? { effort: config.devEffort } : {}),
      title: `[${run.key}] Research`,
      // The same name again is the worktree that is there: the daemon reuses it, and files the session under it.
      cwd: config.repoRoot,
      worktree: { base: config.baseRef, name: branchOf(issue.number) },
    });
  }

  /** As the dev claim (`Pipeline`'s `#claim`), with a research session, and no `bun install`: nothing is built or run. */
  async #claim(
    run: RunRecord,
    issue: Issue,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<void> {
    const { config } = this.#host.d;
    if (run.devSessionId === null) {
      // A fresh `origin/main` to read: the worktree is made from it.
      const fetched = await this.#host.netExec(run.key, "git fetch", () =>
        this.#host.d.workspace.fetchMain({
          cwd: config.repoRoot,
          timeoutMs: config.commandTimeoutMs,
        }),
      );
      if (fetched.code !== 0) throw new Blocked(`git fetch 失败：${tail(fetched.output)}`);
      const created = await this.#newSession(run, issue);
      await save({
        devSessionId: created.sessionId,
        worktree: created.cwd,
        localBranch: created.branch,
      });
      await this.#host.d.store.event(run.key, "research_session", { new: true });
    }
    await save({ phase: "research" });
    await this.#ensureGraph({ ...run, phase: "research" });
  }

  /**
   * The run's graph. A run begun before research was a graph has none: it is made from the phase it is in, so the
   * rest runs as a new run does (a reply already kept is a finished node, a judged one a passed QA node).
   */
  async #ensureGraph(run: RunRecord): Promise<TaskGraph> {
    const { store, clock } = this.#host.d;
    const existing = await store.loadGraph(run.key);
    if (existing !== undefined) return existing;
    const nowIso = clock.now().toISOString();
    const state = researchOf(run);
    let graph = buildGraph(
      run.key,
      "single",
      [
        {
          id: "research",
          title: "调研",
          goal: `回答工单里要回答的问题：\n${state.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
          dependsOn: [],
          filesHint: [],
          verify: [],
          role: "research",
        },
      ],
      nowIso,
    );
    const beyond = run.phase === "research_qa" || run.phase === "publishing";
    graph = updateGraphNode(
      graph,
      "research",
      beyond
        ? {
            status: "passed",
            sessionId: run.devSessionId,
            summary: state.output?.summary ?? "",
            report: state.output?.report ?? "",
            startedAt: nowIso,
            finishedAt: nowIso,
          }
        : { status: "running", sessionId: run.devSessionId, startedAt: nowIso },
      nowIso,
      beyond ? null : "research",
    );
    if (run.phase === "publishing") {
      const qa = this.#addQaNode(graph, nowIso);
      graph = updateGraphNode(
        qa.graph,
        qa.node.id,
        {
          status: "passed",
          verdict: "pass",
          sessionId: run.qaSessionId,
          startedAt: nowIso,
          finishedAt: nowIso,
        },
        nowIso,
        null,
      );
    }
    await store.saveGraph(graph);
    await store.event(run.key, "graph_built", { phase: run.phase, nodes: graph.nodes.length });
    return graph;
  }

  #addQaNode(graph: TaskGraph, nowIso: string): { graph: TaskGraph; node: TaskNode } {
    const appended = appendQaNode(graph, { commitSha: "", verify: [], nowIso });
    return {
      graph: updateGraphNode(
        appended.graph,
        appended.node.id,
        { goal: "独立验收调研产出" },
        nowIso,
      ),
      node: appended.node,
    };
  }

  /**
   * One research turn. The reply is checked by rule; what fails goes back to the same session as a fix round, what
   * passes is kept as the output to publish and goes to QA. The worktree must be as it was.
   */
  async #research(run: RunRecord, issue: Issue, byPerson: boolean, save: Save): Promise<void> {
    const { config, store, clock } = this.#host.d;
    const bounds = this.#host.need(config.research ?? undefined);
    const state = researchOf(run);
    const worktree = this.#host.need(run.worktree ?? undefined);
    let graph = await this.#ensureGraph(run);
    let node = graph.nodes
      .filter((n) => n.role === "research")
      .find((n) => n.status === "running" || n.status === "blocked" || n.status === "pending");
    if (node === undefined) {
      // The last research node was judged and sent back (or put back after that): a `fix-n` node, a new session,
      // told the report it replaces and what was found wrong with it.
      const nowIso = clock.now().toISOString();
      const appended = appendFixNode(graph, {
        title: "调研返工",
        goal: run.findings ?? "Redo the research.",
        verify: [],
        role: "research",
        nowIso,
      });
      if (!appended.ok) throw new Blocked(appended.reason);
      const created = await this.#newSession(run, issue);
      graph = updateGraphNode(
        appended.graph,
        appended.node.id,
        { status: "running", sessionId: created.sessionId, startedAt: nowIso },
        nowIso,
        appended.node.id,
      );
      const started = graph;
      await save({ devSessionId: created.sessionId }, (tx) => {
        tx.saveGraph(started);
        tx.event(run.key, "graph_fix_added", { nodeId: appended.node.id, round: run.round });
        tx.event(run.key, "research_session", { new: true, nodeId: appended.node.id });
      });
      run = { ...run, devSessionId: created.sessionId };
      node = graph.nodes.find((n) => n.id === appended.node.id) as TaskNode;
    }
    const current = node;
    const rework = current.origin === "fix";
    const previous = graph.nodes.filter((n) => n.role === "research" && n.report !== null).at(-1);
    const brief = () => {
      const first = researchBrief(issue, state.questions, {
        readRoots: bounds.readRoots,
        maxFollowups: bounds.maxFollowups,
        maxCriteria: config.maxCriteria,
      });
      if (rework)
        return `${first}\n\n${researchReworkNote(previous?.report ?? "", run.findings ?? current.goal)}`;
      return run.findings === null
        ? first
        : `${first}\n\nAn earlier reply to this work item was sent back with these findings; do not repeat them:\n${run.findings}`;
    };
    // Which brief is chosen from what is saved: a session that has had no turn yet is given the whole brief.
    const progress = await store.readProgress(run.key);
    const untouched = rework ? current.rounds === 0 && current.lastError === null : progress === "";
    const prompt = untouched
      ? brief()
      : run.findings !== null
        ? researchFixBrief(run.round, run.findings, bounds.maxFollowups)
        : researchContinueBrief(issue, byPerson, bounds.maxFollowups);
    const turnOptions = {
      role: "research" as const,
      worktree,
      timeoutMs: config.turnTimeoutMs,
      readRoots: bounds.readRoots,
    };

    const before = await this.#host.snapshot(worktree);
    let sessionId = this.#host.need(current.sessionId ?? run.devSessionId ?? undefined);
    let result: TurnResult;
    try {
      result = await this.#host.turn(run.key, sessionId, prompt, turnOptions);
    } catch (error) {
      if (!(error instanceof SessionLost)) throw error;
      // Nothing on disk to take over from: a new session starts the research again, told what was sent back.
      const created = await this.#newSession(run, issue);
      const swapped = updateGraphNode(
        graph,
        current.id,
        { sessionId: created.sessionId },
        clock.now().toISOString(),
        current.id,
      );
      await save(
        {
          devSessionId: created.sessionId,
          replacedSessions: [...run.replacedSessions, sessionId],
        },
        (tx) => tx.saveGraph(swapped),
      );
      graph = swapped;
      sessionId = created.sessionId;
      await store.event(run.key, "research_session", { replaced: true });
      result = await this.#host.turn(run.key, sessionId, brief(), turnOptions);
    }
    await store.event(run.key, "research_turn", { round: run.round, stop: result.stopReason });
    // Read-only, kept by a check and not by trust.
    const after = await this.#host.snapshot(worktree);
    if (before !== after)
      throw new Blocked("调研会话修改了工作区（提交或文件状态变了），自动化不信任这次调研结果。");
    this.#host.mustHaveEnded("调研", result);

    const output = parseResearch(result.text);
    const findings = checkResearch(output, state.questions, {
      maxCriteria: config.maxCriteria,
      featureTypeId: config.featureTypeId,
      bugTypeId: config.bugTypeId,
      maxFollowups: bounds.maxFollowups,
    });
    await store.appendProgress(
      run.key,
      run.round,
      findings.length === 0
        ? `The reply passed the checks.\n\n${output.summary ?? ""}`
        : `The reply did not pass the checks:\n${findings.map((f) => `- ${f}`).join("\n")}`,
    );
    const nowIso = clock.now().toISOString();
    if (findings.length > 0) {
      const text = `The loop's checks found:\n${findings.map((f) => `- ${f}`).join("\n")}`;
      const retry = updateGraphNode(
        graph,
        current.id,
        { status: "running", rounds: current.rounds + 1, lastError: text },
        nowIso,
        current.id,
      );
      await nextRound(
        this.#host,
        run,
        text,
        (patch, also) =>
          save(patch, (tx) => {
            tx.saveGraph(retry);
            also?.(tx);
          }),
        "research",
      );
      return;
    }
    // Passing the checks means every block is there and every draft has a type.
    const kept: NonNullable<ResearchState["output"]> = {
      summary: output.summary ?? "",
      report: output.report ?? "",
      followups: output.followups.flatMap((f) =>
        f.type === null ? [] : [{ type: f.type, title: f.title, body: f.body }],
      ),
    };
    const passed = updateGraphNode(
      graph,
      current.id,
      {
        status: "passed",
        summary: kept.summary,
        report: kept.report,
        lastError: null,
        finishedAt: nowIso,
      },
      nowIso,
      null,
    );
    await save(
      {
        phase: "research_qa",
        findings: null,
        research: {
          ...state,
          output: kept,
          followups: kept.followups.map((f) => ({
            title: f.title,
            issueId: null,
            number: null,
            linked: false,
          })),
        },
      },
      (tx) => {
        tx.saveGraph(passed);
        tx.event(run.key, "graph_node_passed", { nodeId: current.id, rounds: current.rounds });
      },
    );
  }

  /**
   * Independent QA of the saved output, in a `qa-n` node of the graph, as `Pipeline`'s `#qa` does for code: each new
   * node is its own session, and a rejection is a `fix-n` research node.
   */
  async #researchQa(run: RunRecord, issue: Issue, save: Save): Promise<void> {
    const { config, clock, store } = this.#host.d;
    const bounds = this.#host.need(config.research ?? undefined);
    const state = researchOf(run);
    const output = this.#host.need(state.output ?? undefined);
    const worktree = this.#host.need(run.worktree ?? undefined);
    const graph0 = await this.#ensureGraph(run);
    const nowIso = clock.now().toISOString();
    const open = graph0.nodes.find(
      (n) =>
        n.role === "qa" &&
        (n.status === "running" || n.status === "blocked" || n.status === "pending"),
    );
    let base = graph0;
    let id: string;
    if (open !== undefined) id = open.id;
    else {
      const added = this.#addQaNode(graph0, nowIso);
      base = added.graph;
      id = added.node.id;
    }
    let graph = updateGraphNode(
      base,
      id,
      { status: "running", startedAt: open?.startedAt ?? nowIso },
      nowIso,
      id,
    );
    // A new node is a new session; one gone on with after a restart keeps the one it had.
    if (open?.sessionId == null || run.qaSessionId === null) {
      const sessionId = await newQaSession(this.#host, this.qa, run, issue);
      graph = updateGraphNode(graph, id, { sessionId }, nowIso, id);
      const g = graph;
      await save({ qaSessionId: sessionId }, (tx) => {
        tx.saveGraph(g);
        if (open === undefined) tx.event(run.key, "graph_qa_added", { nodeId: id });
      });
      run = { ...run, qaSessionId: sessionId };
    } else {
      const g = graph;
      await save({}, (tx) => tx.saveGraph(g));
    }
    const recordSession: Save = async (patch, also) => {
      const sessionId = patch.qaSessionId;
      if (sessionId == null) return save(patch, also);
      graph = updateGraphNode(graph, id, { sessionId }, clock.now().toISOString(), id);
      const g = graph;
      return save(patch, (tx) => {
        also?.(tx);
        tx.saveGraph(g);
      });
    };
    const before = await this.#host.snapshot(worktree);
    const prompt = researchQaBrief(issue, state.questions, output, bounds.readRoots);
    let verdict: Awaited<ReturnType<typeof judge>>;
    try {
      verdict = await judge(
        this.#host,
        this.qa,
        run,
        issue,
        worktree,
        before,
        prompt,
        recordSession,
      );
    } catch (error) {
      if (error instanceof Blocked)
        await store.saveGraph(
          updateGraphNode(
            graph,
            id,
            { status: "blocked", lastError: error.message },
            clock.now().toISOString(),
            id,
          ),
        );
      throw error;
    }
    const doneAt = clock.now().toISOString();
    const finished = updateGraphNode(
      graph,
      id,
      {
        status: "passed",
        verdict: verdict.pass ? "pass" : "fail",
        report: verdict.pass && verdict.findings.length === 0 ? null : formatFindings(verdict),
        lastError: null,
        finishedAt: doneAt,
      },
      doneAt,
      null,
    );
    const commit: Save = (patch, also) =>
      save(patch, (tx) => {
        tx.saveGraph(finished);
        tx.event(run.key, "graph_qa_done", { nodeId: id, verdict: verdict.pass ? "pass" : "fail" });
        also?.(tx);
      });
    if (!verdict.pass) {
      // At the round limit nothing is saved by the fix round: keep the node's result before it blocks.
      if (run.round >= config.maxFixRounds) {
        await store.saveGraph(finished);
        await store.event(run.key, "graph_qa_done", { nodeId: id, verdict: "fail" });
      }
      await nextRound(
        this.#host,
        run,
        `Independent review found:\n${formatFindings(verdict)}`,
        commit,
        "research",
      );
      return;
    }
    await commit({ phase: "publishing" });
  }

  /**
   * Publishes what QA passed (Spec 「发布」 0–4): the report as a document on the work item, the summary into
   * 「结论」 (or as a comment when a person already wrote it), the follow-ups in Backlog, a closing comment, Done.
   * Each step looks at the saved progress first and saves as soon as it is done, so a restart goes on from the first
   * step not done. A follow-up made but not yet saved when the process died is the one thing that can be made twice.
   */
  async #publish(start: RunRecord, issue: Issue, save: Save): Promise<StepResult> {
    const { config, tracker, store } = this.#host.d;
    await this.#ensureGraph(start);
    const bounds = this.#host.need(config.research ?? undefined);
    let state = researchOf(start);
    const output = this.#host.need(state.output ?? undefined);
    const progress = async (patch: Partial<ResearchState>, also?: (tx: StoreOps) => void) => {
      state = { ...state, ...patch };
      await save({ research: state }, also);
    };

    // 0. Nothing that looks like a credential leaves the machine. Only the kinds are said, never the text.
    if (state.docId === null) {
      const kinds = findSecrets(
        [output.summary, output.report, ...output.followups.flatMap((f) => [f.title, f.body])].join(
          "\n",
        ),
      );
      if (kinds.length > 0) {
        await store.event(start.key, "secrets_found", { kinds: kinds.join(",") });
        // Published as it is, it would block again: once put back, the research session writes it again without them.
        await save({
          findings: `The reply holds text shaped like a credential (${kinds.join(", ")}). Nothing was published. Write the blocks again with no secret in them: name a variable or a key by its name alone.`,
        });
        throw new Blocked(
          `调研结果里有疑似凭据（${kinds.join("、")}），什么都没有发布。请先确认这些内容，再把工单放回 Todo：调研会话会去掉它们后重写。`,
          "research",
        );
      }
    }

    // 1. The report, under the research folder, on the work item.
    const title = `${start.key} ${issue.title}`;
    if (state.docId === null) {
      // Made before a restart and not yet noted? Then it is in the research folder under this title: use it.
      const existing = (await tracker.listDocuments()).filter(
        (d) => d.parentId === bounds.folderId && d.title === title,
      );
      // Used only when its text is this report: a same-titled one with other text is some earlier run's.
      let found: (typeof existing)[number] | undefined;
      for (const d of existing) {
        if ((await tracker.getDocumentContent(d.id)).trim() === output.report.trim()) {
          found = d;
          break;
        }
      }
      if (found !== undefined) {
        await progress({ docId: found.id });
        await store.event(start.key, "report_reused", { docId: found.id });
      } else {
        const created = await tracker.createDocument(bounds.folderId, title, output.report);
        await progress({ docId: created.id });
        await store.event(start.key, "report_created", { docId: created.id });
      }
    }
    const docId = this.#host.need(state.docId ?? undefined);
    if (!state.docLinked) {
      await tracker.linkDocument(issue, docId);
      await progress({ docLinked: true });
    }

    // 2. 「结论」: the summary, unless a person has written it meanwhile. Read again just now; a description that
    // already holds what would be written is one this step wrote before a restart.
    const fresh = await tracker.get(issue.number);
    if (!state.conclusionDone) {
      const conclusion = `${output.summary}\n\n报告：「${title}」（已挂在本工单上）`;
      const replaced = replaceConclusion(fresh.description, conclusion);
      if (replaced !== fresh.description) {
        if (conclusionIsEmpty(fresh.description)) await tracker.setDescription(fresh, replaced);
        else
          await progress({ conclusionDone: true }, (tx) =>
            writeIntent(tx, {
              run: start.key,
              issue: fresh,
              kind: "comment",
              dedupe: `researched-summary:${start.key}`,
              payload: {
                body: `调研摘要（「结论」一节已经有人写过，没有覆盖）：\n\n${output.summary}\n\n报告：「${title}」（已挂在本工单上）`,
              },
            }),
          );
      }
      if (!state.conclusionDone) await progress({ conclusionDone: true });
    }

    // 3. The follow-ups, one at a time, each saved as soon as it is made: in Backlog, under the same parent, with no
    // labels or priority (a person decides those), linked to the research work item.
    const setFollowup = (i: number, entry: ResearchState["followups"][number]) =>
      progress({ followups: state.followups.map((e, j) => (j === i ? entry : e)) });
    for (const [i, draft] of output.followups.entries()) {
      const saved = state.followups[i];
      if (saved === undefined) continue;
      let issueId = saved.issueId;
      if (issueId === null) {
        const created = await tracker.createIssue({
          typeId: draft.type === "Feature" ? config.featureTypeId : config.bugTypeId,
          title: draft.title,
          description: draft.body,
          columnId: bounds.backlogColumn,
          parentId: fresh.parentId,
        });
        issueId = created.id;
        await setFollowup(i, { ...saved, issueId, number: created.number });
        await store.event(start.key, "followup_created", { number: created.number });
      }
      if (!saved.linked) {
        await tracker.linkIssues(issue, issueId, "relates");
        await setFollowup(i, { ...(state.followups[i] ?? saved), linked: true });
      }
    }

    // 4. Say what was published, then Done.
    const project = start.key.replace(/-\d+$/, "");
    const keys = state.followups.map((f) => `${project}-${f.number ?? "?"}`);
    // The closing comment, the move to Done and the run's end are written together; the reconciler brings the
    // tracker to them, so a move that fails is made up later and the comment is not written twice.
    await this.#host.clear(start, issue);
    const followups =
      state.followups.length === 0
        ? "没有后续工单。"
        : `后续工单（在 Backlog，没有打 auto，等人批准）：\n${state.followups
            .map((f, i) => `- ${keys[i]} ${f.title}`)
            .join("\n")}`;
    await save({ phase: "done", research: { ...state, commented: true } }, (tx) => {
      tellTicket(tx, start, issue, `researched:${start.key}`, {
        body: `调研完成。报告：「${title}」（已挂在本工单上）。\n\n${followups}`,
        to: "done",
      });
      tx.event(start.key, "researched", { docId, followups: keys.length });
    });
    return { status: "researched", key: start.key, docId, followups: keys };
  }
}
