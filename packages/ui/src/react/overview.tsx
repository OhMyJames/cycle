// The Overview tab of the right panel (CYCL-88): what the open session is doing besides its turns, read from what the
// daemon replays, so it is the same after a restart. From where it runs to what it is doing: the location, the goal
// (only when one is set), the context window, the todo list, the background, what is scheduled. The blocks with nothing to
// show are a line each at the end, saying why; what the agent does not report is said, not made up (.agents/notes/2026-11-22-overview-sources-and-layout.md).
import { Button } from "@ui-sdk/react/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { type ReactNode, useCallback, useId, useMemo } from "react";
import type { MessageKey } from "../messages/en-US.ts";
import {
  type BackgroundTask,
  type Conversation,
  contextOf,
  type DynamicConfigOption,
  latestPlan,
  type ScheduledJob,
  type TaskKind,
  type ToolItem,
} from "../model/index.ts";
import { reveal } from "../reveal.ts";
import { viewKey } from "../store/index.ts";
import { mergeConfigSchema, optionsOf, type Property } from "./config-form.tsx";
import { ContextDetails } from "./context-details.tsx";
import { useI18n } from "./i18n.tsx";
import { ChevronRightIcon } from "./icons.tsx";
import { PlanList } from "./plan.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";

/** One line of the background: a sub-agent or a task, in the words the panel shows. */
export type BackgroundRow = {
  id: string;
  kind: TaskKind | "agent";
  title: string | undefined;
  state: "running" | "completed" | "failed" | "stopped" | "unknown";
  /** The call it began with, to go back to. */
  toolCallId: string | undefined;
};

const SUBAGENT_STATE: Record<string, BackgroundRow["state"]> = {
  running: "running",
  done: "completed",
  failed: "failed",
  stopped: "stopped",
  unknown: "unknown",
  dismissed: "stopped",
};

/**
 * What runs in the background, from the replayed history: the sub-agents sent to the background (on the calls that
 * started them) and the tasks that are not sub-agents. Running first, then unknown, then ended; each in the order it began.
 */
