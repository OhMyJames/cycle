// The second level of a work item (CYC-513, docs/protocol.md §17): its Task Graph. The board card shows it in short
// (`passed/total` and the node Loop is on); the drawer lists the nodes in topological order, auto-expanding running or
// stuck nodes, showing rounds/duration/commit/dependencies/files, a verified session jump, confirmed skip, and in-place
// edit (`edit_node`). Events carry only words and numbers, never node text.
import { Button } from "@ui-sdk/react/button";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Textarea } from "@ui-sdk/react/textarea";
import { useEffect, useRef, useState } from "react";
import type {
  LoopActFailure,
  LoopGraph,
  LoopGraphNode,
  LoopGraphNodeAction,
  LoopGraphNodeEdits,
  LoopGraphSource,
  LoopGraphSummary,
} from "../api.ts";
import { ConfirmDialog, FormDialog } from "./dialogs.tsx";
import { useI18n } from "./i18n.tsx";
import { ChevronDownIcon, ChevronRightIcon } from "./icons.tsx";
import { useNow } from "./now.ts";
import { useAppStore } from "./store-context.tsx";

/** The words the dictionary has for where a graph came from. */
const sourceWord = (source: LoopGraphSource): "plan_doc" | "auto_planner" | "single" =>
  source === "single"
    ? "single"
    : source === "auto_plan" || source === "auto_planner"
      ? "auto_planner"
      : "plan_doc";

/** `plan`: written in the plan document (or edited by hand); `auto`: made by the planner; `fix`: added to repair. */
const originWord = (node: LoopGraphNode, source: LoopGraphSource): "plan" | "auto" | "fix" =>
  node.origin === "fix" ? "fix" : sourceWord(source) === "auto_planner" ? "auto" : "plan";

/** Items with keys that stay unique when two read the same. */
const keyed = (items: string[]) => {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const n = seen.get(item) ?? 0;
    seen.set(item, n + 1);
    return { key: `${item}#${n}`, item };
  });
};

const NODE_TITLE_MAX = 200;
const NODE_GOAL_MAX = 4000;
const NODE_VERIFY_MAX = 20;
const NODE_VERIFY_LINE_MAX = 500;

const formatSpan = (
  startMs: number,
  endMs: number,
  t: (key: string, params?: Record<string, string | number>) => string,
): string | undefined => {
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return undefined;
  const minutes = Math.floor(Math.max(0, endMs - startMs) / 60_000);
  if (minutes < 1) return t("loop.run.underMinute");
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? t("loop.stage.hoursMinutes", { hours, minutes: minutes % 60 })
    : t("loop.stage.minutes", { minutes });
};

/** Only running nodes subscribe to the 30s clock; finished or paused nodes never tick. */
function LiveNodeDuration({ startedAt }: { startedAt: string }) {
  const { t } = useI18n();
  const now = useNow();
  const label = formatSpan(Date.parse(startedAt), now, t);
  return label !== undefined ? <span>{label}</span> : null;
}

/** The card's line for a run that has a graph: `2/5` and the node Loop is on. */
export function GraphProgress({ graph }: { graph: LoopGraphSummary }) {
  const { t } = useI18n();
  const stuck = graph.failed + graph.blocked > 0;
  return (
    <span
      data-slot="loop-graph-progress"
      data-stuck={stuck ? "" : undefined}
      title={t("loop.graph.progressLabel", { passed: graph.passed, total: graph.total })}
    >
      <span data-slot="loop-graph-count">
        {t("loop.graph.progress", { passed: graph.passed, total: graph.total })}
      </span>
      {graph.currentNodeTitle !== null ? (
        <span data-slot="loop-graph-current" title={graph.currentNodeTitle}>
          {t("loop.graph.current", { title: graph.currentNodeTitle })}
        </span>
      ) : null}
    </span>
  );
}

