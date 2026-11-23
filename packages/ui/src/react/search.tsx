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
import type { AgentInfo, EnvironmentConfig, EnvironmentStatus, SessionSummary } from "../api.ts";
import { agentLabel, markOf, workspacesOf } from "../sessions.ts";
import { useI18n } from "./i18n.tsx";
import { PlusIcon, SearchIcon } from "./icons.tsx";
import { sessionTitle } from "./sidebar.tsx";
import { ENVIRONMENT_STATE, MARK_STYLE, MARK_WORD, StatusDot } from "./status.tsx";
import { Remote } from "./workspace-switcher.tsx";

const NEW_SESSION = "action:new-session";

export type SearchDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environments: EnvironmentConfig[];
  status: Record<string, EnvironmentStatus>;
  sessions: Record<string, SessionSummary[]>;
  /** Each environment's agents, to say which a session is of where there is more than one. */
  agents: Record<string, AgentInfo[]>;
  onPick: (environmentId: string, sessionId: string) => void;
  onNewSession: () => void;
};

/**
 * Finds a session on any environment the app has read: by what the person remembers of it, which is what each row shows
 * (its title, its folder, its agent, its environment). The text of a conversation is not searched: the app holds only what it has
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
  // The sessions are found by workspace: a folder on one environment, as the switcher has them.
  const away = new Set(
    props.environments.filter((e) => props.status[e.id]?.state !== "connected").map((e) => e.id),
  );
  const workspaces = workspacesOf(
    props.environments.flatMap((e) => props.sessions[e.id] ?? []),
    {
      environments: props.environments.map((e) => ({
        id: e.id,
        name: e.name,
        local: e.kind === "local",
      })),
      away,
      showArchived: true,
    },
  );
  // A row's value names it; what it stands for is looked up, not parsed out of the text (an id may hold any character).
  const rowValue = (environmentId: string, sessionId: string) =>
    `session:${environmentId}/${sessionId}`;
  const rows = new Map<string, { environmentId: string; sessionId: string }>();
  for (const session of workspaces.flatMap((w) => w.sessions))
    rows.set(rowValue(session.environmentId, session.sessionId), {
      environmentId: session.environmentId,
      sessionId: session.sessionId,
    });
  const canCreate = props.environments.some((h) => props.status[h.id]?.state === "connected");
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
            if (row !== undefined) props.onPick(row.environmentId, row.sessionId);
          }}
        >
          <div data-slot="row">
            <SearchIcon />
            <CommandInput aria-label={t("search.label")} placeholder={t("search.placeholder")} />
          </div>
          <CommandEmpty>{t("search.empty")}</CommandEmpty>
          <CommandList>
            {workspaces.map((workspace) => {
              const environment = props.environments.find((e) => e.id === workspace.environmentId);
              return (
                <CommandGroup key={workspace.key}>
                  <CommandGroupLabel>
                    {environment !== undefined && environment.kind !== "local" ? (
                      <Remote
                        environment={environment}
                        state={t(
                          ENVIRONMENT_STATE[props.status[environment.id]?.state ?? "closed"].word,
                        )}
                      />
                    ) : null}
                    {workspace.name}
                  </CommandGroupLabel>
                  {workspace.sessions.map((session) => {
                    const mark = markOf(session, away);
                    const style = mark !== undefined ? MARK_STYLE[mark] : undefined;
                    const agent = agentLabel(props.agents[session.environmentId], session.agent);
                    return (
                      <CommandItem
                        key={rowValue(session.environmentId, session.sessionId)}
                        value={rowValue(session.environmentId, session.sessionId)}
                        keywords={[
                          workspace.name,
                          workspace.cwd,
                          session.agent,
                          agent ?? "",
                          environment?.name ?? "",
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
