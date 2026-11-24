// What the agents ask the person and are waiting on: permission requests and forms. Each is held on its session
// (`Watched.pending`, so a renderer that reloads is given it) and indexed by its key, so an answer finds it at once.
import { randomUUID } from "node:crypto";
import type { ElicitationAnswer, PermissionAnswer } from "@cycle/client";
import type { PermissionRequest } from "@cycle/ui";
import type { Connection, Runtime } from "./runtime.ts";
import { emptyWatched, type Watched } from "./watcher.ts";

export type Pending = {
  request: PermissionRequest;
  /** The daemon's id for it, when it said (an older daemon does not). */
  requestId: string | undefined;
  answer: (answer: PermissionAnswer) => void;
  /** A form's own answer; `answer` then only dismisses it. */
  answerForm?: (answer: ElicitationAnswer) => void;
  /** Asked before the connection was lost and not asked again since: the daemon may have had it answered elsewhere. */
  stale: boolean;
};

/** Where a request waiting for an answer is held. */
type PendingAt = {
  environmentId: string;
  sessionId: string;
  connection: Connection;
  watched: Watched;
};

/** The sub-agent that asks, when one does: the daemon says so in `_meta["cycle/subagentId"]` (docs/protocol.md §9). */
const subagentOf = (request: Record<string, unknown>): { subagentId?: string } => {
  const meta = request._meta as Record<string, unknown> | null | undefined;
  const id = meta?.["cycle/subagentId"];
  return typeof id === "string" && id !== "" ? { subagentId: id } : {};
};

export class PendingStore {
  readonly #runtime: Runtime;
  /** Every request waiting for an answer, by its key: what the sessions' `pending` hold, across connections. */
  readonly #byKey = new Map<string, PendingAt>();

  constructor(runtime: Runtime) {
    this.#runtime = runtime;
  }

  /** The agent asks for permission. Held until the person answers, or something closes it without an answer. */
  ask(
    environmentId: string,
    connection: Connection,
    sessionId: string,
    request: Record<string, unknown>,
    requestId: string | undefined,
    form?: {
      form: { message: string; schema: unknown };
      resolve: (answer: ElicitationAnswer) => void;
    },
  ): Promise<PermissionAnswer> {
    const key = `${environmentId}:${sessionId}:${requestId ?? randomUUID()}`;
    return new Promise<PermissionAnswer>((resolve) => {
      let watched = connection.watched.get(sessionId);
      if (watched === undefined) {
        // Asked about a session not open here: nobody can answer it yet. Let the daemon ask again
        // when it is, rather than answering for the user.
        watched = emptyWatched();
        connection.watched.set(sessionId, watched);
      }
      const old = watched.pending.get(key);
      // The daemon asks again after a reconnect: the request is the same, the answer goes to the new ask.
      old?.answer({ outcome: "cancelled" });
      const built: PermissionRequest = {
        key,
        environmentId,
        sessionId,
        title: String(request.title ?? "Permission"),
        subject: request.subject,
        options: (request.options as PermissionRequest["options"]) ?? [],
        ...(form !== undefined ? { form: form.form } : {}),
        ...subagentOf(request),
      };
      watched.pending.set(key, {
        request: built,
        requestId,
        answer: resolve,
        ...(form !== undefined ? { answerForm: form.resolve } : {}),
        stale: false,
      });
      this.#byKey.set(key, { environmentId, sessionId, connection, watched });
      if (old === undefined) {
        watched.version += 1;
        this.#runtime.emit({ type: "permission", request: built, version: watched.version });
      }
    });
  }

  /**
   * The agent asks for answers (`elicitation/create`). Held like a permission request, so the card, a reload and the
   * daemon asking again after a reconnect work the same; anything that closes a request without an answer dismisses it.
   */
  askForm(
    environmentId: string,
    connection: Connection,
    sessionId: string,
    request: Record<string, unknown>,
    requestId: string | undefined,
  ): Promise<ElicitationAnswer> {
    return new Promise<ElicitationAnswer>((resolve) => {
      const form = {
        message: typeof request.message === "string" ? request.message : "",
        schema: request.requestedSchema,
      };
      void this.ask(environmentId, connection, sessionId, { title: form.message }, requestId, {
        form,
        resolve,
      }).then(() => resolve({ action: "cancel" }));
    });
  }

