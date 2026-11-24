import { expect, test } from "bun:test";
import { type AgentInfo, agentsList, type ResultOf } from "@cycle/protocol";
import type { CycleClient } from "../src/index.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const same = <T extends true>(_proof?: T) => undefined;

// The same type, not one that looks like it: a field added to the schema reaches the client by itself.
same<Equal<Awaited<ReturnType<CycleClient["agents"]>>, ResultOf<typeof agentsList>>>(true);
const agent = {} as AgentInfo;
// Both can be read, and either can be absent.
const steer: boolean | undefined = agent.steer;
const image: object | null | undefined = agent.promptCapabilities?.image;
void steer;
void image;

test("an answer from an older daemon, without the optional capabilities, is still an answer", () => {
  const old = agentsList.result.parse({
    agents: [{ id: "claude", name: "Claude", available: true, configSchema: {} }],
  });
  expect(old.agents[0]?.steer).toBeUndefined();
  expect(old.agents[0]?.promptCapabilities).toBeUndefined();
  const current = agentsList.result.parse({
    agents: [
      {
        id: "claude",
        name: "Claude",
        available: true,
        configSchema: {},
        steer: true,
        promptCapabilities: { image: {}, embeddedContext: {} },
      },
    ],
  });
  expect(current.agents[0]?.steer).toBe(true);
  expect(current.agents[0]?.promptCapabilities?.embeddedContext).toEqual({});
});
