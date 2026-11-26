// What the loop uses of the work-item tracker (itsaplan). The planning node sees a narrower one: `PlanningTracker`.

import type {
  BacklogRow,
  DocumentEntry,
  Issue,
  IssueComment,
  IssueDocument,
  LoopPhase,
  NewIssue,
  Priority,
  Stage,
} from "../types.ts";

export interface Tracker {
  /** The documents linked to the work item. */
  listIssueDocuments(issue: Pick<Issue, "id">): Promise<IssueDocument[]>;
  /** One document's Markdown. */
  getDocumentContent(docId: number): Promise<string>;
  /** The work items in the `Todo` column. Choosing among them is `pickNext`'s job, not the tracker's. */
  listTodo(): Promise<Issue[]>;
  get(number: number): Promise<Issue>;
  move(issue: Issue, stage: Stage): Promise<void>;
  comment(issue: Issue, text: string): Promise<void>;
  /**
   * Mirrors the loop's phase (and the time it began) onto the work item's custom fields; `null` clears both. A mirror
   * only: the run record is the truth. A tracker with no such fields does nothing.
   */
  setLoopPhase(issue: Issue, phase: LoopPhase | null, at: Date): Promise<void>;
  /** The project's active documents, without content. */
  listDocuments(): Promise<DocumentEntry[]>;
  /** A Markdown document under the document `parentId`. */
  createDocument(parentId: number, title: string, content: string): Promise<{ id: number }>;
  linkDocument(issue: Issue, docId: number): Promise<void>;
  /** Replaces the whole description. */
  setDescription(issue: Issue, description: string): Promise<void>;
  /** Returns the new issue's internal id and its number. */
  createIssue(input: NewIssue): Promise<{ id: number; number: number }>;
  /** A link from `from` to the issue whose internal id is `toId`. `blocks`: `from` blocks the other. */
  linkIssues(from: Issue, toId: number, kind: "relates" | "blocks"): Promise<void>;
  /** The work items in the Backlog column, read in full (CYC-322). */
  listBacklog(): Promise<Issue[]>;
  /** The work items in the In Progress column, read in full: the planning node shows their titles (CYC-322). */
  listInProgress(): Promise<Issue[]>;
  /** The Backlog as one list call returns it, without bodies: the planning node's cheap look for a change. */
  listBacklogRows(): Promise<BacklogRow[]>;
  /** Every comment on the issue, replies included, oldest first. */
  listComments(issue: Pick<Issue, "id" | "key">): Promise<IssueComment[]>;
  setTitle(issue: Issue, title: string): Promise<void>;
  setType(issue: Issue, typeId: number): Promise<void>;
  setPriority(issue: Issue, priority: Priority | null): Promise<void>;
  /** Adds or removes one label and keeps the others as the tracker has them now, not as `issue` had them. */
  addLabel(issue: Issue, labelId: number): Promise<void>;
  removeLabel(issue: Issue, labelId: number): Promise<void>;
}
