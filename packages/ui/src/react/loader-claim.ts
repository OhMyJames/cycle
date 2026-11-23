import { createContext, useContext, useLayoutEffect, useSyncExternalStore } from "react";

/**
 * Who draws the conversation's one loader (CYCL-217): the status line at the end of the turn while it speaks, else the
 * sub-agent at work that started first. Everything else that is at work says so with a still mark, so a conversation
 * with three sub-agents at once still has one thing moving in it. A claim is ranked by a number, the lowest holding:
 * the status line claims with `-Infinity`, a sub-agent with when the page first saw its call, so the one holding it
 * keeps it until it ends, also when its card is drawn again.
 */
export class LoaderClaims {
  private readonly claims = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private held: string | undefined;

  claim(id: string, rank: number): () => void {
    this.claims.set(id, rank);
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
    let best: [string, number] | undefined;
    // Map order is the order of claims: of two of the same rank, the first keeps it.
    for (const entry of this.claims) if (best === undefined || entry[1] < best[1]) best = entry;
    const next = best?.[0];
    if (next === this.held) return;
    this.held = next;
    for (const listener of this.listeners) listener();
  }
}

const LoaderClaimsContext = createContext(new LoaderClaims());
export const LoaderClaimsProvider = LoaderClaimsContext.Provider;

/** Whether `id`, which wants the loader while `wanted`, draws it now. */
export function useLoaderClaim(id: string, wanted: boolean, rank: number): boolean {
  const claims = useContext(LoaderClaimsContext);
  const holder = useSyncExternalStore(claims.subscribe, claims.holder, claims.holder);
  // Before the first paint: the one that holds it is drawn with it from its first frame on screen.
  useLayoutEffect(() => (wanted ? claims.claim(id, rank) : undefined), [claims, id, wanted, rank]);
  return wanted && holder === id;
}
