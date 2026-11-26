// The Loop page's reads (docs/protocol.md §17): the Projects of the Loop server on this computer, and each Project's
// board. Both come through main; the key that reads the board never gets here.
import type {
  LoopAction,
  LoopActResult,
  LoopBoardAnswer,
  LoopChatResult,
  LoopNoticesAnswer,
  LoopProjectInfo,
  LoopTicketAnswer,
} from "../api.ts";
import type { StoreKit } from "./core.ts";

export type LoopState = {
  /** The Projects as last read: kept when the server goes away, so the page can show them greyed out. */
  projects: LoopProjectInfo[];
  /** Whether the Loop server answered the last time it was asked. `undefined`: not asked yet. */
  connected?: boolean;
  /** Each Project's board as last read; `loading` while it is being read the first time. */
  boards: Record<string, LoopBoardAnswer | "loading">;
  /** Each Project's Notices as last read. They are derived from state by main, so a read replaces the last whole. */
  notices: Record<string, LoopNoticesAnswer>;
  /** A pressed system notification asks for this ticket's page; `n` counts the asks, so the same ticket can be asked twice. */
  request?: { projectKey: string; identifier: string; n: number };
};

export const initialLoop = (): LoopState => ({ projects: [], boards: {}, notices: {} });

/** How many reads in a row may fail before the Notices last read are dropped. */
const NOTICE_FAILURES_KEPT = 3;

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

  loadBoard = async (projectKey: string): Promise<void> => {
    const had = this.#kit.state().loop.boards[projectKey];
    // What was read before stays on screen while it is read again.
    if (had === undefined)
      this.#kit.set((s) => ({
        loop: { ...s.loop, boards: { ...s.loop.boards, [projectKey]: "loading" } },
      }));
    const answer = await this.#kit.bridge
      .loopBoard(projectKey)
      .catch(() => ({ kind: "unreachable" }) as const);
    // A board that was read stays when a read again fails: it is still the last that is known.
    if (typeof had === "object" && had.kind === "ok" && answer.kind !== "ok") return;
    this.#kit.set((s) => ({
      loop: { ...s.loop, boards: { ...s.loop.boards, [projectKey]: answer } },
    }));
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
      // are too old to show as they are. No key at all replaces them at once.
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

  /** A state button. A write that went through reads the board again; one that did not leaves it as it was. */
  act = async (
    projectKey: string,
    identifier: string,
    action: LoopAction,
    confirmed = false,
  ): Promise<LoopActResult> => {
    const result = await this.#kit.bridge
      .loopAct(projectKey, identifier, action, confirmed)
      .catch((): LoopActResult => ({ kind: "failed", reason: "offline" }));
    if (result.kind === "ok")
      await Promise.all([this.loadBoard(projectKey), this.loadNotices(projectKey)]);
    return result;
  };

  /** Talk about a ticket with an agent: on success the new session is opened in place of the page. */
  chat = async (projectKey: string, identifier: string): Promise<LoopChatResult> => {
    return this.#kit.bridge
      .loopChat(projectKey, identifier)
      .catch((): LoopChatResult => ({ kind: "failed", reason: "offline" }));
  };
}
