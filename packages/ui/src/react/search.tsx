import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandItemIcon,
  CommandList,
} from "@ui-sdk/react/command";
import { Dialog, DialogBackdrop, DialogContent, DialogTitle } from "@ui-sdk/react/dialog";
import type { AgentInfo, LocationConfig, LocationStatus, SessionSummary } from "../api.ts";
import { agentLabel, markOf, workspacesOf } from "../sessions.ts";
import { useI18n } from "./i18n.tsx";
import { PlusIcon, SearchIcon } from "./icons.tsx";
import { sessionTitle } from "./sidebar.tsx";
import { LOCATION_STATE, MARK_STYLE, MARK_WORD, StatusDot } from "./status.tsx";
import { Remote } from "./workspace-switcher.tsx";

const NEW_SESSION = "action:new-session";

export type SearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  locations: LocationConfig[];
  status: Record<string, LocationStatus>;
  sessions: Record<string, SessionSummary[]>;
  /** Each location's agents, to say which a session is of where there is more than one. */
  agents: Record<string, AgentInfo[]>;
  onPick: (locationId: string, sessionId: string) => void;
  onNewSession: () => void;
};

/**
 * Finds a session on any location the app has read: by what the person remembers of it, which is what each row shows
 * (its title, its folder, its agent, its location). The text of a conversation is not searched: the app holds only what it has
 * opened, and a search of everything has to be done where the history is (the daemon).
 */
export function SearchDialog(props: SearchDialogProps) {
  const { t } = useI18n();
  if (!props.open) {
    return (
      <Dialog open={false} onOpenChange={props.onOpenChange}>
        <DialogBackdrop />
        <DialogContent data-palette="search">
          <DialogTitle>{t("search.label")}</DialogTitle>
        </DialogContent>
      </Dialog>
    );
  }
  // The sessions are found by workspace: a folder on one location, as the switcher has them.
  const away = new Set(
    props.locations.filter((e) => props.status[e.id]?.state !== "connected").map((e) => e.id),
  );
  const workspaces = workspacesOf(
    props.locations.flatMap((e) => props.sessions[e.id] ?? []),
    {
      locations: props.locations.map((e) => ({
        id: e.id,
        name: e.name,
        local: e.kind === "local",
      })),
      away,
      showArchived: true,
    },
  );
  // A row's value names it; what it stands for is looked up, not parsed out of the text (an id may hold any character).
  const rowValue = (locationId: string, sessionId: string) => `session:${locationId}/${sessionId}`;
  const rows = new Map<string, { locationId: string; sessionId: string }>();
  for (const session of workspaces.flatMap((w) => w.sessions))
    rows.set(rowValue(session.locationId, session.sessionId), {
      locationId: session.locationId,
      sessionId: session.sessionId,
    });
  const canCreate = props.locations.some((h) => props.status[h.id]?.state === "connected");
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogBackdrop />
      <DialogContent data-palette="search">
        <DialogTitle>{t("search.label")}</DialogTitle>
        <Command
          onAction={(value) => {
            props.onOpenChange(false);
            if (value === NEW_SESSION) return props.onNewSession();
            const row = rows.get(value);
            if (row !== undefined) props.onPick(row.locationId, row.sessionId);
          }}
        >
          <div data-slot="row">
            <SearchIcon />
            <CommandInput aria-label={t("search.label")} placeholder={t("search.placeholder")} />
          </div>
          <CommandEmpty>{t("search.empty")}</CommandEmpty>
          <CommandList>
            {workspaces.map((workspace) => {
              const location = props.locations.find((e) => e.id === workspace.locationId);
              return (
                <CommandGroup key={workspace.key}>
                  <CommandGroupLabel>
                    {location !== undefined && location.kind !== "local" ? (
                      <Remote
                        location={location}
                        state={t(LOCATION_STATE[props.status[location.id]?.state ?? "closed"].word)}
                      />
                    ) : null}
                    {workspace.name}
                  </CommandGroupLabel>
                  {workspace.sessions.map((session) => {
                    const mark = markOf(session, away);
                    const style = mark !== undefined ? MARK_STYLE[mark] : undefined;
                    const agent = agentLabel(props.agents[session.locationId], session.agent);
                    return (
                      <CommandItem
                        key={rowValue(session.locationId, session.sessionId)}
                        value={rowValue(session.locationId, session.sessionId)}
                        keywords={[
                          workspace.name,
                          workspace.cwd,
                          session.agent,
                          agent ?? "",
                          location?.name ?? "",
                        ]}
                      >
                        <CommandItemIcon>
                          {style !== undefined ? (
                            <StatusDot tone={style.tone} shape={style.shape} />
                          ) : null}
                        </CommandItemIcon>
                        <span data-slot="search-row">
                          <span data-slot="search-title">{sessionTitle(session)}</span>
                          <span data-slot="search-meta">
                            {mark !== undefined ? <span>{t(MARK_WORD[mark])}</span> : null}
                            {agent !== undefined ? <span>{agent}</span> : null}
                            {session.archived ? <span>{t("search.archived")}</span> : null}
                          </span>
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              );
            })}
            {canCreate ? (
              <CommandGroup>
                <CommandGroupLabel>{t("search.group.actions")}</CommandGroupLabel>
                <CommandItem value={NEW_SESSION}>
                  <CommandItemIcon>
                    <PlusIcon />
                  </CommandItemIcon>
                  {t("search.action.newSession")}
                </CommandItem>
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
