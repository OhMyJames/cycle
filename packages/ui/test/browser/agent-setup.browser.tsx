// Reading one agent's setup for the Harness and Subscriptions pages (agent-setup.ts): what each page shows is the newest
// answer, whatever order the answers come in.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test } from "vitest";
import type { AgentSetupSnapshot } from "../../src/api.ts";
import { useAgentSetup } from "../../src/react/agent-setup.ts";
import { StoreProvider } from "../../src/react/store-context.tsx";
import { AppStore } from "../../src/store/store.ts";
import { fakeBridge } from "../fake-bridge.ts";

afterEach(cleanup);

/** A setup that says which answer it was. */
const setup = (name: string) => ({ agent: "claude", name }) as AgentSetupSnapshot;

/** The hook over a bridge whose reads wait to be answered, in whatever order the test answers them. */
async function mount(readable = true) {
  const script = fakeBridge({ connected: true });
  const asked: { opts: unknown; answer: (snapshot: AgentSetupSnapshot | Error) => void }[] = [];
  script.bridge.readAgentSetup = (_locationId, _agent, opts) =>
    new Promise((resolve, reject) => {
      asked.push({
        opts,
        answer: (snapshot) => (snapshot instanceof Error ? reject(snapshot) : resolve(snapshot)),
      });
    });
  const store = new AppStore(script.bridge);
  await store.start();
  let applied = 0;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <StoreProvider store={store}>{children}</StoreProvider>
  );
  const hook = renderHook(() => useAgentSetup("local", "claude", readable, () => applied++), {
    wrapper,
  });
  const answer = (at: number, snapshot: AgentSetupSnapshot | Error) =>
    act(async () => asked[at]?.answer(snapshot));
  const changed = () =>
    act(async () =>
      script.emit({ type: "agent-setup-changed", locationId: "local", agent: "claude" }),
    );
  return { hook, asked, answer, changed, applied: () => applied };
}

test("it is read when shown, loading until the answer, which is kept", async () => {
  const { hook, asked, answer, applied } = await mount();
  expect(asked).toHaveLength(1);
  expect(hook.result.current.loading).toBe(true);
  await answer(0, setup("first"));
  expect(hook.result.current.snapshot?.name).toBe("first");
  expect(hook.result.current.loading).toBe(false);
  expect(applied()).toBe(1);
});

test("nothing is read when the daemon cannot say it", async () => {
  const { hook, asked } = await mount(false);
  expect(asked).toHaveLength(0);
  expect(hook.result.current.loading).toBe(false);
});

test("an older answer that comes after a newer one is dropped", async () => {
  const { hook, asked, answer } = await mount();
  act(() => {
    void hook.result.current.read({ forceRefresh: true });
  });
  await waitFor(() => expect(asked).toHaveLength(2));
  await answer(1, setup("newer"));
  await answer(0, setup("older"));
  expect(hook.result.current.snapshot?.name).toBe("newer");
});

test("a change there is read quietly: no spinner, and a failure of it says nothing", async () => {
  const { hook, asked, answer, changed } = await mount();
  await answer(0, setup("first"));
  await changed();
  await waitFor(() => expect(asked).toHaveLength(2));
  expect(asked[1]?.opts).toEqual({});
  expect(hook.result.current.loading).toBe(false);
  await answer(1, new Error("gone"));
  expect(hook.result.current.loadError).toBeUndefined();
  expect(hook.result.current.snapshot?.name).toBe("first");
});

test("a quiet read that overtakes a visible one does not leave it spinning", async () => {
  const { hook, asked, answer, changed } = await mount();
  await changed();
  await waitFor(() => expect(asked).toHaveLength(2));
  await answer(1, setup("quiet"));
  expect(hook.result.current.loading).toBe(true);
  await answer(0, setup("visible"));
  expect(hook.result.current.loading).toBe(false);
  // The visible one was older: what is shown is the quiet one's.
  expect(hook.result.current.snapshot?.name).toBe("quiet");
});

test("a visible read that fails says why", async () => {
  const { hook, answer } = await mount();
  await answer(0, new Error("daemon too old"));
  expect(hook.result.current.loadError).toBe("daemon too old");
  expect(hook.result.current.loading).toBe(false);
});

test("after a save is shown, no read sent before it replaces it", async () => {
  const { hook, answer } = await mount();
  act(() => {
    hook.result.current.setSnapshot(setup("saved"));
    hook.result.current.supersede();
  });
  await answer(0, setup("stale"));
  expect(hook.result.current.snapshot?.name).toBe("saved");
});