export const backgroundOf = (conversation: Conversation): BackgroundRow[] => {
  const agents = conversation.items.flatMap((item): BackgroundRow[] => {
    if (item.kind !== "tool" || item.subagent?.background !== true) return [];
    const tool = item as ToolItem;
    const input = tool.rawInput as { description?: unknown } | undefined;
    return [
      {
        id: tool.id,
        kind: "agent",
        title: typeof input?.description === "string" ? input.description : tool.title,
        state: SUBAGENT_STATE[tool.subagent?.state ?? "running"] ?? "running",
        toolCallId: tool.id,
      },
    ];
  });
  const tasks = conversation.tasks.map(
    (task: BackgroundTask): BackgroundRow => ({
      id: task.id,
      kind: task.kind,
      title: task.title,
      state: task.state,
      toolCallId: task.toolCallId,
    }),
  );
  const rank = (row: BackgroundRow) =>
    row.state === "running" ? 0 : row.state === "unknown" ? 1 : 2;
  return [...agents, ...tasks]
    .map((row, at) => ({ row, at }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.at - b.at)
    .map(({ row }) => row);
};

/** What each kind of background row is called, for a row with no title of its own. */
export const BACKGROUND_KIND: Record<BackgroundRow["kind"], MessageKey> = {
  agent: "overview.kind.agent",
  shell: "overview.kind.shell",
  monitor: "overview.kind.monitor",
  workflow: "overview.kind.workflow",
  mcp: "overview.kind.mcp",
  other: "overview.kind.other",
};

const STATE: Record<BackgroundRow["state"], MessageKey> = {
  running: "overview.state.running",
  completed: "overview.state.completed",
  failed: "overview.state.failed",
  stopped: "overview.state.stopped",
  unknown: "overview.state.unknown",
};

/** The settings the location block names, in this order. */
const SETTINGS = [
  ["model", "overview.model"],
  ["mode", "overview.mode"],
  ["effort", "overview.effort"],
] as const;

/**
 * What a setting is set to, named as the input box names it: the agent's live choice if it told one, else the session's
 * own setting, labelled from the agent's schema. "default" is said as such, not guessed at.
 */
const settingOf = (
  live: readonly DynamicConfigOption[],
  schema: Record<string, unknown> | undefined,
  config: Record<string, string> | undefined,
  id: string,
) => {
  const value = live.find((o) => o.configId === id)?.currentValue ?? config?.[id];
  if (value === undefined) return undefined;
  const properties = (mergeConfigSchema(schema ?? {}, live).properties ?? {}) as Record<
    string,
    Property
  >;
  const property = properties[id];
  const name =
    property === undefined ? undefined : optionsOf(property)?.find((o) => o.value === value)?.label;
  return { value, name: name ?? value };
};

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section data-slot="overview-section" aria-labelledby={id}>
      <header data-slot="overview-head">
        <h2 id={id}>{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

/** A line saying why a block is empty. */
const Quiet = ({ children }: { children: ReactNode }) => (
  <p data-slot="overview-quiet">{children}</p>
);

export function Overview() {
  const { t, number, date } = useI18n();
  const store = useAppStore();
  const locationId = useAppState((s) => s.selectedLocation);
  const sessionId = useAppState((s) => s.selectedSession);
  const key =
    locationId !== undefined && sessionId !== undefined
      ? viewKey(locationId, sessionId)
      : undefined;
  const view = useAppState((s) => (key !== undefined ? s.views[key] : undefined));
  const session = useAppState((s) =>
    locationId !== undefined
      ? s.sessions[locationId]?.find((x) => x.sessionId === sessionId)
      : undefined,
  );
  const location = useAppState((s) => s.locations.find((e) => e.id === locationId));
  const state = useAppState((s) =>
    locationId !== undefined ? s.status[locationId]?.state : undefined,
  );
  const agent = useAppState((s) =>
    locationId !== undefined && session !== undefined
      ? s.agents[locationId]?.find((a) => a.id === session.agent)
      : undefined,
  );
  const planUsage = useAppState((s) =>
    locationId !== undefined && session !== undefined
      ? s.planUsage[locationId]?.[session.agent]
      : undefined,
  );
  const contextTitle = useId();
  const conversation = view?.conversation;
  const background = useMemo(
    () => (conversation !== undefined ? backgroundOf(conversation) : []),
    [conversation],
  );
  const percentOf = useCallback(
    (v: number) =>
      v > 0 && v < 0.005
        ? t("composer.context.underPercent", { percent: number(0.01, { style: "percent" }) })
        : number(v, { style: "percent" }),
    [t, number],
  );

  if (key === undefined || conversation === undefined)
    return (
      <div data-slot="overview">
        <StateBlock tone="empty" size="inline" title={t("overview.noSession")} />
      </div>
    );
  if (view?.loading === true)
    return (
      <div data-slot="overview">
        <StateBlock tone="loading" size="inline" title={t("overview.loading")} />
      </div>
    );

  const goTo = (itemId: string, section: "todo" | "background" | "scheduled") => {
    store.track("overview_item_revealed", { section });
    reveal.request(key, itemId);
  };
  const plan = latestPlan(conversation);
  const done = plan?.entries.filter((e) => e.status === "completed").length ?? 0;
  const running = background.filter(
    (row) => row.state !== "completed" && row.state !== "failed" && row.state !== "stopped",
  );
  const ended = background.filter((row) => !running.includes(row));
  // Unknown is not counted as working (.agents/notes/2026-11-20-background-roster.md).
  const working = running.filter((row) => row.state === "running").length;
  const goal = conversation.goal;
  const away = state !== undefined && state !== "connected";
  // A time: on its own today, with the day on any other.
  const timeOf = (at: number) =>
    new Date(at).toDateString() === new Date().toDateString()
      ? date(at, { hour: "numeric", minute: "2-digit" })
      : date(at, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  // When the goal was set; not said when not known.
  const setAt = goal != null && goal.setAt > 0 ? goal.setAt : undefined;
  const when = setAt === undefined ? undefined : timeOf(setAt);
  const schedules = conversation.schedules;
  const goalLine =
    goal == null
      ? undefined
      : goal.iterations > 0
        ? when !== undefined
          ? t("overview.goal.checked", { count: goal.iterations, when })
          : t("overview.goal.checkedNoTime", { count: goal.iterations })
        : when !== undefined
          ? t("overview.goal.set", { when })
          : undefined;

  // The blocks that have nothing to show, each with why.
  const nothing: [title: string, why: string][] = [];
  if (plan === undefined) nothing.push([t("overview.todo"), t("overview.todo.empty")]);
  if (background.length === 0)
    nothing.push([t("overview.background"), t("overview.background.empty")]);
  if (schedules === undefined)
    nothing.push([t("overview.scheduled"), t("overview.scheduled.unknown")]);
  else if (schedules.jobs.length === 0)
    nothing.push([t("overview.scheduled"), t("overview.scheduled.empty")]);

  const row = (item: BackgroundRow) => {
    const label = (
      <>
        <span data-slot="overview-dot" data-state={item.state} aria-hidden="true" />
        <span data-slot="overview-lines">
          <span data-slot="overview-title">{item.title ?? t(BACKGROUND_KIND[item.kind])}</span>
          <span data-slot="overview-facts">
            {t(BACKGROUND_KIND[item.kind])} · {t(STATE[item.state])}
          </span>
        </span>
      </>
    );
    const toolCallId = item.toolCallId;
    // A task that is not a sub-agent, gone from the agent's list: the user can say it has ended.
    const dismissable =
      item.state === "unknown" &&
      item.kind !== "agent" &&
      session?.unknownBackground?.includes(item.id) === true;
    return (
      <li key={`${item.kind}:${item.id}`} data-state={item.state}>
        {toolCallId !== undefined ? (
          <button
            type="button"
            data-slot="overview-row"
            title={t("overview.showInConversation")}
            onClick={() => goTo(toolCallId, "background")}
          >
            {label}
          </button>
        ) : (
          <span data-slot="overview-row">{label}</span>
        )}
        {dismissable && session !== undefined ? (
          <button
            type="button"
            data-slot="overview-dismiss"
            onClick={() => void store.dismissBackground(session, [item.id])}
          >
            {t("overview.dismiss")}
          </button>
        ) : null}
      </li>
    );
  };

  const scheduledRow = (job: ScheduledJob) => {
    // Said as it was said: the agent's words for the schedule when it gave them, else the expression itself.
    const facts = [
      t(job.kind === "wakeup" ? "overview.scheduled.wakeup" : "overview.scheduled.cron"),
      job.kind === "cron" ? (job.humanSchedule ?? job.schedule) : undefined,
      job.kind === "cron" && !job.recurring ? t("overview.scheduled.once") : undefined,
      job.nextFireAt !== undefined
        ? t("overview.scheduled.next", { when: timeOf(job.nextFireAt) })
        : undefined,
      job.durable ? t("overview.scheduled.durable") : undefined,
    ].filter((f): f is string => f !== undefined);
    const title = job.prompt.split("\n")[0]?.trim() || facts[0];
    const label = (
      <>
        <span data-slot="overview-dot" data-state="scheduled" aria-hidden="true" />
        <span data-slot="overview-lines">
          <span data-slot="overview-title" title={job.prompt}>
            {title}
          </span>
          <span data-slot="overview-facts">{facts.join(" · ")}</span>
        </span>
      </>
    );
    const toolCallId = job.toolCallId;
    return (
      <li key={job.id}>
        {toolCallId !== undefined ? (
          <button
            type="button"
            data-slot="overview-row"
            title={t("overview.showInConversation")}
            onClick={() => goTo(toolCallId, "scheduled")}
          >
            {label}
          </button>
        ) : (
          <span data-slot="overview-row">{label}</span>
        )}
      </li>
    );
  };

  return (
    <div data-slot="overview">
      {away ? (
        <p data-slot="overview-away" role="status">
          {t("overview.away", { location: location?.name ?? locationId ?? "" })}
        </p>
      ) : null}

      <Section title={t("overview.location")}>
        <dl data-slot="overview-facts-list">
          <dt>{t("overview.where")}</dt>
          <dd>{location?.name ?? locationId}</dd>
          <dt>{t("overview.folder")}</dt>
          <dd data-slot="overview-path" title={session?.cwd}>
            {session?.cwd ?? t("overview.unknown")}
          </dd>
          <dt>{t("overview.agent")}</dt>
          <dd>{agent?.name ?? session?.agent ?? t("overview.unknown")}</dd>
          {/* Which environment it was made with, and the names of its variables: never their values. */}
          {session?.environment !== undefined ? (
            <>
              <dt>{t("overview.environment")}</dt>
              <dd data-slot="overview-environment">{session.environment.name}</dd>
              <dt>{t("overview.variables")}</dt>
              <dd data-slot="overview-variables">
                {session.environment.variableNames.length + session.environment.secretNames.length >
                0
                  ? [...session.environment.variableNames, ...session.environment.secretNames].map(
                      (name) => <code key={name}>{name}</code>,
                    )
                  : t("overview.variables.none")}
              </dd>
            </>
          ) : null}
          {SETTINGS.map(([id, label]) => {
            const setting = settingOf(
              conversation.configOptions,
              agent?.configSchema,
              session?.config,
              id,
            );
            if (setting === undefined) return null;
            return [
              <dt key={`${id}:t`}>{t(label)}</dt>,
              <dd key={`${id}:d`}>
                {setting.value === "default" ? t("overview.default") : setting.name}
              </dd>,
            ];
          })}
        </dl>
      </Section>

      {goal != null ? (
        <Section title={t("overview.goal")}>
          <p data-slot="overview-goal">{goal.condition}</p>
          {goalLine !== undefined ? <p data-slot="overview-quiet">{goalLine}</p> : null}
          {goal.lastReason !== undefined ? (
            <p data-slot="overview-reason">{goal.lastReason}</p>
          ) : null}
        </Section>
      ) : null}

      {/* The context details carry their own title, as in the popover of the composer. */}
      <section data-slot="overview-section" aria-labelledby={contextTitle}>
        <ContextDetails
          context={contextOf(conversation)}
          plan={planUsage}
          percentOf={percentOf}
          titleId={contextTitle}
        />
      </section>

      {plan !== undefined ? (
        <Section
          title={t("overview.todo")}
          aside={
            <span data-slot="overview-count">
              {t("plan.progress", { done, count: plan.entries.length })}
            </span>
          }
        >
          <PlanList entries={plan.entries} />
          <Button
            data-variant="ghost"
            data-kind="overview-link"
            onClick={() => goTo(plan.id, "todo")}
          >
            {t("overview.showInConversation")}
          </Button>
        </Section>
      ) : null}

      {background.length > 0 ? (
        <Section
          title={t("overview.background")}
          aside={
            working > 0 ? (
              <span data-slot="overview-count">
                {t("overview.background.running", { count: working })}
              </span>
            ) : undefined
          }
        >
          {running.length > 0 ? (
            <ul data-slot="overview-list">{running.map(row)}</ul>
          ) : (
            <Quiet>{t("overview.background.empty")}</Quiet>
          )}
          {ended.length > 0 ? (
            <Collapsible data-kind="overview-ended">
              <CollapsibleTrigger>
                {t("overview.background.ended", { count: ended.length })}{" "}
                <ChevronRightIcon size={12} data-slot="tool-chevron" aria-hidden="true" />
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <ul data-slot="overview-list">{ended.map(row)}</ul>
              </CollapsiblePanel>
            </Collapsible>
          ) : null}
        </Section>
      ) : null}

      {schedules !== undefined && schedules.jobs.length > 0 ? (
        <Section
          title={t("overview.scheduled")}
          aside={
            <span data-slot="overview-count">
              {t("overview.scheduled.count", { count: schedules.jobs.length })}
            </span>
          }
        >
          <ul data-slot="overview-list">{schedules.jobs.map(scheduledRow)}</ul>
          {schedules.dormant ? <Quiet>{t("overview.scheduled.dormant")}</Quiet> : null}
        </Section>
      ) : null}

      {/* The blocks with nothing in them, together at the end: a line each that says why, where a block each was
          most of a panel saying "nothing". Said, not left out: what the agent does not report is not made up. */}
      {nothing.length > 0 ? (
        <section
          data-slot="overview-section"
          data-kind="nothing"
          aria-label={t("overview.nothing")}
        >
          <dl data-slot="overview-facts-list">
            {nothing.map(([title, why]) => [
              <dt key={`${title}:t`}>{title}</dt>,
              <dd key={`${title}:d`}>{why}</dd>,
            ])}
          </dl>
        </section>
      ) : null}
    </div>
  );
}
