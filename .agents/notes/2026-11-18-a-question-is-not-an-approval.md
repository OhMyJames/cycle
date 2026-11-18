# Agent Note: A question is not an approval

Status: accepted
Date: 2026-11-18
Basis: `docs/glossary.md` (Approval, Question), `docs/entities.md` (the two cards),
`docs/protocol-comparison.md` (codex's `item/tool/requestUserInput`, Claude Code's `AskUserQuestion`),
and the checks of this step: the `"answers" in response` tests that tell the two apart in three places,
that nothing in codex's path was tested, and the SDK's `unanswered` annotation on an `AskUserQuestion`
answer (`sdk-tools.d.ts`, Claude Code 2.1.325). It follows
`2026-11-18-the-protocol-is-entities-and-operations.md`, which says an approval and a question were one
thing with seven shapes and that a Question asks for content.

## Problem

A choice and an MCP server's form are answered with content; an approval is answered with a decision.
The code carried both as `Approval`, with `kind: "question"` and `kind: "elicitation"` beside the five
that ask leave, so a response was a union (`ApprovalAnswer | { answers }`) read by testing for a key:
`"answers" in response` in the Claude harness, in its translation, and in codex's reply. A decline of a
choice meant different things on each agent (codex answered `answers: {}`, Claude Code denied the tool),
and the page could not say what a session waited for.

## Decision

- **`Question`** is an entity of its own: `{ id, itemId }` and one of `choice` (`asks: Ask[]`), `form`
  (an MCP server's fields, or its schema as text when they cannot be drawn) or `link` (an MCP server's
  page). A link is an elicitation whose address is not null; a form is any other, so a request in `url`
  mode with no address reads as a form. The inner type that was called `Question` (one ask of a choice) is
  renamed `Ask`, fields unchanged.
- **`QuestionAnswer`** is `{ answers }` for a choice, and `{ action: "accept" | "decline" | "cancel",
  content? }` for a form or a link: the MCP specification's own words. `acceptForSession` means nothing
  for content and is not carried over. A client may say `decline` or `cancel` for a choice, which Claude
  Code takes as a deny, as for any tool, and codex as `answers: {}`; the page offers no button for it yet.
- **Events** `question.requested { sessionId, turnId | null, question }` and `question.resolved
  { sessionId, questionId }`, in `SessionEvent` beside the approval pair. **Wire** `question.answer
  { sessionId, questionId, answer }`. **Harness** `Sessions.answerQuestion(questionId, answer)` beside
  `respondApproval`. Ids are the agent's own, as an approval's are.
- **State.** `SessionState.questions` is folded as `approvals` is and emptied by `turn.completed`, so a
  stop or a crash leaves none. A session is `requires_action` while either list holds one. Nothing is
  stored: neither agent stores an approval or a question, and a reloaded session has none.
- **An answer to the wrong kind is an error.** Each harness keeps one map of what waits, its entries
  tagged `approval` or `question`; `respondApproval` on a question's id and `answerQuestion` on an
  approval's both throw. Claude Code's harness used to ignore an id it did not know, and still does for
  an id it holds no more (a late answer to a stopped turn), but not for one of the other kind.
- **A secret answer.** A choice may be `secret` (codex's `isSecret`). Its answer travels once, in
  `question.answer`, and the harness gives it to the agent: no event carries it, `question.resolved`
  holds an id only, and nothing of an answer goes to the log, to `sessions.json` or to the page's
  storage. A test pins that the frames of an answered `secret` question hold the question and not the
  answer.
- **A shim in the daemon, until the page moves.** Between the pull request that adds this and the one that
  removes the old form, the page still draws `approvals`. The hub, in `apps/daemon/src/legacy-asks.ts`,
  sends each question also as the approval the page knows, and turns an `approval.respond` for a question's
  id into `answerQuestion`. The harnesses emit the new events only, so their code and tests change once.
  The shim holds no list of its own: a question is open while the session's state holds it, so it is gone
  wherever the state's list is emptied. It is deleted with the old form.
- **Order.** When a question and an approval are both open the page shows the question first: the agent
  cannot go on without its content, and no rule can answer it. A choice cannot be dismissed on the page
  in this step. The words of the sidebar's mark and of the notification become "Needs you", since a
  session may wait on an answer. Both are the page's change, in the next pull request.
- **Left alone:** `Item`'s `agentMessage.questions`, a hint inside a message that is stored with the
  conversation and answered through the composer. Renaming it would change a stored item for a word. It
  is a third use of the word and stays until a later rename.

## Alternatives considered

- **One `Request` entity with `kind: approval | question`.** The answer shapes still differ, so the union
  stays and only moves.
- **Keep the kinds and rename `elicitation`.** It fixes a name and none of the three tests of
  `"answers" in`.
- **Let each harness emit both forms until the page moves.** Each harness's code and tests would carry the
  shim and be changed twice.
- **No shim: the page and the daemon change in one pull request.** The migration's own rule is to add,
  switch the page, then remove, so a page is never sent a state it cannot draw.
- **A `question` event on the wire for the page only, kept out of `SessionEvent`.** A replayed frame would
  not carry it, and the hub's activity would have to be told twice.
- **Use Claude Code's `unanswered` annotation (`skipped`, `replied_in_chat`, `dismissed`) to let a choice
  be dismissed.** It is a behavior and a design change (a "Skip" button, and what the agent is told);
  decide it when the page next changes for options.

## Consequences

- A client of the wire changes in step: it sends `question.answer` for a question, and `approval.respond`
  keeps its name and params. The daemon serves its own page, so a page and its daemon are one pair.
- The hub holds one shim for the length of one pull request, with a test for each way an id stops routing.
- A choice cannot be declined on the page, as before.
- A question and an approval open at once in a real session is pinned over a fake state only.
