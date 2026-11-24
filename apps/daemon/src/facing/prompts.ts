// Prompts and the queue (docs/protocol.md §8 "排队"): a prompt starts a turn, steers the running one, or waits for it
// to end; a cancel stops the turn and hands what waits back; a client takes back one that waits, or what was handed
// back to it.
import { randomUUID } from "node:crypto";
import { type AgentApp, methods } from "@agentclientprotocol/sdk/experimental/v2";
import {
  CycleErrorCode,
  checkPrompt,
  META,
  promptAckReturn,
  promptDequeue,
  QUEUE_LIMIT,
} from "@cycle/protocol";
import { INVALID_PARAMS, logUnavailable, queueFull, RpcError } from "../errors.ts";
import { firstTitle } from "../first-title.ts";
import { HISTORY_NOT_SAVED } from "../session.ts";
import { type Core, cycleOn, type Me } from "./core.ts";

export const registerPrompts = (app: AgentApp, core: Core, me: Me): void => {
  const cycle = cycleOn(app, core.log);
  app.onRequest(methods.agent.session.prompt, async ({ params }) => {
    const session = await core.session(params.sessionId);
    // A turn that could not be written down is not started: it would be lost on the next restart.
    if (session.historyError !== undefined) throw logUnavailable(session.id, session.historyError);
    // Refused whole, before anything is started or written: a block is never dropped (decision 0010).
    const problem = checkPrompt(
      params.prompt,
      core.definition(session.entry.agent).promptCapabilities,
    );
    if (problem !== undefined)
      throw new RpcError(INVALID_PARAMS, `The prompt cannot be sent: ${problem.reason}`, {
        sessionId: session.id,
        ...problem,
      });
    core.returnStale(session);
    // Taken: from now on the session is in the list (docs/protocol.md §6), whatever the agent makes of it. Not left to
    // the agent's echo of the message, which an agent that fails, or never echoes, would not send. Announced below.
    if (session.entry.prompted !== true) {
      // The first message names the session until the agent does (CYCL-224): as the agent's, so its own title
      // replaces it. Not a name the person gave, and not for an entry from before `prompted` was kept (it was prompted).
      const title =
        session.entry.prompted === false && session.entry.title === undefined
          ? firstTitle(params.prompt)
          : undefined;
      const named = title === undefined ? {} : { title, titleFromAgent: true };
      core.remember(session, { prompted: true, ...named }, false);
    }
    const busy = () => session.status() !== "idle" && session.status() !== "stopped";
    const meta = params._meta as Record<string, unknown> | null | undefined;
    const steer = meta?.[META.steer];
    // Whoever sent last says whether a suggestion of what to say next is wanted: it goes with every prompt from now.
    const suggestions = meta?.[META.promptSuggestions];
    if (typeof suggestions === "boolean") session.promptSuggestions = suggestions;
    if (busy() && steer === true) {
      // Into the running turn, where the agent can take it; otherwise it is queued as any other.
      const steered = await core.steer(session, params.prompt);
      if (steered !== undefined) return steered;
    }
    if (busy()) {
      // The agent is busy: the prompt waits here, and goes when the turn ends well.
      if (session.queue.length >= QUEUE_LIMIT) throw queueFull(session.id, QUEUE_LIMIT);
      const queueId = randomUUID();
      const queued = { queueId, prompt: params.prompt };
      session.queue.push(queued);
      if (!(await core.publishQueue(session))) {
        // Not on record, so not taken: the sender keeps what they wrote, and the queue is as it was.
        // (If the turn has ended meanwhile and sent it, it is gone from the queue and is not undone.)
        const at = session.queue.indexOf(queued);
        if (at >= 0) {
          session.queue.splice(at, 1);
          throw logUnavailable(session.id, session.historyError ?? HISTORY_NOT_SAVED);
        }
      }
      return { messageId: queueId, _meta: { [META.queued]: true } };
    }
    // Marked at once: the agent's own "running" comes later, and a second prompt must not slip in.
    session.agentState = "running";
    session.turnEnded = false;
    core.changed();
    try {
      return await core.send(session, params.prompt);
    } catch (error) {
      core.promptFailed(session, error);
      // The prompt never reached the agent, so no turn will end to send or return what was queued behind it.
      core.returnQueue(session, "error");
      throw error;
    }
  });

  app.onNotification(methods.agent.session.cancel, async ({ params }) => {
    const session = core.sessions.get(params.sessionId);
    if (session === undefined) return;
    // ACP: every pending permission request is answered "cancelled" when a turn is cancelled.
    for (const pending of [...session.pending.values()])
      core.settle(session, pending, pending.cancelled);
    // A stop means the person wants to change direction: what waits goes back to the input box.
    core.returnQueue(session, "cancelled");
    // The agent is still starting, or a prompt is still being made ready: there is no turn to stop, so what is about to
    // be given to it is held back.
    if (session.starting !== undefined || session.preparing > 0) session.startingCancels++;
    await session.link?.agent
      .notify(methods.agent.session.cancel, { sessionId: session.entry.agentSessionId })
      .catch(() => undefined);
  });

  cycle(promptAckReturn, async ({ sessionId, returnId }) => {
    return {
      acknowledged: await core.ackReturn(await core.session(sessionId), me(), returnId),
    };
  });
  cycle(promptDequeue, async (params) => {
    const session = await core.session(params.sessionId);
    const at = session.queue.findIndex((entry) => entry.queueId === params.queueId);
    const [entry] = at < 0 ? [] : session.queue.splice(at, 1);
    if (entry === undefined) {
      throw new RpcError(CycleErrorCode.NotQueued, "That prompt is not waiting", {
        sessionId: session.id,
        queueId: params.queueId,
      });
    }
    if (!(await core.publishQueue(session))) {
      // Not on record: the prompt stays where it was, and the person is told it did not come back.
      session.queue.splice(Math.min(at, session.queue.length), 0, entry);
      throw logUnavailable(session.id, session.historyError ?? HISTORY_NOT_SAVED);
    }
    return { prompt: entry.prompt };
  });
};
