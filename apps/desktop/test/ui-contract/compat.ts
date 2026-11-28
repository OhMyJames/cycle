// Whether the page built from this source can run on every app of the same contract major (shared/contract.ts),
// checked by `bun run typecheck`. The only pairing that happens is a page as new as its app, or newer: a bundle is taken
// only when it is newer than the app's own page. So, for each method both the snapshot (the API's types as the last
// commit had them) and the source have:
//  - what the page sends must be what the older app takes: the new arguments go where the old ones did, and any it adds
//    after them are optional, which the older app does not read;
//  - what the older app answers must be what the page expects: the old result goes where the new one does.
// And every event the older app sends must be one the page takes. A method the source added is not here: the page
// finds it missing (renderer/bridge.ts). A method removed counts as a break, although the page no longer calls it: this
// compares with the last commit only, and a method removed and later added back with other types would go unchecked
// against the apps that still have the old ones. (The same holds for a field removed and added back with another type:
// that the check cannot see, so give it a new name instead.) Each side is in a tuple, so that a union is compared as a
// whole and not member by member.
import type { AppApi as NewApi, AppEvent as NewEvent } from "@cycle/ui/api";
import type { CONTRACT_MAJOR } from "../../src/shared/contract.ts";
import type { AppApi as OldApi, AppEvent as OldEvent } from "./snapshot/api";
import type { SNAPSHOT } from "./snapshot.ts";

type Fn<T> =
  NonNullable<T> extends (...args: infer A) => infer R ? { args: A; result: Awaited<R> } : never;

/** True when a page whose method is typed `N` cannot call an app whose method is typed `O`. */
export type Breaks<O, N> = [Fn<N>["args"]] extends [[...Fn<O>["args"], ...unknown[]]]
  ? // The arguments the page adds are optional: a call of the old length is one of the new.
    [Fn<O>["args"]["length"]] extends [Fn<N>["args"]["length"]]
    ? [Fn<O>["result"]] extends [Fn<N>["result"]]
      ? false
      : true
    : true
  : true;

/** The methods of both that a page typed `N` cannot call on an app typed `O`, and those `N` no longer has. */
export type Incompatible<O, N> =
  | {
      [K in keyof O & keyof N]-?: Breaks<O[K], N[K]> extends true ? K : never;
    }[keyof O & keyof N]
  | Exclude<keyof O, keyof N>;

/** True when an app sending `O` may send an event a page taking `N` does not know. */
export type EventsBreak<O, N> = [O] extends [N] ? false : true;

/** The methods of an API that do not answer with a promise: the page fills in missing ones with a refusal. */
export type NotPromised<A> = {
  [K in keyof A]-?: NonNullable<A[K]> extends (...args: never[]) => Promise<unknown> ? never : K;
}[keyof A];

type SameMajor = [typeof CONTRACT_MAJOR] extends [(typeof SNAPSHOT)["major"]] ? true : false;

// A snapshot import that does not resolve would make its types an error type, which passes every check here, silently:
// test/ui-contract.test.ts checks that each of them resolves.
type Verdict = [NotPromised<NewApi>] extends [never]
  ? SameMajor extends false
    ? "compatible"
    : [Incompatible<OldApi, NewApi>] extends [never]
      ? EventsBreak<OldEvent, NewEvent> extends false
        ? "compatible"
        : {
            problem: "an event an app of this major sends is not one the page takes";
            fix: "raise CONTRACT_MAJOR in apps/desktop/src/shared/contract.ts";
          }
      : {
          problem: "these methods were removed, or an app of this major cannot serve them as the page calls them";
          methods: Incompatible<OldApi, NewApi>;
          fix: "raise CONTRACT_MAJOR in apps/desktop/src/shared/contract.ts";
        }
  : { problem: "these methods do not answer with a promise"; methods: NotPromised<NewApi> };

/** Fails to compile, saying why, when the page cannot run on every app of its contract major. */
export const UI_CONTRACT: Verdict = "compatible";