function GraphNode({
  node,
  titleById,
  busy,
  sessionMissing,
  onRetry,
  onSkip,
  onEdit,
  onOpen,
}: {
  node: LoopGraphNode;
  titleById: ReadonlyMap<string, string>;
  busy: boolean;
  sessionMissing: boolean;
  onRetry: (node: LoopGraphNode) => void;
  onSkip: (node: LoopGraphNode) => void;
  onEdit: (node: LoopGraphNode) => void;
  onOpen: (node: LoopGraphNode) => void;
}) {
  const { t } = useI18n();
  const stuck = node.status === "blocked" || node.status === "failed";
  const editable = stuck || node.status === "pending";
  const [open, setOpen] = useState(() => stuck || node.status === "running");
  const prevStatus = useRef(node.status);
  useEffect(() => {
    if (prevStatus.current === node.status) return;
    prevStatus.current = node.status;
    if (node.status === "running" || node.status === "blocked" || node.status === "failed")
      setOpen(true);
  }, [node.status]);
  const liveDuration =
    node.status === "running" && node.startedAt !== null && node.finishedAt === null;
  const staticDuration =
    !liveDuration && node.startedAt !== null && node.finishedAt !== null
      ? formatSpan(Date.parse(node.startedAt), Date.parse(node.finishedAt), t)
      : undefined;
  const shortSha = node.commitSha !== null ? node.commitSha.slice(0, 7) : undefined;
  const hasMeta =
    node.origin === "fix" ||
    node.rounds > 0 ||
    liveDuration ||
    staticDuration !== undefined ||
    shortSha !== undefined;
  const detail = [
    ["goal", node.goal],
    ["summary", node.summary],
    ["lastError", node.lastError],
  ] as const;

  return (
    <li data-slot="loop-graph-node" data-status={node.status} data-id={node.id}>
      <div data-slot="loop-graph-node-head">
        <button
          type="button"
          data-slot="loop-graph-toggle"
          aria-expanded={open}
          aria-label={t(open ? "loop.graph.collapse" : "loop.graph.expand", { title: node.title })}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          <span data-slot="loop-graph-node-title">{node.title}</span>
        </button>
        <span data-slot="loop-graph-status" data-status={node.status}>
          <span data-slot="loop-graph-dot" aria-hidden="true" />
          {t(`loop.graph.status.${node.status}`)}
        </span>
      </div>

      {hasMeta ? (
        <div data-slot="loop-graph-meta">
          {node.origin === "fix" ? (
            <span data-slot="loop-graph-tag">{t("loop.graph.fix")}</span>
          ) : null}
          {node.rounds > 0 ? <span>{t("loop.run.round", { count: node.rounds })}</span> : null}
          {liveDuration && node.startedAt !== null ? (
            <LiveNodeDuration startedAt={node.startedAt} />
          ) : staticDuration !== undefined ? (
            <span>{staticDuration}</span>
          ) : null}
          {shortSha !== undefined ? (
            <code data-slot="loop-graph-sha" title={`${t("loop.graph.commit")}: ${node.commitSha}`}>
              {shortSha}
            </code>
          ) : null}
        </div>
      ) : null}

      {open ? (
        <dl data-slot="loop-graph-detail">
          {detail.map(([name, text]) =>
            text !== null && text !== "" ? (
              <div key={name} data-slot="loop-graph-field" data-field={name}>
                <dt>{t(`loop.graph.${name}`)}</dt>
                <dd>{text}</dd>
              </div>
            ) : null,
          )}
          {node.dependsOn.length > 0 ? (
            <div data-slot="loop-graph-field" data-field="dependsOn">
              <dt>{t("loop.graph.dependsOn")}</dt>
              <dd>{node.dependsOn.map((id) => titleById.get(id) ?? id).join(", ")}</dd>
            </div>
          ) : null}
          {node.filesHint.length > 0 ? (
            <div data-slot="loop-graph-field" data-field="filesHint">
              <dt>{t("loop.graph.filesHint")}</dt>
              <dd>
                <ul data-slot="loop-graph-mono-list">
                  {keyed(node.filesHint).map(({ key, item }) => (
                    <li key={key}>{item}</li>
                  ))}
                </ul>
              </dd>
            </div>
          ) : null}
          <div data-slot="loop-graph-field" data-field="verify">
            <dt>{t("loop.graph.verify")}</dt>
            <dd>
              <ul data-slot="loop-graph-mono-list">
                {keyed(node.verify).map(({ key, item }) => (
                  <li key={key}>{item}</li>
                ))}
              </ul>
            </dd>
          </div>
        </dl>
      ) : null}

      {node.sessionId !== null || stuck || editable ? (
        <div data-slot="loop-graph-node-actions">
          {node.sessionId !== null ? (
            <Button
              data-variant="ghost"
              data-kind="loop-graph-open"
              aria-label={t("loop.graph.openSessionLabel", { title: node.title })}
              onClick={() => onOpen(node)}
            >
              {t("loop.graph.openSession")}
            </Button>
          ) : null}
          {stuck ? (
            <>
              <Button
                data-variant="outline"
                data-kind="loop-graph-retry_node"
                disabled={busy}
                aria-label={t("loop.graph.retryLabel", { title: node.title })}
                onClick={() => onRetry(node)}
              >
                {t("loop.graph.retry")}
              </Button>
              <Button
                data-variant="outline"
                data-kind="loop-graph-skip_node"
                disabled={busy}
                aria-label={t("loop.graph.skipLabel", { title: node.title })}
                onClick={() => onSkip(node)}
              >
                {t("loop.graph.skip")}
              </Button>
            </>
          ) : null}
          {editable ? (
            <Button
              data-variant="outline"
              data-kind="loop-graph-edit_node"
              disabled={busy}
              aria-label={t("loop.graph.editLabel", { title: node.title })}
              onClick={() => onEdit(node)}
            >
              {t("loop.graph.edit")}
            </Button>
          ) : null}
        </div>
      ) : null}

      {sessionMissing && node.sessionId !== null ? (
        <p data-slot="loop-problem" role="alert">
          {t("loop.graph.sessionMissing")}
        </p>
      ) : null}
    </li>
  );
}

