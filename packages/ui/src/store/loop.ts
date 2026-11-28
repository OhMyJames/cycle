// The Loop page's reads (docs/protocol.md §17): the Projects of the Loop server on this computer, and each Project's
// board. Both come through main, which asks the Loop server; no itsaplan key is here or in main.
import type {
  LoopAction,
  LoopActResult,
  LoopBoardAnswer,
  LoopCancelRunResult,
  LoopChatResult,
  LoopGraphNodeAction,
  LoopGraphNodeEdits,
  LoopManyAction,
  LoopManyItem,
  LoopManyResult,
  LoopNoticesAnswer,
  LoopProjectInfo,
  LoopRetryIntentsResult,
  LoopRunAnswer,
  LoopRunsAnswer,
  LoopTicketAnswer,
  LoopTimelineAnswer,
  LoopTimelineEntry,
} from "../api.ts";
import type { StoreKit } from "./core.ts";

export type LoopTimelineState =
  | "loading"
  | {
      kind: "ok";
      entries: LoopTimelineEntry[];
      hasMore: boolean;
      nextBefore: string | null;
      loadingMore: boolean;
    }
  | { kind: "no_server" }
  | { kind: "unreachable" };

export type LoopState = {
  /** The Projects as last read: kept when the server goes away, so the page can show them greyed out. */
  projects: LoopProjectInfo[];
  /** Normalised `owner/name` repo per local workspace `cwd` (CYC-533), or null when none. */
  workspaceRepos: Record<string, string | null>;
  /** Whether the Loop server answered the last time it was asked. `undefined`: not asked yet. */
  connected?: boolean;
  /** Where Loop is running, as last read or pushed. `undefined`: not read yet. */
  runs?: LoopRunsAnswer;
  /** Each Project's board as last read; `loading` while it is being read the first time. */
  boards: Record<string, LoopBoardAnswer | "loading">;
  /** Each Project's chronological Loop timeline (CYC-534). */
  timelines: Record<string, LoopTimelineState>;
  /** Known Loop session IDs reported by the Loop server per Project (smoothly hides legacy Loop sessions). */
  knownSessions: Record<string, string[]>;
  /** Each Project's Notices as last read. They are derived from state by main, so a read replaces the last whole. */
  notices: Record<string, LoopNoticesAnswer>;
  /** Per-Project counter incremented whenever Loop's event stream reports new activity, so open drawers can refresh. */
  activity: Record<string, number>;
  /** A pressed system notification asks for this ticket's page; `n` counts the asks, so the same ticket can be asked twice. */
  request?: { projectKey: string; identifier: string; n: number };
};

/** The most tickets the Loop server takes in one request. */
const MANY_CHUNK = 50;

export const initialLoop = (): LoopState => ({
  projects: [],
  workspaceRepos: {},
  boards: {},
  timelines: {},
  knownSessions: {},
  notices: {},
  activity: {},
});

/** How many reads in a row may fail before the Notices last read are dropped. */
const NOTICE_FAILURES_KEPT = 3;

/** The tickets Loop is running in a Project, as one comparable string; none when it is not known. */
const runKeys = (runs: LoopRunsAnswer | undefined, projectKey: string): string =>
  runs?.kind === "ok" ? [...(runs.running[projectKey] ?? [])].sort().join(",") : "";

export class LoopSlice {
  readonly #kit: StoreKit;

  constructor(kit: StoreKit) {
    this.#kit = kit;
  }

