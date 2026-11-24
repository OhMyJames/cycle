import { type AgentContext, methods } from "@agentclientprotocol/sdk/experimental/v2";
import type { CanUseTool, ElicitationRequest, Options } from "@anthropic-ai/claude-agent-sdk";
import { answersOf, formOf, type Question, questionsOf } from "./ask.ts";
import type { SessionState } from "./session.ts";
import { toolKind } from "./translate.ts";

type FormResponse = {
  action: string;
  content?: Record<string, unknown> | undefined;
  _meta?: Record<string, unknown>;
};

/** What asking for a form came to: an answer, the turn being cancelled, or no one to ask. */
type FormAnswer =
  | "aborted"
  | "unavailable"
  | { action: string; content?: Record<string, unknown> | undefined };

/** `_meta` key on the daemon's answer when no attached client could be asked (docs/protocol.md §9). */
const NO_CLIENT = "cycle/noClient";

/**
 * Who is asked, for which session: the client of the process. `canElicit` is asked at each question, not when the
 * process starts: a process outlives what the client said in `initialize`.
 */
export type Asker = { client: AgentContext; session: SessionState; canElicit: () => boolean };

/**
 * Asks the user a form, through the daemon. Ends when someone answers, or when the turn is
 * cancelled or the process gives up on it (`signal`). `undefined`: it was cancelled.
 */
const askForm = async (
  { client, session, canElicit }: Asker,
  form: { message: string; requestedSchema: unknown },
  signal: AbortSignal,
): Promise<FormAnswer> => {
  // A client that did not say it can show a form is not sent one (ACP: the capability is the opt-in).
  if (!canElicit()) return "unavailable";
  const all = session.turn ? AbortSignal.any([signal, session.turn.permissions.signal]) : signal;
  let forget = () => {};
  const aborted = new Promise<"aborted">((resolve) => {
    if (all.aborted) resolve("aborted");
    const onAbort = () => resolve("aborted");
    all.addEventListener("abort", onAbort, { once: true });
    // The signal can be one that lives as long as the process: a listener is not left on it.
    forget = () => all.removeEventListener("abort", onAbort);
  });
  const answer = client
    .request(
      methods.client.elicitation.create,
      { sessionId: session.id, mode: "form", ...form } as never,
      { cancellationSignal: all, stopWaitingOnCancel: true },
    )
    .then(
      (r) => r as unknown as FormResponse,
      () => "failed" as const,
    );
  const response = await Promise.race([answer, aborted]).finally(forget);
  if (response === "aborted") return "aborted";
  // A request that failed (a host that does not know the method, a broken connection) is not the
  // user saying no: it is nobody to ask. Only an abort ends the turn.
  if (response === "failed") return all.aborted ? "aborted" : "unavailable";
  // Not an answer at all (a client that sent null): nobody to ask.
  if (typeof response !== "object" || response === null) return "unavailable";
  if (response._meta?.[NO_CLIENT] === true) return "unavailable";
  return { action: response.action, content: response.content };
};

/** An MCP server asks the user for input. Without a client that can answer it is declined. */
const elicit = async (asker: Asker, request: ElicitationRequest, signal: AbortSignal) => {
  if (request.mode === "url" || request.requestedSchema === undefined) {
    return { action: "decline" as const };
  }
  const answer = await askForm(
    asker,
    { message: request.message, requestedSchema: request.requestedSchema },
    signal,
  );
  if (answer === "aborted") return { action: "cancel" as const };
  if (answer === "unavailable") return { action: "decline" as const };
  if (answer.action === "accept") {
    return {
      action: "accept" as const,
      content: (answer.content ?? {}) as Record<string, string>,
    };
  }
  return { action: answer.action === "decline" ? ("decline" as const) : ("cancel" as const) };
};

/**
 * `AskUserQuestion` as a form. `undefined` when it cannot be one (no client can answer a form, or
 * the input is not what the tool takes): the caller asks it as a permission, which is what it was.
 */
