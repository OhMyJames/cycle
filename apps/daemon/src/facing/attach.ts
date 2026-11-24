// Attaching to a session (docs/protocol.md §5 "补发"): `session/resume` replays its history from where the client
// asks, then follows it live. Replay and live updates are one path, the session's log.
import { type AgentApp, methods } from "@agentclientprotocol/sdk/experimental/v2";
import { META, QUEUE_UPDATE, type QueueEntry, ReplayFromSeqSchema } from "@cycle/protocol";
import { INVALID_PARAMS, RpcError } from "../errors.ts";
import { attach } from "../log/replay.ts";
import type { LogRecord } from "../log/types.ts";
import type { Attachment, Session } from "../session.ts";
import type { Core, Me } from "./core.ts";

const SESSION_UPDATE = methods.client.session.update;

/** What one attached client is sent of each record of a session's log. */
const deliver = (core: Core, session: Session, attachment: Attachment) => {
  return async (record: LogRecord) => {
    if (record.kind === "update") {
      const update = record.data as {
        sessionUpdate: string;
        entries?: QueueEntry[];
        returnId?: string;
      };
      await attachment.conn.notify(SESSION_UPDATE, {
        sessionId: session.id,
        update:
          update.sessionUpdate === QUEUE_UPDATE && update.returnId
            ? { sessionUpdate: QUEUE_UPDATE, entries: update.entries }
            : record.data,
        // The record's own time, as the log has it: the same live and in a replay (docs/protocol.md §5).
        _meta: { [META.seq]: record.seq, [META.ts]: record.ts },
      });
    } else if (record.kind === "request") {
      const id = (record.data as { requestId: string }).requestId;
      const pending = session.pending.get(id);
      if (pending !== undefined) core.offer(session, pending, attachment);
    }
  };
};

export const registerAttach = (app: AgentApp, core: Core, me: Me): void => {
  app.onRequest(methods.agent.session.resume, async ({ params }) => {
    const session = await core.session(params.sessionId);
    const raw = params.replayFrom as { type?: string } | null | undefined;
    let after = session.log.lastSeq();
    let replaying = false;
    if (raw !== undefined && raw !== null) {
      replaying = true;
      if (raw.type === "start") after = 0;
      else if (raw.type === "_cycle.seq") {
        const parsed = ReplayFromSeqSchema.safeParse(raw);
        if (!parsed.success)
          throw new RpcError(INVALID_PARAMS, "Bad replayFrom", { replayFrom: raw });
        after = parsed.data.after;
      } else throw new RpcError(INVALID_PARAMS, "Unknown replayFrom", { replayFrom: raw });
    }
    const conn = me();
    for (const old of session.attachments) {
      if (old.conn === conn) {
        old.detach();
        session.attachments.delete(old);
      }
    }
    const attachment: Attachment = { conn, ready: false, detach: () => {} };
    session.attachments.add(attachment);
    session.lastActive = core.now();
    try {
      const { detach } = await attach(
        session.log,
        after,
        deliver(core, session, attachment),
        async (replayedTo) => {
          // ACP v2: the replay is ended by one replay_complete, then the current state.
          if (replaying) {
            await conn.notify(SESSION_UPDATE, {
              sessionId: session.id,
              update: { sessionUpdate: "replay_complete" },
              _meta: { [META.seq]: replayedTo },
            });
          }
          await conn.notify(SESSION_UPDATE, { sessionId: session.id, update: session.snapshot() });
        },
      );
      attachment.detach = detach;
    } catch (error) {
      session.attachments.delete(attachment);
      throw error;
    }
    // Requests still waiting from before are asked of this client too.
    for (const pending of session.pending.values()) core.offer(session, pending, attachment);
    // A queue with no turn behind it was cut short by a restart. It is handed back now, after the
    // replay and the snapshot, so the client that attached is told while it is listening.
    attachment.ready = true;
    core.returnStale(session);
    core.offerReturn(session);
    // Which they are, so a client that had one before can tell it is not among them: answered elsewhere.
    return {
      configOptions: [],
      _meta: {
        [META.pending]: [...session.pending.values()]
          .filter((pending) => pending.asked.has(attachment))
          .map((pending) => pending.requestId),
      },
    };
  });
};
