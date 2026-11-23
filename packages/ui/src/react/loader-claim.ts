import { createContext, useContext, useLayoutEffect, useState } from "react";

/**
 * Who draws the conversation's one loader (CYCL-217): the status line at the end of the turn while it speaks, else the
 * sub-agent at work that started first. Everything else that is at work says so with a still mark, so a conversation
 * with three sub-agents at once still has one thing moving in it. A claim is ranked by a number, the lowest holding:
 * the status line claims with `-Infinity`, a sub-agent with when the page first saw its call, so the one holding it
 * keeps it until it ends, also when its card is drawn again. Of two of the same rank, the one that first claimed holds,
 * and keeps that place when it claims again.
 */
export class LoaderClaims {
  private readonly claims = new Map<string, number>();
  /** When each id first claimed: kept after it lets go, so a card drawn again keeps its place among equals. */
  private readonly firsts = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private held: string | undefined;
  private count = 0;

  claim(id: string, rank: number): () => void {
    this.claims.set(id, rank);
    if (!this.firsts.has(id)) this.firsts.set(id, this.count++);
    this.settle();
    return () => {
      if (this.claims.get(id) !== rank) return;
      this.claims.delete(id);
      this.settle();
    };
  }

  holder = (): string | undefined => this.held;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private settle() {
    let best: string | undefined;
    for (const [id, rank] of this.claims) {
      if (best === undefined) best = id;
      else {
        const was = this.claims.get(best) ?? 0;
        if (
          rank < was ||
          (rank === was && (this.firsts.get(id) ?? 0) < (this.firsts.get(best) ?? 0))
        )
          best = id;
      }
    }
    if (best === this.held) return;
    this.held = best;
    for (const listener of this.listeners) listener();
  }
}

const LoaderClaimsContext = createContext(new LoaderClaims());
export const LoaderClaimsProvider = LoaderClaimsContext.Provider;

/** Whether `id`, which wants the loader while `wanted`, draws it now. */
export function useLoaderClaim(id: string, wanted: boolean, rank: number): boolean {
  const claims = useContext(LoaderClaimsContext);
  const [holder, setHolder] = useState(claims.holder);
  // Listened to and claimed before the first paint (not in a passive effect, as useSyncExternalStore listens): the one
  // that holds it is drawn with it from its first frame on screen, and one that gives it up does so on the same frame.
  useLayoutEffect(() => {
    const update = () => setHolder(claims.holder());
    const stop = claims.subscribe(update);
    const release = wanted ? claims.claim(id, rank) : undefined;
    update();
    return () => {
      stop();
      release?.();
    };
  }, [claims, id, wanted, rank]);
  return wanted && holder === id;
}