  loadProjects = async (): Promise<void> => {
    const answer = await this.#kit.bridge
      .loopProjects()
      .catch(() => ({ kind: "disconnected" }) as const);
    this.#kit.set((s) => ({
      loop: {
        ...s.loop,
        connected: answer.kind === "ok",
        projects: answer.kind === "ok" ? answer.projects : s.loop.projects,
      },
    }));
  };

  readonly #repoInflight = new Map<string, Promise<string | null>>();

  /** Reads and caches the normalised git `owner/name` of a local workspace folder (CYC-533). */
  loadWorkspaceRepo = async (cwd: string): Promise<string | null> => {
    if (cwd === "") return null;
    const cached = this.#kit.state().loop.workspaceRepos;
    if (Object.hasOwn(cached, cwd)) return cached[cwd] ?? null;
    const existing = this.#repoInflight.get(cwd);
    if (existing !== undefined) return existing;
    const promise = this.#kit.bridge
      .workspaceRepo(cwd)
      .catch(() => null)
      .then((repo) => {
        this.#repoInflight.delete(cwd);
        this.#kit.set((s) => ({
          loop: {
            ...s.loop,
            workspaceRepos: { ...s.loop.workspaceRepos, [cwd]: repo },
          },
        }));
        return repo;
      });
    this.#repoInflight.set(cwd, promise);
    return promise;
  };

  loadRuns = async (): Promise<void> => {
    const before = this.#pushes;
    const answer = await this.#kit.bridge
      .loopRuns()
      .catch(() => ({ kind: "disconnected" }) as const);
    // Only a push that came while this was being read is newer; otherwise this read is the latest (main has recorded it
    // as told, so it will not push it again).
    if (this.#pushes !== before) return;
    this.#kit.set((s) => ({ loop: { ...s.loop, runs: answer } }));
  };

  #pushes = 0;

  /** Main follows Loop's events and pushes the run state when it changes; it replaces what was held. */
  setRuns = (runs: LoopRunsAnswer): void => {
    this.#pushes++;
    const before = this.#kit.state().loop.runs;
    this.#kit.set((s) => ({ loop: { ...s.loop, runs } }));
    // What a card says about Loop (watching, or not) comes from the run data: a Project whose running tickets changed
    // has its board read again. One that was never read is left to its first read.
    for (const [projectKey, board] of Object.entries(this.#kit.state().loop.boards))
      if (typeof board === "object" && runKeys(before, projectKey) !== runKeys(runs, projectKey))
        void this.loadBoard(projectKey);
  };

  /** Main saw new Loop events for these Projects: bump their activity counters and refresh loaded boards and notices. */
  noteActivity = (projectKeys: string[]): void => {
    if (projectKeys.length === 0) return;
    this.#kit.set((s) => {
      const next = { ...s.loop.activity };
      for (const key of projectKeys) next[key] = (next[key] ?? 0) + 1;
      return { loop: { ...s.loop, activity: next } };
    });
    const state = this.#kit.state().loop;
    for (const key of projectKeys) {
      if (typeof state.boards[key] === "object" && !this.#boardInFlight.has(key))
        void this.loadBoard(key);
      if (state.notices[key] !== undefined) void this.loadNotices(key);
    }
  };

  readonly #timelineAsk = new Map<string, number>();
  readonly #timelineInFlight = new Set<string>();

  /**
   * Loads the first page of a Loop Project's timeline (or refreshes it while keeping previous items visible).
   * With `merge: true` (used on live `loop-activity` refreshes while Timeline is mounted), updated page-1 entries are
   * merged ahead of any already-paginated older entries so "Show more" results are never truncated.
   */
  loadTimeline = async (projectKey: string, options?: { merge?: boolean }): Promise<void> => {
    const merge = options?.merge === true;
    if (merge && this.#timelineInFlight.has(projectKey)) return;
    const ask = (this.#timelineAsk.get(projectKey) ?? 0) + 1;
    this.#timelineAsk.set(projectKey, ask);
    this.#timelineInFlight.add(projectKey);
    const had = this.#kit.state().loop.timelines[projectKey];
    if (had === undefined)
      this.#kit.set((s) => ({
        loop: { ...s.loop, timelines: { ...s.loop.timelines, [projectKey]: "loading" } },
      }));
    const answer: LoopTimelineAnswer = await this.#kit.bridge
      .loopTimeline(projectKey)
      .catch(() => ({ kind: "unreachable" }) as const);
    if (this.#timelineAsk.get(projectKey) !== ask) return;
    this.#timelineInFlight.delete(projectKey);
    if (typeof had === "object" && had.kind === "ok" && answer.kind !== "ok") return;
    this.#kit.set((s) => {
      const cur = s.loop.timelines[projectKey];
      let nextState: LoopTimelineState;
      if (answer.kind !== "ok") {
        nextState = answer;
      } else if (merge && typeof cur === "object" && cur.kind === "ok" && cur.entries.length > 0) {
        const freshIds = new Set(answer.entries.map((e) => e.id));
        const tail = cur.entries.filter((e) => !freshIds.has(e.id));
        const merged = [...answer.entries, ...tail].sort((a, b) =>
          b.updatedAt > a.updatedAt
            ? 1
            : b.updatedAt < a.updatedAt
              ? -1
              : b.id > a.id
                ? 1
                : b.id < a.id
                  ? -1
                  : 0,
        );
        const keptTail = tail.length > 0;
        nextState = {
          kind: "ok",
          entries: merged,
          hasMore: keptTail ? cur.hasMore : answer.hasMore,
          nextBefore: keptTail ? cur.nextBefore : answer.nextBefore,
          loadingMore: false,
        };
      } else {
        nextState = {
          kind: "ok",
          entries: answer.entries,
          hasMore: answer.hasMore,
          nextBefore: answer.nextBefore,
          loadingMore: false,
        };
      }
      return {
        loop: {
          ...s.loop,
          timelines: { ...s.loop.timelines, [projectKey]: nextState },
          ...(answer.kind === "ok"
            ? {
                knownSessions: {
                  ...s.loop.knownSessions,
                  [projectKey]: answer.knownSessionIds,
                },
              }
            : {}),
        },
      };
    });
  };

  /** Appends the next page of a Loop Project's timeline using its `nextBefore` cursor. */
  loadMoreTimeline = async (projectKey: string): Promise<void> => {
    const current = this.#kit.state().loop.timelines[projectKey];
    if (
      typeof current !== "object" ||
      current.kind !== "ok" ||
      !current.hasMore ||
      current.nextBefore === null ||
      current.loadingMore ||
      this.#timelineInFlight.has(projectKey)
    )
      return;
    const ask = this.#timelineAsk.get(projectKey) ?? 0;
    this.#timelineInFlight.add(projectKey);
    this.#kit.set((s) => {
      const cur = s.loop.timelines[projectKey];
      if (typeof cur !== "object" || cur.kind !== "ok") return {};
      return {
        loop: {
          ...s.loop,
          timelines: { ...s.loop.timelines, [projectKey]: { ...cur, loadingMore: true } },
        },
      };
    });
    const answer: LoopTimelineAnswer = await this.#kit.bridge
      .loopTimeline(projectKey, { before: current.nextBefore })
      .catch(() => ({ kind: "unreachable" }) as const);
    this.#timelineInFlight.delete(projectKey);
    if ((this.#timelineAsk.get(projectKey) ?? 0) !== ask) return;
    this.#kit.set((s) => {
      const cur = s.loop.timelines[projectKey];
      if (typeof cur !== "object" || cur.kind !== "ok") return {};
      if (answer.kind !== "ok")
        return {
          loop: {
            ...s.loop,
            timelines: { ...s.loop.timelines, [projectKey]: { ...cur, loadingMore: false } },
          },
        };
      const seen = new Set(cur.entries.map((e) => e.id));
      const appended = answer.entries.filter((e) => !seen.has(e.id));
      return {
        loop: {
          ...s.loop,
          timelines: {
            ...s.loop.timelines,
            [projectKey]: {
              kind: "ok",
              entries: [...cur.entries, ...appended],
              hasMore: answer.hasMore,
              nextBefore: answer.nextBefore,
              loadingMore: false,
            },
          },
          knownSessions: {
            ...s.loop.knownSessions,
            [projectKey]: answer.knownSessionIds,
          },
        },
      };
    });
  };

  readonly #boardAsk = new Map<string, number>();
  readonly #boardInFlight = new Set<string>();

  loadBoard = async (projectKey: string): Promise<void> => {
    const ask = (this.#boardAsk.get(projectKey) ?? 0) + 1;
    this.#boardAsk.set(projectKey, ask);
    this.#boardInFlight.add(projectKey);
    // The run state this read starts with: the cards' `watch` is made from it when main reads the board.
    const started = runKeys(this.#kit.state().loop.runs, projectKey);
    const had = this.#kit.state().loop.boards[projectKey];
    // What was read before stays on screen while it is read again.
    if (had === undefined)
      this.#kit.set((s) => ({
        loop: { ...s.loop, boards: { ...s.loop.boards, [projectKey]: "loading" } },
      }));
    const answer = await this.#kit.bridge
      .loopBoard(projectKey)
      .catch(() => ({ kind: "unreachable" }) as const);
    // Only the latest ask for a Project counts: an older read, which may carry an older run state, is dropped.
    if (this.#boardAsk.get(projectKey) !== ask) return;
    this.#boardInFlight.delete(projectKey);
    // A board that was read stays when a read again fails: it is still the last that is known.
    if (typeof had === "object" && had.kind === "ok" && answer.kind !== "ok") return;
    this.#kit.set((s) => ({
      loop: { ...s.loop, boards: { ...s.loop.boards, [projectKey]: answer } },
    }));
    // The run state moved while this was being read (a first read can land after a push): it is read once more.
    if (runKeys(this.#kit.state().loop.runs, projectKey) !== started)
      void this.loadBoard(projectKey);
  };

  /** The latest ask per Project: an answer that is not for it is old, and is dropped. */
  #requests = 0;
  readonly #noticeFailures = new Map<string, number>();
  readonly #noticeAsk = new Map<string, number>();

  loadNotices = async (projectKey: string): Promise<void> => {
    const ask = (this.#noticeAsk.get(projectKey) ?? 0) + 1;
    this.#noticeAsk.set(projectKey, ask);
    const answer = await this.#kit.bridge
      .loopNotices(projectKey)
      .catch(() => ({ kind: "unreachable" }) as const);
    if (this.#noticeAsk.get(projectKey) !== ask) return;
    this.#kit.set((s) => {
      const had = s.loop.notices[projectKey];
      // A read that failed to reach the tracker leaves the Notices that were read, for a few failures: after that they
      // are too old to show as they are. No server at all replaces them at once.
      if (answer.kind === "unreachable") {
        const failures = (this.#noticeFailures.get(projectKey) ?? 0) + 1;
        this.#noticeFailures.set(projectKey, failures);
        if (had?.kind === "ok" && failures < NOTICE_FAILURES_KEPT) return {};
      } else this.#noticeFailures.delete(projectKey);
      return { loop: { ...s.loop, notices: { ...s.loop.notices, [projectKey]: answer } } };
    });
  };

  /** The ticket a pressed notification asked for is handed over once: the page that takes it clears it. */
  takeRequest = (n: number): void =>
    this.#kit.set((s) => {
      if (s.loop.request?.n !== n) return {};
      const { request: _taken, ...rest } = s.loop;
      return { loop: rest };
    });

  requestTicket = (projectKey: string, identifier: string): void =>
    this.#kit.set((s) => ({
      loop: {
        ...s.loop,
        request: { projectKey, identifier, n: ++this.#requests },
      },
    }));

  loadTicket = (projectKey: string, identifier: string): Promise<LoopTicketAnswer> =>
    this.#kit.bridge
      .loopTicket(projectKey, identifier)
      .catch(() => ({ kind: "unreachable" }) as const);

  loadRun = (projectKey: string, identifier: string): Promise<LoopRunAnswer> =>
    this.#kit.bridge
      .loopRun(projectKey, identifier)
      .catch(() => ({ kind: "unreachable" }) as const);

  /** Cancels the active turn of a running Loop ticket; refreshes board and notices when accepted. */
  cancelRun = async (projectKey: string, identifier: string): Promise<LoopCancelRunResult> => {
    const result = await this.#kit.bridge
      .loopCancelRun(projectKey, identifier)
      .catch((): LoopCancelRunResult => ({ kind: "failed", reason: "offline" }));
    if (result.kind === "ok")
      await Promise.all([this.loadBoard(projectKey), this.loadNotices(projectKey)]);
    return result;
  };

  /** Requeues stuck tracker write intents for a ticket; refreshes notices and board when accepted. */
  retryIntents = async (
    projectKey: string,
    identifier: string,
  ): Promise<LoopRetryIntentsResult> => {
    const result = await this.#kit.bridge
      .loopRetryIntents(projectKey, identifier)
      .catch((): LoopRetryIntentsResult => ({ kind: "failed", reason: "offline" }));
    if (result.kind === "ok")
      await Promise.all([this.loadNotices(projectKey), this.loadBoard(projectKey)]);
    return result;
  };

  /** A state button. A write that went through reads the board again; one that did not leaves it as it was. */
  act = async (
    projectKey: string,
    identifier: string,
    action: LoopAction,
    confirmed = false,
    reason?: string,
  ): Promise<LoopActResult> => {
    const req =
      reason !== undefined
        ? this.#kit.bridge.loopAct(projectKey, identifier, action, confirmed, reason)
        : this.#kit.bridge.loopAct(projectKey, identifier, action, confirmed);
    const result = await req.catch((): LoopActResult => ({ kind: "failed", reason: "offline" }));
    if (result.kind === "ok")
      await Promise.all([this.loadBoard(projectKey), this.loadNotices(projectKey)]);
    return result;
  };

  /** Retries, skips or edits one graph node. A write that went through reads the board again. */
  actOnGraph = async (
    projectKey: string,
    identifier: string,
    nodeId: string,
    action: LoopGraphNodeAction,
    edits?: LoopGraphNodeEdits,
  ): Promise<LoopActResult> => {
    const req =
      edits !== undefined
        ? this.#kit.bridge.loopGraphAct(projectKey, identifier, nodeId, action, edits)
        : this.#kit.bridge.loopGraphAct(projectKey, identifier, nodeId, action);
    const result = await req.catch((): LoopActResult => ({ kind: "failed", reason: "offline" }));
    if (result.kind === "ok")
      await Promise.all([this.loadBoard(projectKey), this.loadNotices(projectKey)]);
    return result;
  };

  /** A batch over the tickets waiting for approval. The board is read again once anything was written. */
  actMany = async (
    projectKey: string,
    action: LoopManyAction,
    identifiers: string[],
    confirmed = false,
    reason?: string,
  ): Promise<LoopManyResult> => {
    // The Loop server takes at most this many at a time: a longer selection goes in chunks, results merged.
    const results: LoopManyItem[] = [];
    let result: LoopManyResult = { kind: "done", results };
    for (let i = 0; i < identifiers.length; i += MANY_CHUNK) {
      const chunk = identifiers.slice(i, i + MANY_CHUNK);
      const answer = await this.#kit.bridge
        .loopActMany(projectKey, action, chunk, confirmed, reason)
        .catch((): LoopManyResult => ({ kind: "failed", reason: "offline" }));
      if (answer.kind === "done") {
        results.push(...answer.results);
        continue;
      }
      if (results.length === 0) {
        result = answer;
        break;
      }
      // Some were done: the rest are reported failed, so the counts are true.
      for (const identifier of identifiers.slice(i))
        results.push({ identifier, outcome: "failed", reason: answer.reason });
      break;
    }
    // One event for the press, however many requests it took: how many were asked for and how they came out.
    if (result.kind === "done") {
      const count = (outcome: LoopManyItem["outcome"]) =>
        result.results.filter((r) => r.outcome === outcome).length;
      this.#kit.track("loop_tickets_acted", {
        action,
        total: identifiers.length,
        ok: count("ok"),
        skipped: count("skipped"),
        failed: count("failed"),
      });
    }
    if (result.kind === "done" && result.results.some((r) => r.outcome !== "failed"))
      await Promise.all([this.loadBoard(projectKey), this.loadNotices(projectKey)]);
    return result;
  };

  /** Talk about a ticket with an agent: on success the new session is opened in place of the page. */
  chat = async (projectKey: string, identifier: string, agent?: string): Promise<LoopChatResult> =>
    (agent !== undefined
      ? this.#kit.bridge.loopChat(projectKey, identifier, agent)
      : this.#kit.bridge.loopChat(projectKey, identifier)
    ).catch((): LoopChatResult => ({ kind: "failed", reason: "offline" }));
}