  async answerForm(key: string, answer: unknown): Promise<void> {
    const found = this.#find(key);
    if (found?.pending.answerForm === undefined) return;
    const { environmentId, sessionId, watched, pending } = found;
    // Only the fields the form asked for go on.
    const checked = formAnswerOf(answer, fieldsAsked(pending.request.form?.schema));
    pending.answerForm?.(checked);
    // The request that holds the form is settled too: it was answered, nothing waits on it.
    pending.answer({ outcome: "cancelled" });
    // What was done with it, never what was written in it.
    this.#runtime.track("form_answered", {
      outcome:
        checked.action === "accept"
          ? "answered"
          : checked.action === "decline"
            ? "declined"
            : "dismissed",
    });
    this.#close(environmentId, sessionId, watched, key);
  }

  async answer(key: string, optionId: string | "cancelled"): Promise<void> {
    const found = this.#find(key);
    if (found === undefined) return;
    const { environmentId, sessionId, watched, pending } = found;
    // A form is answered with `answerForm`; here it can only be dismissed.
    if (pending.answerForm !== undefined) {
      if (optionId === "cancelled") await this.answerForm(key, { action: "cancel" });
      return;
    }
    pending.answer(
      optionId === "cancelled" ? { outcome: "cancelled" } : { outcome: "selected", optionId },
    );
    // Which kind of answer (ACP names them allow_once, allow_always, reject_once, reject_always), never what was asked.
    const kind =
      optionId === "cancelled"
        ? "cancelled"
        : (pending.request.options.find((o) => o.optionId === optionId)?.kind ?? "");
    const outcome = kind.startsWith("allow")
      ? "allowed"
      : kind.startsWith("reject")
        ? "rejected"
        : kind === "cancelled"
          ? "cancelled"
          : undefined;
    // An answer that is none of these (an option of a kind this does not know) is not counted as another.
    if (outcome !== undefined)
      this.#runtime.track("permission_answered", {
        outcome,
        remembered: kind.endsWith("_always"),
        queued: watched.pending.size - 1,
      });
    this.#close(environmentId, sessionId, watched, key);
  }

  /** Answered somewhere else. Free this client's request, and close the dialog. */
  resolved(environmentId: string, connection: Connection, sessionId: string, requestId: string) {
    const watched = connection.watched.get(sessionId);
    const key = `${environmentId}:${sessionId}:${requestId}`;
    const pending = watched?.pending.get(key);
    if (watched === undefined || pending === undefined) return;
    pending.answer({ outcome: "cancelled" });
    this.#close(environmentId, sessionId, watched, key);
  }

  /**
   * A session was attached again and the daemon said which requests it still waits on (asking each again). One this
   * client had from before the loss and is not among them was answered by another client while it was away: its card
   * is closed. One asked since the loss is not touched, nor is any when the daemon does not say.
   */
  dropStale(
    environmentId: string,
    connection: Connection,
    sessionId: string,
    waiting: string[] | undefined,
  ): void {
    const watched = connection.watched.get(sessionId);
    if (watched === undefined || waiting === undefined) return;
    for (const [key, pending] of [...watched.pending]) {
      if (!pending.stale || pending.requestId === undefined) continue;
      if (waiting.includes(pending.requestId)) continue;
      pending.answer({ outcome: "cancelled" });
      this.#close(environmentId, sessionId, watched, key);
    }
  }

  /** The connection was lost: everything it was asked may be answered elsewhere before it is back. */
  markStale(connection: Connection): void {
    for (const watched of connection.watched.values())
      for (const pending of watched.pending.values()) pending.stale = true;
  }

  /**
   * What a connection, or one session of it, held is no longer held: forgotten, and with `cancel` answered cancelled
   * first, so nothing waits on it. The caller drops the session or the connection itself.
   */
  release(connection: Connection, { sessionId, cancel }: { sessionId?: string; cancel: boolean }) {
    const sessions =
      sessionId === undefined
        ? [...connection.watched.values()]
        : [connection.watched.get(sessionId)];
    for (const watched of sessions) {
      for (const [key, pending] of watched?.pending ?? []) {
        if (cancel) pending.answer({ outcome: "cancelled" });
        this.#byKey.delete(key);
      }
    }
  }

  clear(): void {
    this.#byKey.clear();
  }

  /**
   * The request waiting under `key`, if it still is: the index is checked against what holds the request, so a
   * connection that was replaced or a session no longer watched never answers.
   */
  #find(key: string): (PendingAt & { pending: Pending }) | undefined {
    const at = this.#byKey.get(key);
    if (at === undefined) return undefined;
    const pending = at.watched.pending.get(key);
    if (
      pending === undefined ||
      !this.#runtime.isCurrent(at.environmentId, at.connection) ||
      at.connection.watched.get(at.sessionId) !== at.watched
    ) {
      this.#byKey.delete(key);
      return undefined;
    }
    return { ...at, pending };
  }

  #close(environmentId: string, sessionId: string, watched: Watched, key: string): void {
    watched.pending.delete(key);
    if (this.#byKey.get(key)?.watched === watched) this.#byKey.delete(key);
    watched.version += 1;
    this.#runtime.emit({
      type: "permission-closed",
      environmentId,
      sessionId,
      key,
      version: watched.version,
    });
  }
}

/**
 * A form's answer as the page sent it, checked: the page is not trusted with what goes to the agent. Only `accept`
 * carries content, and only text, numbers, yes/no and lists of text; anything else is a dismissal.
 */
export const formAnswerOf = (answer: unknown, asked?: ReadonlySet<string>): ElicitationAnswer => {
  const given = (answer ?? {}) as { action?: unknown; content?: unknown };
  if (given.action === "decline") return { action: "decline" };
  if (given.action !== "accept" || typeof given.content !== "object" || given.content === null)
    return { action: "cancel" };
  const content: Record<string, string | number | boolean | string[]> = {};
  for (const [field, value] of Object.entries(given.content)) {
    if (asked !== undefined && !asked.has(field)) continue;
    if (typeof value === "string" || typeof value === "boolean") content[field] = value;
    else if (typeof value === "number" && Number.isFinite(value)) content[field] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string"))
      content[field] = value;
  }
  return { action: "accept", content };
};

/** The fields a form's schema asks for: its `properties`. */
const fieldsAsked = (schema: unknown): ReadonlySet<string> => {
  const properties = (schema as { properties?: unknown } | null | undefined)?.properties;
  return new Set(
    typeof properties === "object" && properties !== null ? Object.keys(properties) : [],
  );
};