/** The drawer's Execution Graph: the nodes in topological order, with what a person may do to each. */
export function ExecutionGraph({
  projectKey,
  identifier,
  graph,
  onChanged,
  onJoin,
}: {
  projectKey: string;
  identifier: string;
  graph: LoopGraph;
  /** A retry, skip or edit went through: the ticket is read again. */
  onChanged: () => void;
  /** The page is leaving the Loop for a session. */
  onJoin: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<LoopActFailure | undefined>();
  const [missingSessionNodeId, setMissingSessionNodeId] = useState<string | undefined>();
  const [skipping, setSkipping] = useState<LoopGraphNode | undefined>();
  const [editing, setEditing] = useState<LoopGraphNode | undefined>();
  const [editTitle, setEditTitle] = useState("");
  const [editGoal, setEditGoal] = useState("");
  const [editVerify, setEditVerify] = useState("");
  const [editProblem, setEditProblem] = useState<string | undefined>();
  const viewed = useRef<string | undefined>(undefined);

  useEffect(() => {
    // Once per ticket opened, not at each read of it.
    if (viewed.current === identifier) return;
    viewed.current = identifier;
    store.track("loop_graph_viewed", {
      node_count: graph.nodes.length,
      source: sourceWord(graph.source),
    });
  }, [store, identifier, graph.nodes.length, graph.source]);

  useEffect(() => {
    void identifier;
    setFailure(undefined);
    setMissingSessionNodeId(undefined);
    setSkipping(undefined);
    setEditing(undefined);
    setEditProblem(undefined);
  }, [identifier]);

  const act = async (
    node: LoopGraphNode,
    action: LoopGraphNodeAction,
    edits?: LoopGraphNodeEdits,
  ): Promise<LoopActFailure | undefined> => {
    setBusy(true);
    setFailure(undefined);
    setMissingSessionNodeId(undefined);
    const result = await store.actOnLoopGraph(projectKey, identifier, node.id, action, edits);
    setBusy(false);
    if (result.kind === "ok") {
      onChanged();
      return undefined;
    }
    if (action === "retry_node") setFailure(result.reason);
    return result.reason;
  };

  const openEdit = (node: LoopGraphNode) => {
    setEditTitle(node.title);
    setEditGoal(node.goal);
    setEditVerify(node.verify.join("\n"));
    setEditProblem(undefined);
    setEditing(node);
  };

  const trimmedTitle = editTitle.trim();
  const trimmedGoal = editGoal.trim();
  const parsedVerify = editVerify
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const titleValid = trimmedTitle !== "" && trimmedTitle.length <= NODE_TITLE_MAX;
  const goalValid = trimmedGoal !== "" && trimmedGoal.length <= NODE_GOAL_MAX;
  const verifyValid =
    parsedVerify.length > 0 &&
    parsedVerify.length <= NODE_VERIFY_MAX &&
    parsedVerify.every((line) => line.length <= NODE_VERIFY_LINE_MAX);
  const changedEdits: LoopGraphNodeEdits = {};
  if (editing !== undefined) {
    if (trimmedTitle !== editing.title) changedEdits.title = trimmedTitle;
    if (trimmedGoal !== editing.goal) changedEdits.goal = trimmedGoal;
    const verifyChanged =
      parsedVerify.length !== editing.verify.length ||
      parsedVerify.some((line, index) => line !== editing.verify[index]);
    if (verifyChanged) changedEdits.verify = parsedVerify;
  }
  const hasEdits =
    changedEdits.title !== undefined ||
    changedEdits.goal !== undefined ||
    changedEdits.verify !== undefined;
  const editReady = titleValid && goalValid && verifyValid && hasEdits;

  const submitEdit = async (): Promise<boolean> => {
    if (editing === undefined || !editReady) return false;
    setEditProblem(undefined);
    const reason = await act(editing, "edit_node", changedEdits);
    if (reason !== undefined) {
      setEditProblem(t(`loop.fail.${reason}`));
      return false;
    }
    return true;
  };

  const open = (node: LoopGraphNode) => {
    if (node.sessionId === null) return;
    store.track("loop_graph_node_opened", {
      status: node.status,
      origin: originWord(node, graph.source),
    });
    const ok = store.joinLoopSession(node.sessionId);
    if (ok) {
      setMissingSessionNodeId(undefined);
      onJoin();
    } else {
      setMissingSessionNodeId(node.id);
    }
  };

  const ordered = [...graph.nodes].sort((a, b) => a.position - b.position);
  const titleById = new Map(ordered.map((n) => [n.id, n.title]));
  const passed = graph.nodes.filter((n) => n.status === "passed").length;

  return (
    <section data-slot="loop-detail-section" data-kind="loop-graph">
      <header data-slot="loop-detail-section-head">
        <h4>{t("loop.graph.title")}</h4>
        <span data-slot="loop-column-count">
          {t("loop.graph.progress", { passed, total: graph.nodes.length })}
        </span>
      </header>
      <ol data-slot="loop-graph-list">
        {ordered.map((node) => (
          <GraphNode
            key={node.id}
            node={node}
            titleById={titleById}
            busy={busy}
            sessionMissing={missingSessionNodeId === node.id}
            onRetry={(n) => void act(n, "retry_node")}
            onSkip={(n) => setSkipping(n)}
            onEdit={openEdit}
            onOpen={open}
          />
        ))}
      </ol>
      {failure !== undefined ? (
        <p data-slot="loop-problem" data-kind="loop-graph-failure" role="alert">
          {t(`loop.fail.${failure}`)}
        </p>
      ) : null}

      {skipping !== undefined ? (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setSkipping(undefined);
          }}
          title={t("loop.graph.skipTitle")}
          description={t("loop.graph.skipBody")}
          detail={skipping.title}
          confirmLabel={t("loop.graph.skipConfirm")}
          destructive
          onConfirm={async () => {
            const reason = await act(skipping, "skip_node");
            return reason !== undefined ? t(`loop.fail.${reason}`) : undefined;
          }}
        />
      ) : null}

      {editing !== undefined ? (
        <FormDialog
          open
          kind="loop-graph-edit"
          title={t("loop.graph.editTitle")}
          description={t("loop.graph.editBody")}
          ready={editReady}
          submitLabel={t("loop.graph.save")}
          problem={editProblem}
          onSubmit={submitEdit}
          onClose={() => setEditing(undefined)}
        >
          <Field name="title">
            <FieldLabel>{t("loop.graph.nodeTitle")}</FieldLabel>
            <Input
              autoFocus
              maxLength={NODE_TITLE_MAX}
              value={editTitle}
              onChange={(event) => setEditTitle(event.currentTarget.value)}
            />
          </Field>
          <Field name="goal">
            <FieldLabel>{t("loop.graph.goal")}</FieldLabel>
            <Textarea
              rows={3}
              maxLength={NODE_GOAL_MAX}
              value={editGoal}
              onChange={(event) => setEditGoal(event.currentTarget.value)}
            />
          </Field>
          <Field name="verify">
            <FieldLabel>{t("loop.graph.verify")}</FieldLabel>
            <Textarea
              data-kind="loop-graph-verify"
              rows={3}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              value={editVerify}
              onChange={(event) => setEditVerify(event.currentTarget.value)}
            />
            <FieldDescription>{t("loop.graph.verifyHint")}</FieldDescription>
          </Field>
        </FormDialog>
      ) : null}
    </section>
  );
}
