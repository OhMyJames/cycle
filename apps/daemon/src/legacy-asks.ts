/**
 * A question as the page drew it before questions were their own: an approval of kind `question` or
 * `elicitation`, answered by `approval.respond`. The harnesses say only `question.*`; while the page
 * still draws approvals, the hub sends each question as both, and turns an answer to the approval
 * into an answer to the question.
 *
 * It holds no list of the questions that are open: the session's state does, and holds them for
 * exactly as long as it holds the legacy approval, so an id that is no longer open is no longer
 * routed to `answerQuestion`.
 *
 * shortcut: the page's old shape lives in the hub for one pull request; upgrade when the page draws
 * `questions` (step 08, the page), and delete this file with the old kinds (step 08, remove).
 */
import type {
  Approval,
  ApprovalResponse,
  Question,
  QuestionAnswer,
  SessionEvent,
} from "@cycle/protocol";

/** A question as the approval the page knows. */
export function legacyApproval(question: Question): Approval {
  const { id, itemId } = question;
  switch (question.kind) {
    case "choice":
      return { id, kind: "question", itemId, questions: question.asks };
    case "form":
      return {
        id,
        kind: "elicitation",
        itemId,
        server: question.server,
        message: question.message,
        url: null,
        fields: question.fields,
        schema: question.schema,
      };
    case "link":
      return {
        id,
        kind: "elicitation",
        itemId,
        server: question.server,
        message: question.message,
        url: question.url,
        fields: null,
        schema: null,
      };
  }
}

/** The page's answer to that approval, as an answer to the question. */
export function legacyAnswer(response: ApprovalResponse): QuestionAnswer {
  if ("answers" in response) return { answers: response.answers };
  const action = response.decision === "acceptForSession" ? "accept" : response.decision;
  return response.content ? { action, content: response.content } : { action };
}

/** What the page is also told when it is told of a question: the same, as an approval. */
export function legacyEvents(event: SessionEvent): SessionEvent[] {
  switch (event.type) {
    case "question.requested":
      return [
        {
          type: "approval.requested",
          sessionId: event.sessionId,
          turnId: event.turnId,
          approval: legacyApproval(event.question),
        },
      ];
    case "question.resolved":
      return [
        { type: "approval.resolved", sessionId: event.sessionId, approvalId: event.questionId },
      ];
    default:
      return [];
  }
}
