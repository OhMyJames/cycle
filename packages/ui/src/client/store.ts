import { useRef, useSyncExternalStore } from "react";

/** A value with listeners: the smallest thing `useSyncExternalStore` can read. */
export class Store<T> {
  private value: T;
  private readonly listeners = new Set<() => void>();

  constructor(initial: T) {
    this.value = initial;
  }

  get = (): T => this.value;

  set(next: T): void {
    if (Object.is(next, this.value)) return;
    this.value = next;
    for (const listener of this.listeners) listener();
  }

  update(change: (value: T) => T): void {
    this.set(change(this.value));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  for (const key of keysA) {
    if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
}

/**
 * Reads part of a store. The component redraws only when that part changes,
 * compared one level deep, so a selector may build a small object or array.
 */
export function useStore<T, S>(store: Store<T>, select: (value: T) => S): S {
  const last = useRef<{ value: S } | null>(null);
  const read = () => {
    const next = select(store.get());
    if (last.current && shallowEqual(last.current.value, next)) return last.current.value;
    last.current = { value: next };
    return next;
  };
  return useSyncExternalStore(store.subscribe, read, read);
}