const askQuestions = async (
  asker: Asker,
  input: Record<string, unknown>,
  context: { signal: AbortSignal },
): Promise<
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean }
  | undefined
> => {
  const questions: Question[] | undefined = questionsOf(input);
  if (questions === undefined) return undefined;
  const answer = await askForm(asker, formOf(questions), context.signal);
  if (answer === "aborted") return { behavior: "deny", message: "Cancelled", interrupt: true };
  if (answer === "unavailable") return undefined;
  // A dismissed form is a cancel, as a dismissed permission card is: it ends the turn. The daemon
  // answers a cancelled turn's forms this way before the cancel itself arrives.
  if (answer.action === "cancel")
    return { behavior: "deny", message: "Cancelled", interrupt: true };
  if (answer.action !== "accept") {
    return { behavior: "deny", message: "The user declined to answer" };
  }
  const answers = answersOf(questions, answer.content);
  // Nothing is required, so a form can come back empty: that is not an answer.
  if (Object.keys(answers).length === 0) {
    return { behavior: "deny", message: "The user did not answer" };
  }
  return { behavior: "allow", updatedInput: { ...input, answers } };
};

/**
 * Whether a tool may run, asked of the person as a permission card. `AskUserQuestion` is a form when someone can answer
 * one. A cancel of the turn ends the question.
 */
const canUseTool =
  (asker: Asker): CanUseTool =>
  async (toolName, toolInput, context) => {
    const { client, session } = asker;
    if (toolName === "AskUserQuestion") {
      const answered = await askQuestions(asker, toolInput, context);
      if (answered !== undefined) return answered;
      // Nobody behind the daemon can answer a form: it is a permission card, as it was.
    }
    // A cancel ends the question, whether or not the SDK also aborts the signal it gave us.
    const signal = session.turn
      ? AbortSignal.any([context.signal, session.turn.permissions.signal])
      : context.signal;
    const aborted = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Error("cancelled"));
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
    aborted.catch(() => undefined);
    // A sub-agent's call is asked for in its own session (ACP v2), so a client can say which one asks. The call is
    // known by the sub-agent's messages; the SDK's `agentID` only when it is a task that was announced.
    const owner =
      session.transcripts.ownerOf(context.toolUseID) ??
      (context.agentID !== undefined && session.subagents.announced(context.agentID)
        ? context.agentID
        : undefined);
    // Raced with the signal: a client that never answers must not hold the turn.
    const outcome = await Promise.race([
      client.request(
        methods.client.session.requestPermission,
        {
          sessionId: owner ?? session.id,
          title: `Allow ${toolName}?`,
          subject: {
            type: "tool_call",
            toolCall: {
              toolCallId: context.toolUseID,
              name: toolName,
              kind: toolKind(toolName),
              rawInput: toolInput,
            },
          },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        } as never,
        { cancellationSignal: signal, stopWaitingOnCancel: true },
      ),
      aborted,
    ]).catch((error) => {
      if (signal.aborted) return { outcome: { outcome: "cancelled" } };
      throw error;
    });
    const decision = (outcome as { outcome: { outcome: string; optionId?: string } }).outcome;
    if (decision.outcome === "selected" && decision.optionId === "allow") {
      return { behavior: "allow", updatedInput: toolInput };
    }
    return {
      behavior: "deny",
      message: decision.outcome === "cancelled" ? "Cancelled" : "The user denied it",
      ...(decision.outcome === "cancelled" ? { interrupt: true } : {}),
    };
  };

/** What a process is given to ask the person: whether a tool may run, and an MCP server's forms. */
export type AskingOptions = Required<Pick<Options, "canUseTool" | "onElicitation">>;

export const askingOptions = (asker: Asker): AskingOptions => ({
  canUseTool: canUseTool(asker),
  onElicitation: (request, { signal }) => elicit(asker, request, signal),
});
