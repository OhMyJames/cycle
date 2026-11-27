// The research flow (CYC-447): a Research work item, answered by a read-only session and published by the loop.
//
// claimed → research → research_qa → publishing → done. The sessions only read; the loop checks the reply, has it
// judged, and publishes it. There is no install, no commit, no push and no pull request.

import type { StepResult } from "../../engine/flow.ts";
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
import { deliverEnv, GIT_SAFE } from "../../env.ts";
import { withRepoLock } from "../../git-lock.ts";
import { conclusionIsEmpty } from "../../preflight.ts";
import {
  formatFindings,
  researchBrief,
  researchContinueBrief,
  researchFixBrief,
  researchQaBrief,
} from "../../prompts/index.ts";
import { findSecrets } from "../../secrets.ts";
import { type ResearchState, type RunRecord, researchOf } from "../../store.ts";
import { type Config, type Issue, SessionLost, type TurnResult } from "../../types.ts";
import { judge, newQaSession, nextRound } from "../dev/qa.ts";
import { blockTicket, ticketStillMine, ticketStillWanted } from "../ticket.ts";
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
        withRepoLock(config.repoRoot, () =>
          this.#host.d.exec(["git", ...GIT_SAFE, "fetch", config.remote], {
            cwd: config.repoRoot,
            env: deliverEnv(this.#host.d.env),
            timeoutMs: config.commandTimeoutMs,
          }),
        ),
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
  }

  /**
   * One research turn. The reply is checked by rule; what fails goes back to the same session as a fix round, what
   * passes is kept as the output to publish and goes to QA. The worktree must be as it was.
   */
  async #research(
    run: RunRecord,
    issue: Issue,
    byPerson: boolean,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<void> {
    const { config, store } = this.#host.d;
    const bounds = this.#host.need(config.research ?? undefined);
    const state = researchOf(run);
    const worktree = this.#host.need(run.worktree ?? undefined);
    const brief = () => {
      const first = researchBrief(issue, state.questions, {
        readRoots: bounds.readRoots,
        maxFollowups: bounds.maxFollowups,
        maxCriteria: config.maxCriteria,
      });
      return run.findings === null
        ? first
        : `${first}\n\nAn earlier reply to this work item was sent back with these findings; do not repeat them:\n${run.findings}`;
    };
    // Which brief is chosen from what is saved: a session that has had no turn yet is given the whole brief.
    const progress = await store.readProgress(run.key);
    const prompt =
      progress === ""
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
    let sessionId = this.#host.need(run.devSessionId ?? undefined);
    let result: TurnResult;
    try {
      result = await this.#host.turn(run.key, sessionId, prompt, turnOptions);
    } catch (error) {
      if (!(error instanceof SessionLost)) throw error;
      // Nothing on disk to take over from: a new session starts the research again, told what was sent back.
      const created = await this.#newSession(run, issue);
      await save({
        devSessionId: created.sessionId,
        replacedSessions: [...run.replacedSessions, sessionId],
      });
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
    if (findings.length > 0) {
      await nextRound(
        this.#host,
        run,
        `The loop's checks found:\n${findings.map((f) => `- ${f}`).join("\n")}`,
        save,
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
    await save({
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
    });
  }

  /** Independent QA of the saved output, as `Pipeline`'s `#qa` does for code: a rejection is a fix round back in research. */
  async #researchQa(
    run: RunRecord,
    issue: Issue,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<void> {
    const { config } = this.#host.d;
    const bounds = this.#host.need(config.research ?? undefined);
    const state = researchOf(run);
    const output = this.#host.need(state.output ?? undefined);
    const worktree = this.#host.need(run.worktree ?? undefined);
    if (run.qaSessionId === null) {
      const sessionId = await newQaSession(this.#host, this.qa, run, issue);
      await save({ qaSessionId: sessionId });
      run = { ...run, qaSessionId: sessionId };
    }
    const before = await this.#host.snapshot(worktree);
    const prompt = researchQaBrief(issue, state.questions, output, bounds.readRoots);
    const verdict = await judge(this.#host, this.qa, run, issue, worktree, before, prompt, save);
    if (!verdict.pass) {
      await nextRound(
        this.#host,
        run,
        `Independent review found:\n${formatFindings(verdict)}`,
        save,
        "research",
      );
      return;
    }
    await save({ phase: "publishing" });
  }

  /**
   * Publishes what QA passed (Spec 「发布」 0–4): the report as a document on the work item, the summary into
   * 「结论」 (or as a comment when a person already wrote it), the follow-ups in Backlog, a closing comment, Done.
   * Each step looks at the saved progress first and saves as soon as it is done, so a restart goes on from the first
   * step not done. A follow-up made but not yet saved when the process died is the one thing that can be made twice.
   */
  async #publish(
    start: RunRecord,
    issue: Issue,
    save: (patch: Partial<RunRecord>) => Promise<void>,
  ): Promise<StepResult> {
    const { config, tracker, store } = this.#host.d;
    const bounds = this.#host.need(config.research ?? undefined);
    let state = researchOf(start);
    const output = this.#host.need(state.output ?? undefined);
    const progress = async (patch: Partial<ResearchState>) => {
      state = { ...state, ...patch };
      await save({ research: state });
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
          await tracker.comment(
            fresh,
            `调研摘要（「结论」一节已经有人写过，没有覆盖）：\n\n${output.summary}\n\n报告：「${title}」（已挂在本工单上）`,
          );
      }
      await progress({ conclusionDone: true });
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
    if (!state.commented) {
      const followups =
        state.followups.length === 0
          ? "没有后续工单。"
          : `后续工单（在 Backlog，没有打 auto，等人批准）：\n${state.followups
              .map((f, i) => `- ${keys[i]} ${f.title}`)
              .join("\n")}`;
      await tracker.comment(
        issue,
        `调研完成。报告：「${title}」（已挂在本工单上）。\n\n${followups}`,
      );
      await progress({ commented: true });
    }
    await this.#host.clear(start, issue);
    await tracker.move(issue, "done");
    await store.event(start.key, "researched", { docId, followups: keys.length });
    await save({ phase: "done" });
    return { status: "researched", key: start.key, docId, followups: keys };
  }
}
