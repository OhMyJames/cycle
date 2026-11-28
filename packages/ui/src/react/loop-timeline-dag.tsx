// A run's Task Graph as the graph it is: nodes in columns by how many nodes they wait for, an arrow from each node to
// the nodes that wait for it. The list this replaces showed the nodes in order but not who waits for whom. The layout is
// plain arithmetic on fixed-size cards (no measuring), so it is the same on every render and in tests.
import { useId } from "react";
import type { LoopTimelineStep } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { MessageIcon } from "./icons.tsx";

export const NODE_W = 232;
export const NODE_H = 120;
const GAP_X = 48;
const GAP_Y = 12;

export type DagNode = { step: LoopTimelineStep; x: number; y: number; column: number; row: number };
export type DagEdge = { from: string; to: string };
export type Dag = { nodes: DagNode[]; edges: DagEdge[]; width: number; height: number };

/** Columns by the longest chain of nodes before a node; rows ordered by where the node's dependencies sit. */
export const layoutDag = (steps: LoopTimelineStep[]): Dag => {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const depsOf = (s: LoopTimelineStep) =>
    [...new Set(s.dependsOn ?? [])].filter((d) => d !== s.id && byId.has(d));

  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (s: LoopTimelineStep): number => {
    const known = depth.get(s.id);
    if (known !== undefined) return known;
    // A cycle cannot come from Loop (it checks); if one did, the edge that closes it counts for nothing.
    if (visiting.has(s.id)) return 0;
    visiting.add(s.id);
    let d = 0;
    for (const dep of depsOf(s)) {
      const parent = byId.get(dep);
      if (parent !== undefined) d = Math.max(d, depthOf(parent) + 1);
    }
    visiting.delete(s.id);
    depth.set(s.id, d);
    return d;
  };

  const columns: LoopTimelineStep[][] = [];
  for (const s of steps) {
    const c = depthOf(s);
    const column = columns[c] ?? [];
    column.push(s);
    columns[c] = column;
  }
  const rowOf = new Map<string, number>();
  const rows = columns.map((col = []) => col);
  rows.forEach((col, c) => {
    if (c > 0) {
      const mean = (s: LoopTimelineStep) => {
        const deps = depsOf(s).map((d) => rowOf.get(d) ?? 0);
        return deps.length === 0 ? 0 : deps.reduce((a, b) => a + b, 0) / deps.length;
      };
      col.sort((a, b) => mean(a) - mean(b));
    }
    col.forEach((s, r) => {
      rowOf.set(s.id, r);
    });
  });

  const nodes: DagNode[] = [];
  rows.forEach((col, c) => {
    col.forEach((step, r) => {
      nodes.push({ step, column: c, row: r, x: c * (NODE_W + GAP_X), y: r * (NODE_H + GAP_Y) });
    });
  });
  // An edge must run to a later column; the one that would close a cycle does not.
  const columnOf = new Map(nodes.map((n) => [n.step.id, n.column]));
  const edges = steps.flatMap((s) =>
    depsOf(s)
      .filter((from) => (columnOf.get(from) ?? 0) < (columnOf.get(s.id) ?? 0))
      .map((from) => ({ from, to: s.id })),
  );
  const tallest = Math.max(0, ...rows.map((col) => col.length));
  return {
    nodes,
    edges,
    width: rows.length * NODE_W + Math.max(0, rows.length - 1) * GAP_X,
    height: tallest * NODE_H + Math.max(0, tallest - 1) * GAP_Y,
  };
};

/** Worth drawing as a graph: at least one node waits for another. A line of nodes reads fine as a list. */
export const hasDependencies = (steps: LoopTimelineStep[]): boolean => {
  const ids = new Set(steps.map((s) => s.id));
  return steps.some((s) => (s.dependsOn ?? []).some((d) => d !== s.id && ids.has(d)));
};

export function TimelineDag({
  steps,
  activeSessionId,
  tone,
  duration,
  onOpenSession,
}: {
  steps: LoopTimelineStep[];
  activeSessionId?: string | undefined;
  tone: (status: LoopTimelineStep["status"]) => string;
  duration: (step: LoopTimelineStep) => string | null;
  onOpenSession: (step: LoopTimelineStep) => void;
}) {
  const { t } = useI18n();
  const markerId = useId();
  const dag = layoutDag(steps);
  const at = new Map(dag.nodes.map((n) => [n.step.id, n]));
  const waitsFor = (id: string) =>
    dag.edges.filter((e) => e.to === id).map((e) => at.get(e.from)?.step.label ?? "");

  return (
    <div data-slot="loop-dag-scroll">
      <div data-slot="loop-dag" style={{ width: dag.width, height: dag.height }}>
        <svg
          data-slot="loop-dag-edges"
          width={dag.width}
          height={dag.height}
          viewBox={`0 0 ${dag.width} ${dag.height}`}
          aria-hidden="true"
        >
          <defs>
            <marker
              id={markerId}
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto"
            >
              <path d="M0 0.5 L7 4 L0 7.5 z" fill="currentColor" />
            </marker>
          </defs>
          {dag.edges.map((edge) => {
            const from = at.get(edge.from);
            const to = at.get(edge.to);
            if (from === undefined || to === undefined) return null;
            const x1 = from.x + NODE_W;
            const y1 = from.y + NODE_H / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_H / 2;
            const bend = (x2 - x1) / 2;
            return (
              <path
                key={`${edge.from}>${edge.to}`}
                data-slot="loop-dag-edge"
                data-state={tone(from.step.status)}
                d={`M${x1} ${y1} C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2} ${y2}`}
                markerEnd={`url(#${markerId})`}
              />
            );
          })}
        </svg>
        <ol data-slot="loop-dag-nodes" aria-label={t("loop.timeline.graph")}>
          {dag.nodes.map(({ step, x, y }) => {
            const stepTone = tone(step.status);
            const dur = duration(step);
            const note = step.error ?? step.summary;
            return (
              <li
                key={step.id}
                data-slot="loop-dag-node"
                data-state={stepTone}
                style={{ left: x, top: y, width: NODE_W, height: NODE_H }}
              >
                <span data-slot="loop-dag-node-head">
                  <span
                    data-slot="loop-timeline-step-dot"
                    data-state={stepTone}
                    aria-hidden="true"
                  />
                  <span data-slot="loop-dag-node-title" title={step.label}>
                    {step.label}
                  </span>
                  <span data-slot="visually-hidden">
                    {" "}
                    ({t(`loop.graph.status.${step.status}`)})
                  </span>
                  {dur !== null ? <span data-slot="loop-timeline-dur">{dur}</span> : null}
                </span>
                {waitsFor(step.id).length > 0 ? (
                  <span data-slot="visually-hidden">
                    {t("loop.timeline.waitsFor", { steps: waitsFor(step.id).join(", ") })}
                  </span>
                ) : null}
                {note !== null ? (
                  <span
                    data-slot="loop-dag-node-note"
                    data-tone={step.error !== null ? "attention" : undefined}
                    title={note}
                  >
                    {note}
                  </span>
                ) : null}
                {step.sessionId !== null ? (
                  <button
                    type="button"
                    data-slot="loop-timeline-session-btn"
                    data-active={step.sessionId === activeSessionId ? "" : undefined}
                    aria-label={t("loop.timeline.openSessionFor", { target: step.label })}
                    onClick={() => onOpenSession(step)}
                  >
                    <MessageIcon />
                    <span>{t("loop.timeline.openSession")}</span>
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
