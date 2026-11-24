import { expect, test } from "bun:test";
import { agent as acpAgent, client, methods } from "@agentclientprotocol/sdk/experimental/v2";
import { cycleMethod } from "@cycle/protocol";
import { z } from "zod";
import { elicitationAnswer, permissionOutcome as offeredOutcome, onCycle } from "../src/acp.ts";
import { INTERNAL_ERROR } from "../src/errors.ts";
import type { Fields, Logger } from "../src/logger.ts";

test("a client's permission answer reaches the agent only as a choice it offered, or a cancel", () => {
  const permissionOutcome = offeredOutcome([{ optionId: "allow" }, { optionId: "reject" }]);
  expect(permissionOutcome({ outcome: { outcome: "selected", optionId: "allow" } })).toEqual({
    outcome: "selected",
    optionId: "allow",
  });
  // What the client adds is not passed on, and what is not a choice is a cancel.
  expect(
    permissionOutcome({ outcome: { outcome: "selected", optionId: "allow", _meta: { x: 1 } } }),
  ).toEqual({ outcome: "selected", optionId: "allow" });
  for (const answer of [
    undefined,
    null,
    "allow",
    {},
    { outcome: "selected" },
    { outcome: { outcome: "selected" } },
    { outcome: { outcome: "selected", optionId: 7 } },
    // Not one it offered.
    { outcome: { outcome: "selected", optionId: "allow_always" } },
    { outcome: { outcome: "_vendor/thing" } },
    { outcome: { outcome: "cancelled" } },
  ]) {
    expect(permissionOutcome(answer)).toEqual({ outcome: "cancelled" });
  }
});

test("a client's form answer reaches the agent as its action and content, and nothing else", () => {
  expect(elicitationAnswer({ action: "accept", content: { name: "a" }, _meta: { x: 1 } })).toEqual({
    action: "accept",
    content: { name: "a" },
  });
  expect(elicitationAnswer({ action: "accept" })).toEqual({ action: "accept" });
  expect(elicitationAnswer({ action: "decline", content: { name: "a" } })).toEqual({
    action: "decline",
  });
  for (const answer of [undefined, null, {}, { action: "other" }, { action: "cancel" }]) {
    expect(elicitationAnswer(answer)).toEqual({ action: "cancel" });
  }
});

const echo = cycleMethod(
  "_cycle/test_echo",
  z.object({ n: z.number() }),
  z.object({ doubled: z.number() }),
);

const recording = (): { log: Logger; errors: [string, Fields | undefined][] } => {
  const errors: [string, Fields | undefined][] = [];
  const none = () => {};
  return {
    errors,
    log: {
      error: (event, fields) => errors.push([event, fields]),
      warn: none,
      info: none,
      debug: none,
    },
  };
};

const serve = (handler: (params: { n: number }) => unknown, log: Logger) => {
  const app = acpAgent({ name: "test" });
  app.onRequest(methods.agent.initialize, () => ({
    protocolVersion: 2,
    info: { name: "test", version: "0" },
    capabilities: {},
  }));
  // The handler is given as a method's would be; one that breaks the schema is what is being tested.
  onCycle(app, log, echo, handler as (params: { n: number }) => { doubled: number });
  const connection = client({ name: "test-client" }).connect(app);
  return connection;
};

test("a _cycle method's answer is checked against its result schema before it is sent", async () => {
  const { log, errors } = recording();
  const connection = serve(({ n }) => ({ doubled: n * 2 }), log);
  try {
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 2,
      info: { name: "test-client", version: "0" },
      capabilities: {},
    });
    expect(await connection.agent.request(echo.name, { n: 2 })).toEqual({ doubled: 4 });
    expect(errors).toEqual([]);
  } finally {
    connection.close();
  }
});

test("an answer the schema refuses is an internal error, logged by where it is wrong and not by what it holds", async () => {
  const { log, errors } = recording();
  const connection = serve(() => ({ doubled: "secret-value" }), log);
  try {
    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 2,
      info: { name: "test-client", version: "0" },
      capabilities: {},
    });
    const failed = await connection.agent.request(echo.name, { n: 2 }).then(
      () => undefined,
      (error: unknown) => error as { code?: number },
    );
    expect(failed?.code).toBe(INTERNAL_ERROR);
    expect(errors).toEqual([["result_invalid", { method: echo.name, paths: "doubled" }]]);
    expect(JSON.stringify(errors)).not.toContain("secret-value");
  } finally {
    connection.close();
  }
});
