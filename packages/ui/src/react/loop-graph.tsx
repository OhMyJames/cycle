// The second level of a work item (CYC-513, docs/protocol.md §17): its Task Graph. The board card shows it in short
// (`passed/total` and the node Loop is on); the drawer lists the nodes in topological order, each with its detail, a way
// into its session, and retry / skip for a node that is stuck. Events carry only words and numbers, never node text.
import { Button } from "@ui-sdk/react/button";
import { useEffect, useRef, useState } from "react";
import type {
  LoopActFailure,
  LoopGraph,
  LoopGraphNode,
  LoopGraphNodeAction,
  LoopGraphSource,
  LoopGraphSummary,
} from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronDownIcon, ChevronRightIcon } from "./icons.tsx";
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
  busy,
  onAct,
  onOpen,
}: {
  node: LoopGraphNode;
  busy: boolean;
  onAct: (node: LoopGraphNode, action: LoopGraphNodeAction) => void;
  onOpen: (node: LoopGraphNode) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const stuck = node.status === "blocked" || node.status === "failed";
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
          <div data-slot="loop-graph-field" data-field="verify">
            <dt>{t("loop.graph.verify")}</dt>
            <dd>
              <ul>
                {keyed(node.verify).map(({ key, item }) => (
                  <li key={key}>{item}</li>
                ))}
              </ul>
            </dd>
          </div>
        </dl>
      ) : null}
      {node.sessionId !== null || stuck ? (
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
          {stuck
            ? (["retry_node", "skip_node"] as const).map((action) => (
                <Button
                  key={action}
                  data-variant="outline"
                  data-kind={`loop-graph-${action}`}
                  disabled={busy}
                  aria-label={t(
                    action === "retry_node" ? "loop.graph.retryLabel" : "loop.graph.skipLabel",
                    {
                      title: node.title,
                    },
                  )}
                  onClick={() => onAct(node, action)}
                >
                  {t(action === "retry_node" ? "loop.graph.retry" : "loop.graph.skip")}
                </Button>
              ))
            : null}
        </div>
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
  /** A retry or skip went through: the ticket is read again. */
  onChanged: () => void;
  /** The page is leaving the Loop for a session. */
  onJoin: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<LoopActFailure | undefined>();
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

  const act = async (node: LoopGraphNode, action: LoopGraphNodeAction) => {
    setBusy(true);
    setFailure(undefined);
    const result = await store.actOnLoopGraph(projectKey, identifier, node.id, action);
    setBusy(false);
    if (result.kind === "ok") onChanged();
    else setFailure(result.reason);
  };
  const open = (node: LoopGraphNode) => {
    if (node.sessionId === null) return;
    store.track("loop_graph_node_opened", {
      status: node.status,
      origin: originWord(node, graph.source),
    });
    // Loop sessions are made by the local daemon; the location that lists the session is used when it is known.
    const locationId =
      Object.entries(store.getState().sessions).find(([, list]) =>
        list.some((x) => x.sessionId === node.sessionId),
      )?.[0] ?? "local";
    onJoin();
    void store.selectSession(locationId, node.sessionId);
  };
  const ordered = [...graph.nodes].sort((a, b) => a.position - b.position);
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
            busy={busy}
            onAct={(n, action) => void act(n, action)}
            onOpen={open}
          />
        ))}
      </ol>
      {failure !== undefined ? (
        <p data-slot="loop-problem" data-kind="loop-graph-failure" role="alert">
          {t(`loop.fail.${failure}`)}
        </p>
      ) : null}
    </section>
  );
}
