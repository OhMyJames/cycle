import { Button } from "@ui-sdk/react/button";
import { Listbox, ListboxGroup, ListboxGroupLabel, ListboxItem } from "@ui-sdk/react/listbox";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@ui-sdk/react/menu";
import { type RefObject, type SyntheticEvent, useRef, useState } from "react";
import type { SessionSummary } from "../api.ts";
import { markOf, type SessionGroup, type SessionList, sessionKey } from "../sessions.ts";
import { useI18n } from "./i18n.tsx";
import { MoreIcon, PinIcon, UnpinIcon } from "./icons.tsx";
import { RenameField, RenameProblem, useRename } from "./rename-field.tsx";
import { SessionAgent } from "./session-agent.tsx";
import { SessionTime } from "./session-time.tsx";
import { MARK_STYLE, MARK_WORD, StatusDot } from "./status.tsx";
import { useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

/** The last part of a path, for a session that has no title yet. */
const place = (cwd: string): string => cwd.split("/").filter(Boolean).at(-1) ?? cwd;

export const sessionTitle = (session: SessionSummary): string => {
  if (session.title !== undefined && session.title !== "") return session.title;
  return place(session.cwd);
};

/** An environment that is not connected, as a row of its sessions says it: who, and in what words. */
export type Away = { name: string; word: string };

/** What a row's own controls do that the list does not do itself: renaming is done in the row. */
export type RowAction = "pin" | "unpin" | "archive" | "restore" | "delete";

/**
 * A press on a row's controls, or in the menu they open (which React bubbles through its portal), is not a press on
 * the row: the list would open the session, and take the keys the menu needs.
 */
const keep = (event: SyntheticEvent) => event.stopPropagation();
const KEEP = { onPointerDown: keep, onMouseDown: keep, onKeyDown: keep, onDoubleClick: keep };

/**
 * What a row offers under the pointer, over its time: pin, then the session's menu. Neither takes a Tab stop, so the
 * arrow keys still walk the rows; from the keyboard the same is in the session header's menu.
 */
function RowActions({
  session,
  pinned,
  away,
  onAction,
  onRename,
  row,
}: {
  session: SessionSummary;
  pinned: boolean;
  away: boolean;
  onAction: (action: RowAction) => void;
  onRename: () => void;
  row: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  return (
    <span data-slot="session-actions">
      <Tip label={t(pinned ? "session.unpinTip" : "session.pinTip")}>
        <Button
          data-variant="ghost"
          data-kind="row-action"
          tabIndex={-1}
          {...KEEP}
          onClick={(event) => {
            keep(event);
            onAction(pinned ? "unpin" : "pin");
          }}
        >
          {pinned ? <UnpinIcon /> : <PinIcon />}
        </Button>
      </Tip>
      {away ? null : (
        <Menu
          onAction={(value) => {
            if (value === "rename") onRename();
            else onAction(value as RowAction);
          }}
        >
          <Tip label={t("session.moreActions")}>
            <MenuTrigger
              data-variant="ghost"
              data-kind="row-action"
              tabIndex={-1}
              {...KEEP}
              onClick={keep}
            >
              <MoreIcon />
            </MenuTrigger>
          </Tip>
          <MenuContent
            align="start"
            side="right"
            sideOffset={6}
            {...KEEP}
            onClick={keep}
            // Into the title's field when Rename was chosen, else back to the row, where the keys left off.
            finalFocus={() =>
              row.current?.querySelector<HTMLElement>('[data-kind="rename-field"]') ?? row.current
            }
          >
            <MenuItem value={pinned ? "unpin" : "pin"}>
              {t(pinned ? "session.unpin" : "session.pin")}
            </MenuItem>
            <MenuItem value="rename">{t("session.rename")}</MenuItem>
            <MenuItem value={session.archived ? "restore" : "archive"}>
              {t(session.archived ? "session.restore" : "session.archive")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem value="delete" data-destructive>
              {t("session.delete")}
            </MenuItem>
          </MenuContent>
        </Menu>
      )}
    </span>
  );
}

function Row({
  session,
  away,
  pinned,
  onAction,
}: {
  session: SessionSummary;
  away: Away | undefined;
  pinned: boolean;
  onAction: (session: SessionSummary, action: RowAction) => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const title = sessionTitle(session);
  const { shown, problem, finish } = useRename(title, (next) =>
    store.renameSession(session.sessionId, next, "sidebar", session.environmentId),
  );
  // Renamed in place by a double click or F2; not while its environment is away, where it could not be.
  const [editing, setEditing] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const tip =
    away !== undefined
      ? t("session.away", { environment: away.name, state: away.word })
      : undefined;
  // One thing a row says. A session of an environment that is away is the last list read: it says nothing.
  const mark = away !== undefined ? undefined : markOf(session);
  const style = mark !== undefined ? MARK_STYLE[mark] : undefined;
  return (
    <ListboxItem
      ref={rowRef}
      value={sessionKey(session)}
      data-session={session.sessionId}
      data-environment={session.environmentId}
      data-archived={session.archived || undefined}
      data-mark={mark}
      data-away={away !== undefined || undefined}
      data-editing={editing || undefined}
      data-pinned={pinned || undefined}
      title={tip}
      onDoubleClick={() => away === undefined && setEditing(true)}
      onKeyDown={(event) => {
        if (event.key !== "F2" || away !== undefined) return;
        event.preventDefault();
        setEditing(true);
      }}
    >
      <span data-slot="session-lead">
        {/* An away row's own title says why it is away: the logo does not cover it with the agent's name. */}
        <SessionAgent session={session} quiet={away !== undefined} />
      </span>
      {mark !== undefined ? <span data-slot="visually-hidden">{t(MARK_WORD[mark])}. </span> : null}
      {editing ? (
        <RenameField
          initial={title}
          onDone={(text, byKey) => {
            setEditing(false);
            finish(text);
            if (byKey) requestAnimationFrame(() => rowRef.current?.focus());
          }}
        />
      ) : (
        <>
          <span data-slot="session-title">{shown}</span>
          {/* A mark says more than the time does: it takes the time's place at the row's end. */}
          {style !== undefined ? (
            <span data-slot="session-dot">
              <StatusDot tone={style.tone} shape={style.shape} />
            </span>
          ) : (
            <SessionTime at={session.updatedAt} />
          )}
        </>
      )}
      {editing ? null : (
        <RowActions
          session={session}
          pinned={pinned}
          away={away !== undefined}
          onAction={(action) => onAction(session, action)}
          onRename={() => setEditing(true)}
          row={rowRef}
        />
      )}
      {editing ? null : <RenameProblem problem={problem} />}
    </ListboxItem>
  );
}

function Heading({ group }: { group: SessionGroup }) {
  const { t } = useI18n();
  switch (group.kind) {
    case "pinned":
      return t("sessions.group.pinned");
    case "needs-you":
      return t("sessions.group.needsYou");
    case "running":
      return t("sessions.group.running");
    case "today":
      return t("sessions.group.today");
    case "yesterday":
      return t("sessions.group.yesterday");
    case "earlier":
      return t("sessions.group.earlier");
  }
}

/** What waits on the person, what is running, then the days: one list, so the arrow keys walk all of it. */
export function SessionListView({
  list,
  selected,
  away,
  pinned,
  onSelect,
  onShowAll,
  onAction,
}: {
  list: SessionList;
  /** The open session, by its `sessionKey`. */
  selected: string | undefined;
  /** The environments that are not connected, by id. */
  away: ReadonlyMap<string, Away>;
  /** The pinned sessions, by `sessionKey`. */
  pinned: ReadonlySet<string>;
  onSelect: (session: SessionSummary) => void;
  onShowAll: () => void;
  onAction: (session: SessionSummary, action: RowAction) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <Listbox
        aria-label={t("sessions.listLabel")}
        value={selected ?? null}
        onValueChange={(next) => {
          const chosen = list.order.find((s) => sessionKey(s) === next);
          if (chosen !== undefined) onSelect(chosen);
        }}
      >
        {list.groups.map((group) => (
          <ListboxGroup key={group.key} data-kind={group.kind}>
            <ListboxGroupLabel>
              <Heading group={group} />
            </ListboxGroupLabel>
            {group.sessions.map((session) => (
              <Row
                key={sessionKey(session)}
                session={session}
                away={away.get(session.environmentId)}
                pinned={pinned.has(sessionKey(session))}
                onAction={onAction}
              />
            ))}
          </ListboxGroup>
        ))}
      </Listbox>
      {list.hidden > 0 ? (
        <button type="button" data-slot="show-all" onClick={onShowAll}>
          {t("sessions.showAll", { count: list.hidden })}
        </button>
      ) : null}
    </>
  );
}
