// The workspace switcher: which folder the sidebar shows, and what is going on in the others. A workspace is a folder on
// one location (docs/desktop.md); a location that is not this computer shows as an icon whose name says which one.
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import type { LocationConfig, LocationStatus } from "../api.ts";
import type { Translator } from "../i18n.ts";
import { type Counts, type Elsewhere, URGENCY, urgent, type Workspace } from "../sessions.ts";
import { useI18n } from "./i18n.tsx";
import { ChevronDownIcon, ServerIcon } from "./icons.tsx";
import { LOCATION_STATE, MARK_WORD, StatusDot } from "./status.tsx";

const ELSEWHERE = {
  "needs-you": "workspace.elsewhere.needsYou",
  running: "workspace.elsewhere.running",
  background: "workspace.elsewhere.background",
  unread: "workspace.elsewhere.unread",
} as const;

/** In words, what the other workspaces have: "2 sessions need you, 1 session is unread". */
export const elsewhereText = (t: Translator["t"], counts: Counts): string => {
  const what = URGENCY.filter((m) => counts[m] > 0).map((m) =>
    t(ELSEWHERE[m], { count: counts[m] }),
  );
  return what.length === 0 ? "" : t("workspace.elsewhere.prefix", { what: what.join(", ") });
};

/** A square number: how many sessions are in the most urgent class; the words are for those who do not see it. */
function Badge({ counts }: { counts: Counts }) {
  const { t } = useI18n();
  const top = urgent(counts);
  if (top === undefined) return null;
  return (
    <>
      <span data-slot="badge" data-mark={top.mark} aria-hidden="true">
        {top.count}
      </span>
      <span data-slot="visually-hidden">
        {top.count}. {t(MARK_WORD[top.mark])}
      </span>
    </>
  );
}

/** Says a workspace is on another location, with which, and how it is connected: for the eye and for the reader. */
export function Remote({ location, state }: { location: LocationConfig; state: string }) {
  const { t } = useI18n();
  const tip = t("workspace.onState", { location: location.name, state });
  return (
    <span data-slot="remote" role="img" aria-label={tip} title={tip}>
      <ServerIcon size={14} />
    </span>
  );
}

export type WorkspaceSwitcherProps = {
  workspaces: readonly Workspace[];
  current: Workspace | undefined;
  elsewhere: Elsewhere;
  locations: readonly LocationConfig[];
  status: Record<string, LocationStatus>;
  onChoose: (workspaceKey: string) => void;
};

export function WorkspaceSwitcher(props: WorkspaceSwitcherProps) {
  const { t } = useI18n();
  const { workspaces, current, locations, status } = props;
  const locationOf = (id: string) => locations.find((h) => h.id === id);
  const stateOf = (id: string) => LOCATION_STATE[status[id]?.state ?? "closed"];
  const away = (id: string) => (status[id]?.state ?? "closed") !== "connected";
  const remote = (id: string) => {
    const location = locationOf(id);
    return location !== undefined && location.kind !== "local" ? location : undefined;
  };
  const elsewhere = elsewhereText(t, props.elsewhere.counts);
  const several = new Set(workspaces.map((w) => w.locationId)).size > 1;
  const groups = [...new Set(workspaces.map((w) => w.locationId))].map((locationId) => ({
    locationId,
    items: workspaces.filter((w) => w.locationId === locationId),
  }));
  const item = (w: Workspace) => {
    const location = remote(w.locationId);
    return (
      <MenuItem key={w.key} value={w.key} data-away={away(w.locationId) || undefined}>
        {location !== undefined ? (
          <Remote location={location} state={t(stateOf(w.locationId).word)} />
        ) : null}
        <span data-slot="workspace-name">{w.name}</span>
        <Badge counts={w.counts} />
      </MenuItem>
    );
  };
  if (current === undefined) {
    return (
      <span data-kind="workspace-switcher" data-empty="">
        {t("workspace.none")}
      </span>
    );
  }
  const location = remote(current.locationId);
  return (
    <Menu onAction={(value) => props.onChoose(String(value))}>
      <MenuTrigger
        data-variant="ghost"
        data-kind="workspace-switcher"
        data-away={away(current.locationId) || undefined}
        aria-label={[t("workspace.switch"), current.name, elsewhere]
          .filter((s) => s !== "")
          .join(". ")}
        title={t("workspace.switch")}
      >
        {location !== undefined ? (
          <Remote location={location} state={t(stateOf(current.locationId).word)} />
        ) : null}
        <span data-slot="workspace-name">{current.name}</span>
        <Badge counts={props.elsewhere.counts} />
        <ChevronDownIcon size={14} />
      </MenuTrigger>
      <MenuContent>
        {several
          ? groups.map((g) => {
              const how = stateOf(g.locationId);
              return (
                <MenuGroup key={g.locationId}>
                  <MenuGroupLabel>
                    <StatusDot tone={how.tone} shape={how.shape} />
                    {locationOf(g.locationId)?.name ?? g.locationId} · {t(how.word)}
                  </MenuGroupLabel>
                  {g.items.map(item)}
                </MenuGroup>
              );
            })
          : workspaces.map(item)}
      </MenuContent>
    </Menu>
  );
}
