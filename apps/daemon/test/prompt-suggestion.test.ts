// What to say next (CYCL-225, docs/protocol.md §8): whether one is wanted goes from the client's prompt to every prompt
// the agent is given, and the agent's suggestion is kept only for the turn that ended, when one was wanted.
import { expect, test } from "bun:test";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { Daemon } from "../src/index.ts";
import { connectClient, type Seen, until } from "./client.ts";
import { fakeAgent, type Turn } from "./fake-agent.ts";
import { daemonHarness } from "./support.ts";

let dir: string;
const open = daemonHarness<Daemon>((made) => {
  dir = made;
});

const text = (value: string) => [{ type: "text" as const, text: value }];
const SUGGESTION = "_cycle/prompt_suggestion";
const suggestions = (seen: Seen[]) =>
  seen
    .filter((s) => s.update.sessionUpdate === SUGGESTION)
    .map((s) => (s.update as unknown as { suggestion: string }).suggestion);

/** A turn that ends, then says what could come next: as Claude does, after its result. */
const endThenSuggest = (suggestion: string) => async (turn: Turn) => {
  await turn.say({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  await turn.say({ sessionUpdate: SUGGESTION, suggestion });
  return "ended";
};

const setup = async (script: Parameters<typeof fakeAgent>[0]) => {
  const fake = fakeAgent(script);
  const daemon = await Daemon.start({ dataDir: dir, agents: [fake.definition] });
  open.push(daemon);
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: "/tmp" });
  await c.agent.request(methods.agent.session.resume, { sessionId, cwd: "/tmp" });
  const prompt = (value: string, wanted?: boolean) =>
    c.agent.request(methods.agent.session.prompt, {
      sessionId,
      prompt: text(value),
      ...(wanted !== undefined ? { _meta: { "cycle/promptSuggestions": wanted } } : {}),
    });
  const idles = () =>
    c.seen.filter(
      (s) =>
        s.update.sessionUpdate === "state_update" &&
        (s.update as { stopReason?: unknown }).stopReason !== undefined,
    ).length;
  return { fake, daemon, c, sessionId, prompt, idles };
};

test("a wanted suggestion is told and kept for a replay; the wish goes with every prompt the agent is given", async () => {
  const { fake, daemon, c, sessionId, prompt, idles } = await setup({
    onPrompt: endThenSuggest("run the tests"),
  });
  await prompt("first", true);
  await until(() => suggestions(c.seen).length === 1, "the suggestion");
  expect(suggestions(c.seen)).toEqual(["run the tests"]);
  // A record like any other: it has a seq.
  expect(c.seen.find((s) => s.update.sessionUpdate === SUGGESTION)?.seq).toBeNumber();
  expect(fake.log.promptMetas[0]).toEqual({ "cycle/promptSuggestions": true });
  // A later prompt that does not say keeps what was said last.
  await prompt("second");
  await until(() => idles() === 2 && suggestions(c.seen).length === 2, "the second turn");
  expect(fake.log.promptMetas[1]).toEqual({ "cycle/promptSuggestions": true });

  const late = await connectClient(daemon);
  await late.agent.request(methods.agent.session.resume, {
    sessionId,
    cwd: "/tmp",
    replayFrom: { type: "start" },
  });
  expect(suggestions(late.seen)).toEqual(["run the tests", "run the tests"]);
});

test("a suggestion nobody wanted is not kept, and neither is one not shaped as one", async () => {
  let said = "a guess";
  const { fake, c, prompt, idles } = await setup({
    onPrompt: (turn) => endThenSuggest(said)(turn),
  });
  // An older client says nothing: the agent is told nothing, and what it suggests anyway is dropped.
  await prompt("first");
  await until(() => idles() === 1, "the first turn");
  expect(fake.log.promptMetas[0]).toBeUndefined();
  await prompt("second", false);
  await until(() => idles() === 2, "the second turn");
  expect(fake.log.promptMetas[1]).toEqual({ "cycle/promptSuggestions": false });
  said = "   ";
  await prompt("third", true);
  await until(() => idles() === 3, "the third turn");
  // Something after it, to know the suggestion had its chance.
  await prompt("fourth", true);
  await until(() => idles() === 4, "the fourth turn");
  expect(suggestions(c.seen)).toEqual([]);
});

test("a suggestion that comes once the next prompt has been taken is stale and dropped", async () => {
  let late: (() => void) | undefined;
  const lateSaid = new Promise<void>((resolve) => {
    late = resolve;
  });
  let next: () => void = () => {};
  const taken = new Promise<void>((resolve) => {
    next = resolve;
  });
  const { c, prompt, idles } = await setup({
    onPrompt: async (turn) => {
      if (turn.prompt === "first") {
        await turn.say({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
        await taken;
        await turn.say({ sessionUpdate: SUGGESTION, suggestion: "too late" });
        late?.();
        return "ended";
      }
      await lateSaid;
      return undefined;
    },
  });
  await prompt("first", true);
  await until(() => idles() === 1, "the first turn");
  await prompt("second", true);
  next();
  await until(() => idles() === 2, "the second turn");
  expect(suggestions(c.seen)).toEqual([]);
});
