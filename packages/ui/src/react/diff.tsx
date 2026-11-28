// The Diff tab of the right panel (CYCL-95), in two views that each say what they cover
// (.agents/notes/2026-11-22-files-and-diff-sources.md):
// - This session: the edits the agent made with its file tools, by turn, from the conversation itself. Changes made by
//   commands are not in it, and it says so.
// - Workspace: the session's folder against HEAD, as the daemon's git says it (docs/protocol.md §8 "工作区的改动"),
//   in a trusted repository only. Whoever made them.
// Both are the panel's one shape: a bar (which view, how much changed, and the actions on all of it), then a row a file,
// its folder quiet and its name in ink, opening to its change across the panel's whole width.
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import {
  SegmentedControl,
  SegmentedControlIndicator,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { WorkspaceFile, WorkspacePatch, WorkspaceStatus } from "../api.ts";
import { insideFolder, shownPath } from "../files-view.ts";
import { diffLines, type SessionEdit, sessionEdits, type TurnEdits } from "../model/index.ts";
import { reveal, revealInDiff } from "../reveal.ts";
import { filesRootOf, viewKey } from "../store/index.ts";
import { useI18n } from "./i18n.tsx";
import {
  ChevronRightIcon,
  FolderIcon,
  FoldIcon,
  RefreshIcon,
  UnfoldIcon,
  WrapIcon,
} from "./icons.tsx";
import { PanelAction, PanelBar, PathLabel } from "./panel-parts.tsx";
import { StateBlock } from "./state-block.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Counts, DiffView } from "./tool.tsx";

export type DiffMode = "session" | "workspace";

type Load<T> =
  | { state: "loading" }
  | { state: "ok"; value: T }
  | { state: "error"; reason: string };

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * How many files "Expand all" opens: each draws its change, and in the workspace asks the daemon for it. Past this the
 * first ones open and the rest are a press each, rather than the panel standing still while hundreds are drawn.
 */
const EXPAND_ALL = 100;

/** How many files' changes are asked of the daemon at once: each is a git process there, on a machine with two cores. */
const READ_AT_ONCE = 4;

/** Runs what it is given a few at a time, in the order asked: the rest wait their turn. */
type Queue = <T>(run: () => Promise<T>) => Promise<T>;

const queueOf = (atOnce: number): Queue => {
  let running = 0;
  const waiting: (() => void)[] = [];
  return (run) =>
    new Promise((resolve, reject) => {
      const start = () => {
        running += 1;
        run()
          .then(resolve, reject)
          .finally(() => {
            running -= 1;
            waiting.shift()?.();
          });
      };
      if (running < atOnce) start();
      else waiting.push(start);
    });
};

/** Which files of a list are open, and the bar's action that opens or closes them all. */
function useOpenFiles(ids: readonly string[], view: DiffMode) {
  const store = useAppStore();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const set = useCallback((id: string, next: boolean) => {
    setOpen((old) => {
      if (old.has(id) === next) return old;
      const now = new Set(old);
      if (next) now.add(id);
      else now.delete(id);
      return now;
    });
  }, []);
  // Files that are in the list now: one that went (a change undone, a new round) is not counted as open.
  const some = ids.some((id) => open.has(id));
  const toggleAll = () => {
    setOpen(some ? new Set() : new Set(ids.slice(0, EXPAND_ALL)));
    store.track("diff_all_toggled", { open: !some, view });
  };
  return { open, set, some, toggleAll };
}

/** The actions on every file of a view: open or close them all, and whether long lines wrap. */
function ListActions({
  files,
  some,
  onToggleAll,
}: {
  files: number;
  some: boolean;
  onToggleAll: () => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const wrap = useSyncExternalStore(store.diffModes.subscribe, store.diffModes.wraps);
  if (files === 0) return null;
  return (
    <>
      <PanelAction label={t(some ? "diff.collapseAll" : "diff.expandAll")} onClick={onToggleAll}>
        {some ? <FoldIcon /> : <UnfoldIcon />}
      </PanelAction>
      <PanelAction
        label={t("diff.wrap")}
        pressed={wrap}
        onClick={() => {
          store.diffModes.setWrap(!wrap);
          store.track("diff_wrap_toggled", { wrap: !wrap });
        }}
      >
        <WrapIcon />
      </PanelAction>
    </>
  );
}

export function Diff() {
  const { t } = useI18n();
  const store = useAppStore();
  const locationId = useAppState((s) => s.selectedLocation);
  const sessionId = useAppState((s) => s.selectedSession);
  const key =
    locationId !== undefined && sessionId !== undefined
      ? viewKey(locationId, sessionId)
      : undefined;
  const conversation = useAppState((s) =>
    key !== undefined ? s.views[key]?.conversation : undefined,
  );
  const session = useAppState((s) =>
    locationId !== undefined
      ? s.sessions[locationId]?.find((x) => x.sessionId === sessionId)
      : undefined,
  );
  const canWorkspace = useAppState((s) =>
    locationId !== undefined ? s.status[locationId]?.capabilities?.diff === true : false,
  );
  // Kept by session in the store: the tab is unmounted while another is shown, and each session has its own.
  const mode =
    useSyncExternalStore(store.diffModes.subscribe, () =>
      key !== undefined ? store.diffModes.get(key) : undefined,
    ) ?? "session";
  const wrap = useSyncExternalStore(store.diffModes.subscribe, store.diffModes.wraps);
  const shown: DiffMode = canWorkspace ? mode : "session";

  if (key === undefined || locationId === undefined || sessionId === undefined)
    return (
      <div data-slot="diff">
        <StateBlock tone="empty" size="inline" title={t("overview.noSession")} />
      </div>
    );
  // Working, as opposed to stopped for a question: what it changed so far is on disk when it asks.
  const running = session?.state === "running";
  // Which view, first in each view's bar. A daemon that cannot compare has one view, which its bar names in words.
  const views = canWorkspace ? (
    <SegmentedControl
      value={shown}
      aria-label={t("diff.view")}
      onValueChange={(next) => {
        if ((next === "session" || next === "workspace") && next !== shown) {
          store.diffModes.set(key, next);
          store.track("diff_view_changed", { view: next });
        }
      }}
    >
      <SegmentedControlIndicator />
      <SegmentedControlItem value="session">{t("diff.view.session")}</SegmentedControlItem>
      <SegmentedControlItem value="workspace">{t("diff.view.workspace")}</SegmentedControlItem>
    </SegmentedControl>
  ) : (
    <span data-slot="panel-bar-title">{t("diff.view.session")}</span>
  );
  return (
    <div data-slot="diff" data-wrap={wrap || undefined}>
      {shown === "session" ? (
        <SessionView
          sessionKey={key}
          conversation={conversation}
          cwd={session?.cwd}
          views={views}
        />
      ) : (
        // One per session: another session's workspace and turns are its own.
        <WorkspaceView
          key={key}
          locationId={locationId}
          sessionId={sessionId}
          running={running}
          views={views}
        />
      )}
    </div>
  );
}

function SessionView({
  sessionKey,
  conversation,
  cwd,
  views,
}: {
  sessionKey: string;
  conversation: Parameters<typeof sessionEdits>[0] | undefined;
  cwd: string | undefined;
  views: ReactNode;
}) {
  const { t } = useI18n();
  const turns = useMemo(
    () => (conversation !== undefined ? sessionEdits(conversation) : []),
    [conversation],
  );
  const ids = useMemo(() => turns.flatMap((turn) => turn.edits.map((e) => e.toolId)), [turns]);
  const files = useOpenFiles(ids, "session");
  const additions = turns.reduce((n, turn) => n + turn.additions, 0);
  const deletions = turns.reduce((n, turn) => n + turn.deletions, 0);
  return (
    <>
      <PanelBar
        actions={<ListActions files={ids.length} some={files.some} onToggleAll={files.toggleAll} />}
      >
        {views}
        {ids.length > 0 ? <Counts additions={additions} deletions={deletions} /> : null}
      </PanelBar>
      {conversation === undefined ? (
        <StateBlock tone="loading" size="inline" title={t("overview.loading")} />
      ) : turns.length === 0 ? (
        <StateBlock
          tone="empty"
          size="inline"
          title={t("diff.session.empty")}
          body={t("diff.session.emptyBody")}
        />
      ) : (
        turns.map((turn) => (
          <TurnSection
            key={turn.turn}
            turn={turn}
            sessionKey={sessionKey}
            cwd={cwd}
            open={files.open}
            onOpen={files.set}
          />
        ))
      )}
      {/* What this view covers, under what it shows: said every time, since a change made by a command is not here. */}
      {conversation !== undefined ? <p data-slot="diff-scope">{t("diff.session.scope")}</p> : null}
    </>
  );
}

function TurnSection({
  turn,
  sessionKey,
  cwd,
  open,
  onOpen,
}: {
  turn: TurnEdits;
  sessionKey: string;
  cwd: string | undefined;
  open: ReadonlySet<string>;
  onOpen: (id: string, open: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <section data-slot="diff-turn">
      <div data-slot="diff-turn-head">
        <h2 title={turn.prompt}>{turn.prompt ?? t("diff.turn.untitled")}</h2>
        <Counts additions={turn.additions} deletions={turn.deletions} />
      </div>
      <ul data-slot="diff-files">
        {turn.edits.map((edit) => (
          <li key={edit.toolId}>
            <EditRow
              edit={edit}
              sessionKey={sessionKey}
              cwd={cwd}
              open={open.has(edit.toolId)}
              onOpen={onOpen}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What became of a file, as a letter after its name (git's), with the word for a screen reader and on hover. */
function Status({ letter, word, tone }: { letter: string; word: string; tone: "new" | "gone" }) {
  return (
    <span data-slot="diff-status" data-tone={tone} title={word}>
      <span aria-hidden="true">{letter}</span>
      <span data-slot="visually-hidden">{word}</span>
    </span>
  );
}

/** A file of either view: its row, and under it, open, what `children` show of its change. */
function FileRow({
  path,
  mark,
  open,
  onOpenChange,
  children,
  ref,
}: {
  path: string;
  /** After the path: what became of the file, and how much changed. */
  mark: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <Collapsible ref={ref} data-kind="diff-file" open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger data-kind="diff-row">
        <ChevronRightIcon size={12} data-slot="diff-chevron" aria-hidden="true" />
        <PathLabel path={path} />
        {mark}
      </CollapsibleTrigger>
      <CollapsiblePanel>{children}</CollapsiblePanel>
    </Collapsible>
  );
}

function EditRow({
  edit,
  sessionKey,
  cwd,
  open,
  onOpen,
}: {
  edit: SessionEdit;
  sessionKey: string;
  cwd: string | undefined;
  open: boolean;
  onOpen: (id: string, open: boolean) => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const row = useRef<HTMLDivElement>(null);
  // Asked for from the conversation (the header of the call's diff): opened, and brought into view.
  useEffect(() => {
    const check = () => {
      const asked = revealInDiff.get();
      if (asked === undefined || asked.sessionKey !== sessionKey || asked.itemId !== edit.toolId)
        return;
      revealInDiff.done(asked.serial);
      onOpen(edit.toolId, true);
      requestAnimationFrame(() => {
        row.current?.scrollIntoView({ block: "nearest" });
        row.current
          ?.querySelector<HTMLElement>('[data-kind="diff-row"]')
          ?.focus({ preventScroll: true });
      });
    };
    check();
    return revealInDiff.subscribe(check);
  }, [sessionKey, edit.toolId, onOpen]);
  const path = edit.path !== undefined ? shownPath(edit.path, cwd) : t("diff.noPath");
  // Inside the session's folder, and its daemon shows files: the file can be opened there.
  const filesRoot = useAppState(filesRootOf);
  const inFiles =
    edit.path !== undefined && filesRoot !== undefined && !edit.staged
      ? insideFolder(edit.path, filesRoot)
      : undefined;
  return (
    <FileRow
      ref={row}
      path={path}
      open={open}
      onOpenChange={(next) => {
        onOpen(edit.toolId, next);
        if (next) store.track("diff_file_opened", { view: "session" });
      }}
      mark={
        <>
          {edit.staged ? (
            // Held for review: shown as it would be, but the file on disk is as it was. In words: it is not git's.
            <span data-slot="diff-status">{t("tool.facts.staged")}</span>
          ) : edit.created ? (
            <Status letter="A" word={t("diff.status.created")} tone="new" />
          ) : null}
          <Counts additions={edit.additions} deletions={edit.deletions} />
        </>
      }
    >
      {edit.lines !== undefined ? (
        <DiffView lines={edit.lines} />
      ) : (
        <p data-slot="tool-note">{t("tool.diff.tooLarge")}</p>
      )}
      <div data-slot="diff-links">
        <button
          type="button"
          data-slot="diff-link"
          onClick={() => {
            store.track("diff_edit_revealed", {});
            reveal.request(sessionKey, edit.toolId);
          }}
        >
          {t("overview.showInConversation")}
        </button>
        {inFiles !== undefined ? (
          <button type="button" data-slot="diff-link" onClick={() => store.showInFiles(inFiles)}>
            {t("files.showInFiles")}
          </button>
        ) : null}
      </div>
    </FileRow>
  );
}

function WorkspaceView({
  locationId,
  sessionId,
  running,
  views,
}: {
  locationId: string;
  sessionId: string;
  running: boolean;
  views: ReactNode;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [status, setStatus] = useState<Load<WorkspaceStatus>>({ state: "loading" });
  const [round, setRound] = useState(0);
  // Read again when a turn of this session ends: what it changed is in the folder now.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) setRound((n) => n + 1);
    wasRunning.current = running;
  }, [running]);
  useEffect(() => {
    let current = true;
    // A new round reads over what is shown, so the list does not jump; a failure is replaced by the reading.
    setStatus((old) => (round > 0 && old.state === "ok" ? old : { state: "loading" }));
    store.workspaceStatus(locationId, sessionId).then(
      (value) => {
        if (current) setStatus({ state: "ok", value });
      },
      (error: unknown) => {
        if (current) setStatus({ state: "error", reason: reasonOf(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [store, locationId, sessionId, round]);
  const value = status.state === "ok" && status.value.state === "ok" ? status.value : undefined;
  // A repository inside has no change of its own to open.
  const ids = useMemo(
    () => (value?.files ?? []).filter((f) => f.folder !== true).map((f) => f.path),
    [value],
  );
  const files = useOpenFiles(ids, "workspace");
  // Every open file reads its change; "Expand all" opens many at once, so they take turns.
  const [queue] = useState(() => queueOf(READ_AT_ONCE));
  const again = () => setRound((n) => n + 1);
  const bar = (
    <PanelBar
      actions={
        <>
          <ListActions files={ids.length} some={files.some} onToggleAll={files.toggleAll} />
          {value !== undefined ? (
            <PanelAction label={t("files.refresh")} onClick={again}>
              <RefreshIcon />
            </PanelAction>
          ) : null}
        </>
      }
    >
      {views}
      {value !== undefined && value.files.length > 0 ? (
        <Counts
          additions={value.files.reduce((n, f) => n + (f.additions ?? 0), 0)}
          deletions={value.files.reduce((n, f) => n + (f.deletions ?? 0), 0)}
        />
      ) : null}
    </PanelBar>
  );
  if (status.state === "loading")
    return (
      <>
        {bar}
        <StateBlock tone="loading" size="inline" title={t("diff.workspace.loading")} />
      </>
    );
  if (status.state === "error")
    return (
      <>
        {bar}
        <StateBlock
          tone="error"
          size="inline"
          title={t("diff.workspace.failed")}
          reason={status.reason}
          action={{ label: t("files.retry"), onAction: again }}
        />
      </>
    );
  if (status.value.state === "not_git")
    return (
      <>
        {bar}
        <StateBlock
          tone="empty"
          size="inline"
          title={t("diff.workspace.notGit")}
          body={t("diff.workspace.notGitBody")}
          action={{ label: t("diff.workspace.checkAgain"), onAction: again }}
        />
      </>
    );
  if (status.value.state === "untrusted")
    return (
      <>
        {bar}
        <StateBlock
          tone="empty"
          size="inline"
          title={t("diff.workspace.untrusted")}
          body={t("diff.workspace.untrustedBody", { folder: status.value.repository })}
          // Trusted since in the workspace menu: asked again, it compares.
          action={{ label: t("diff.workspace.checkAgain"), onAction: again }}
        />
      </>
    );
  const { head, files: changed, truncated } = status.value;
  return (
    <>
      {bar}
      {changed.length === 0 ? (
        <StateBlock tone="empty" size="inline" title={t("diff.workspace.clean")} />
      ) : (
        <ul data-slot="diff-files">
          {changed.map((file) => (
            <li key={file.path}>
              <WorkspaceRow
                file={file}
                locationId={locationId}
                sessionId={sessionId}
                round={round}
                queue={queue}
                open={files.open.has(file.path)}
                onOpen={files.set}
              />
            </li>
          ))}
          {truncated ? (
            <li data-slot="files-quiet">
              {t("diff.workspace.truncated", { count: changed.length })}
            </li>
          ) : null}
        </ul>
      )}
      <p data-slot="diff-scope">
        {head !== null
          ? t("diff.workspace.against", { commit: head.slice(0, 7) })
          : t("diff.workspace.noCommit")}
      </p>
    </>
  );
}

const STATUS_KEY = {
  added: "diff.status.added",
  modified: "diff.status.modified",
  deleted: "diff.status.deleted",
  untracked: "diff.status.untracked",
} as const;

/** Git's letter for what became of a file. */
const STATUS_LETTER = { added: "A", modified: "M", deleted: "D", untracked: "U" } as const;

/** What became of a workspace file, after its name. Modified is what most are: it is said to a screen reader only. */
export function WorkspaceMark({ status }: { status: WorkspaceFile["status"] }) {
  const { t } = useI18n();
  const word = t(STATUS_KEY[status]);
  if (status === "modified") return <span data-slot="visually-hidden">{word}</span>;
  return (
    <Status
      letter={STATUS_LETTER[status]}
      word={word}
      tone={status === "deleted" ? "gone" : "new"}
    />
  );
}

function WorkspaceRow({
  file,
  locationId,
  sessionId,
  round,
  queue,
  open,
  onOpen,
}: {
  file: WorkspaceFile;
  locationId: string;
  sessionId: string;
  round: number;
  queue: Queue;
  open: boolean;
  onOpen: (id: string, open: boolean) => void;
}) {
  const { t } = useI18n();
  const store = useAppStore();
  const [patch, setPatch] = useState<Load<WorkspacePatch> | undefined>(undefined);
  // Which read is current: an answer to an older one (before a new round, a Retry, or after the row went) is dropped.
  const reading = useRef(0);
  useEffect(
    () => () => {
      reading.current += 1;
    },
    [],
  );
  const load = useCallback(() => {
    reading.current += 1;
    const serial = reading.current;
    // A new round reads over the change shown, so the list does not jump; a failure shown is replaced by the reading.
    setPatch((old) => (old?.state === "ok" ? old : { state: "loading" }));
    // Its turn come, a read nobody waits for any more (the row gone, or asked again since) is not made.
    void queue(async () => {
      if (reading.current !== serial) return;
      try {
        const value = await store.workspaceFile(locationId, sessionId, file.path);
        if (reading.current === serial) setPatch({ state: "ok", value });
      } catch (error) {
        if (reading.current === serial) setPatch({ state: "error", reason: reasonOf(error) });
      }
    });
  }, [store, locationId, sessionId, file.path, queue]);
  // Read when first opened, and again in a new round while open; a closed one is read when it opens.
  const readIn = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!open || readIn.current === round) return;
    readIn.current = round;
    load();
  }, [open, round, load]);
  const lines = useMemo(() => (patch?.state === "ok" ? diffLines(patch.value.patch) : []), [patch]);
  if (file.folder === true)
    // A repository inside, not tracked: no patch of its own. Its files are in the Files tab.
    return (
      <button
        type="button"
        data-kind="diff-row"
        title={t("files.showInFiles")}
        onClick={() => store.showInFiles(file.path, { folder: true })}
      >
        <FolderIcon size={12} data-slot="diff-chevron" />
        <PathLabel path={file.path} />
        <WorkspaceMark status={file.status} />
      </button>
    );
  return (
    <FileRow
      path={file.path}
      open={open}
      onOpenChange={(next) => {
        onOpen(file.path, next);
        if (next) store.track("diff_file_opened", { view: "workspace" });
      }}
      mark={
        <>
          <WorkspaceMark status={file.status} />
          {file.binary === true ? (
            <span data-slot="diff-status">{t("diff.binary")}</span>
          ) : (
            <Counts additions={file.additions} deletions={file.deletions} />
          )}
        </>
      }
    >
      {patch === undefined || patch.state === "loading" ? (
        <StateBlock tone="loading" size="inline" align="start" title={t("files.reading")} />
      ) : patch.state === "error" ? (
        <StateBlock
          tone="error"
          size="inline"
          align="start"
          title={t("diff.workspace.fileFailed")}
          reason={patch.reason}
          action={{ label: t("files.retry"), onAction: load }}
        />
      ) : patch.value.binary ? (
        <p data-slot="tool-note">{t("diff.binaryBody")}</p>
      ) : lines.length === 0 ? (
        <p data-slot="tool-note">{t("diff.noChange")}</p>
      ) : (
        <>
          <DiffView lines={lines} />
          {patch.value.truncated ? <p data-slot="tool-note">{t("diff.truncated")}</p> : null}
        </>
      )}
      {file.status !== "deleted" ? (
        <div data-slot="diff-links">
          <button type="button" data-slot="diff-link" onClick={() => store.showInFiles(file.path)}>
            {t("files.showInFiles")}
          </button>
        </div>
      ) : null}
    </FileRow>
  );
}
