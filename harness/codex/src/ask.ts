// Codex asking the user (decision 0011): its `request_user_input` tool, and an MCP server's form elicitation. Both
// become an ACP form; the answer goes back in the shape Codex asked in.
import type {
  McpServerElicitationRequestParams,
  McpServerElicitationRequestResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
} from "./wire.generated.ts";

export type Form = { message: string; requestedSchema: Record<string, unknown> };
/** What came back: an answer, or nobody could be asked, or the turn ended first. */
export type FormAnswer =
  | {
      action: "accept" | "decline" | "cancel";
      content?: Record<string, unknown> | null | undefined;
    }
  | "unavailable"
  | "aborted";

const keyOf = (index: number) => `q${index}`;
const otherKeyOf = (index: number) => `q${index}_other`;
/** What a person may write for "Other". A limit, so that a form cannot carry a document. */
const OTHER_MAX = 2000;

/**
 * `request_user_input` as a form: each question a choice (`qN`) when it has options, and a free answer (`qN_other`)
 * when it may be answered in one's own words or has no options. Codex's questions take one answer each.
 */
export function questionForm(params: ToolRequestUserInputParams): Form {
  const properties: Record<string, unknown> = {};
  for (const [index, q] of params.questions.entries()) {
    const options = q.options ?? [];
    if (options.length > 0)
      properties[keyOf(index)] = {
        type: "string",
        title: q.header || q.question,
        description: q.question,
        oneOf: options.map((o) => ({
          const: o.label,
          title: o.label,
          ...(o.description ? { description: o.description } : {}),
        })),
      };
    if (q.isOther || options.length === 0)
      properties[otherKeyOf(index)] = {
        type: "string",
        title: options.length > 0 ? "Other" : q.header || q.question,
        description:
          options.length > 0 ? "Your own answer, if none of the choices fits" : q.question,
        maxLength: OTHER_MAX,
      };
  }
  return {
    message:
      params.questions.length === 1
        ? (params.questions[0]?.question ?? "Codex has a question")
        : "Codex has some questions",
    requestedSchema: { type: "object", properties },
  };
}

/** The tool's answers from the form's. A question left unanswered is left out; a written answer wins over a choice. */
export function questionAnswers(
  params: ToolRequestUserInputParams,
  answer: FormAnswer,
): ToolRequestUserInputResponse {
  const answers: ToolRequestUserInputResponse["answers"] = {};
  if (typeof answer !== "object" || answer.action !== "accept") return { answers };
  for (const [index, q] of params.questions.entries()) {
    const written = answer.content?.[otherKeyOf(index)];
    const other = typeof written === "string" ? written.trim().slice(0, OTHER_MAX) : "";
    const chosen = answer.content?.[keyOf(index)];
    const value = other !== "" ? other : typeof chosen === "string" ? chosen : "";
    if (value !== "") answers[q.id] = { answers: [value] };
  }
  return { answers };
}

/**
 * An MCP server's form, as it is. Any other mode is not asked: a web page to open (decision 0011), and OpenAI's own
 * form modes, whose schema is not MCP's.
 */
export function elicitationForm(params: McpServerElicitationRequestParams): Form | undefined {
  if (params.mode !== "form") return undefined;
  const schema = params.requestedSchema;
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return undefined;
  return {
    message: params.message,
    requestedSchema: schema as Record<string, unknown>,
  };
}

/** Nobody to ask is a decline, as an MCP client without forms would say; a turn that ended is a cancel. */
export function elicitationAnswer(
  answer: FormAnswer | undefined,
): McpServerElicitationRequestResponse {
  if (answer === undefined || answer === "unavailable")
    return { action: "decline", content: null, _meta: null };
  if (answer === "aborted") return { action: "cancel", content: null, _meta: null };
  return {
    action: answer.action,
    content: answer.action === "accept" ? ((answer.content ?? {}) as never) : null,
    _meta: null,
  };
}
