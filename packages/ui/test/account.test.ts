// The account in the page's store (CYCL-166): signed out, the locations are not read; signed in, they are.
import { expect, test } from "bun:test";
import type { AccountStatus } from "../src/api.ts";
import { AppStore } from "../src/store/index.ts";
import { fakeBridge, SIGNED_IN } from "./fake-bridge.ts";

const SIGNED_OUT: AccountStatus = { state: "signed-out", open: false, signingIn: false };

test("signed out: the page is ready with the sign-in page, and nothing of the locations is asked", async () => {
  const script = fakeBridge({ connected: true, account: SIGNED_OUT });
  const store = new AppStore(script.bridge);
  await store.start();
  expect(store.getState().ready).toBe(true);
  expect(store.getState().account).toEqual(SIGNED_OUT);
  expect(script.named("locations")).toHaveLength(0);

  // Signed in from the sign-in page: the locations are read then.
  await store.signIn();
  expect(store.getState().account?.open).toBe(true);
  await Bun.sleep(0);
  expect(script.named("locations")).toHaveLength(1);
  expect(store.getState().sessions.local?.map((s) => s.sessionId)).toEqual(["s1"]);
});

test("signed in: the locations are read at the start", async () => {
  const script = fakeBridge({ connected: true });
  const store = new AppStore(script.bridge);
  await store.start();
  expect(store.getState().account).toEqual(SIGNED_IN);
  expect(script.named("locations")).toHaveLength(1);
});

test("a change of the login comes as an event; someone else signing in is told until it is dismissed", async () => {
  const script = fakeBridge({ connected: true });
  const store = new AppStore(script.bridge);
  await store.start();
  script.emit({ type: "account", account: { ...SIGNED_IN, state: "reauth" } });
  expect(store.getState().account?.state).toBe("reauth");
  expect(store.getState().account?.open).toBe(true);

  script.emit({ type: "account", account: { ...SIGNED_IN, switched: true } });
  expect(store.getState().switchNoticeSeen).toBe(false);
  store.dismissSwitchNotice();
  expect(store.getState().switchNoticeSeen).toBe(true);
  // A renewal says it again: it is the same notice, still dismissed.
  script.emit({ type: "account", account: { ...SIGNED_IN, switched: true } });
  expect(store.getState().switchNoticeSeen).toBe(true);

  await store.signOut();
  expect(store.getState().account?.open).toBe(false);
  expect(script.named("signOut")).toHaveLength(1);
});
