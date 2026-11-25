// The Loop page's reads (docs/protocol.md §17): the Projects of the Loop server on this computer, and each Project's
// board. Both come through main; the key that reads the board never gets here.
import type { LoopBoardAnswer, LoopProjectInfo } from "../api.ts";
import type { StoreKit } from "./core.ts";

export type LoopState = {
  /** The Projects as last read: kept when the server goes away, so the page can show them greyed out. */
  projects: LoopProjectInfo[];
  /** Whether the Loop server answered the last time it was asked. `undefined`: not asked yet. */
  connected?: boolean;
  /** Each Project's board as last read; `loading` while it is being read the first time. */
  boards: Record<string, LoopBoardAnswer | "loading">;
};

export const initialLoop = (): LoopState => ({ projects: [], boards: {} });

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
}
