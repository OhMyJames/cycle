import {
  type Plan,
  SESSION_MODES,
  type SessionInfo,
  type SessionMode,
  type Usage,
  activeTurn,
} from "@cycle/protocol";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type CycleApp, type Draft, projectOf, sessionTitle } from "../client/app.ts";
import { Store, useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { basename, compactNumber, tildePath } from "../lib/format.ts";
import { reviewArgument, reviewTarget } from "../lib/review.ts";
import {
  type Named,
  type PathRow,
  expandMentions,
  matchNames,
  matchPaths,
  matchSessions,
  matchSkills,
  mentionParts,
  mentionTitle,
  plainMentions,
  pluginPrompt,
  sectioned,
  skillRows,
} from "../lib/suggest.ts";
import { MorphLoader } from "../loader/morph-loader.tsx";
import { fileIcon } from "../lib/file-icons.ts";
import { Icon, type IconName, Spinner } from "./icons.tsx";
import { Chevron } from "./items.tsx";
import { PlanSteps } from "./plan.tsx";
import { Menu, type MenuEntry, MenuList } from "./menu.tsx";
import { ModelPicker } from "./model-picker.tsx";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export const MODE_LABELS: Record<SessionMode, { label: string; sub: string; icon: IconName }> = {
  readOnly: {
    label: "Ask first",
    sub: "Reads freely, asks before commands and edits",
    icon: "lock",
  },
  auto: { label: "Auto", sub: "Works inside the project, asks to leave it", icon: "automation" },
  fullAccess: { label: "Full access", sub: "Never asks, no sandbox", icon: "warning" },
};

interface Suggestion {
  label: string;
  /** What it is, on the same line. */
  detail?: string;
  /** The heading it is listed under. */
  group: string;
  icon?: IconName;
  /** Replaces the typed token with text, or runs something instead. */
  insert?: string;
  run?: () => void;
}

/** Sessions picked with `@`, by the title the composer shows: what is sent names each by its id. */
const mentioned = new Map<string, string>();

interface Trigger {
  kind: "@" | "/";
  query: string;
  start: number;
}

/** The `@file` or `/command` being typed at the caret, if any. */
export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const mention = /(^|\s)@([^\s@]*)$/.exec(before);
  if (mention) {
    const query = mention[2] ?? "";
    return { kind: "@", query, start: caret - query.length - 1 };
  }
  // Only at the very start: a slash later on is a path or a fraction.
  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { kind: "/", query: slash[1] ?? "", start: 0 };
  return null;
}

function readImage(file: File): Promise<string | null> {
  if (!file.type.startsWith("image/") || file.size > MAX_IMAGE_BYTES) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => resolve(null));
    reader.readAsDataURL(file);
  });
}

function ContextRing({ usage }: { usage: Usage | null }) {
  if (!usage?.contextWindow) return null;
  const used = Math.min(1, usage.last.total / usage.contextWindow);
  const percent = Math.round(used * 100);
  const length = 2 * Math.PI * 6;
  return (
    <span
      className="context-ring tabular"
      data-high={used > 0.8}
      title={`Context: ${compactNumber(usage.last.total)} of ${compactNumber(usage.contextWindow)} tokens (${percent}%). This session has used ${compactNumber(usage.total.total)} in all.`}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          opacity="0.18"
        />
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray={`${used * length} ${length}`}
          transform="rotate(-90 8 8)"
        />
      </svg>
      {percent}%
    </span>
  );
}

/**
 * The agent's plan, once, above the composer: how far it has come and the step it is on, opening to
 * every step. The loader runs only during a turn, since a step's would never stop once it ended.
 */
function PlanStrip({ plan }: { plan: Plan }) {
  const [open, setOpen] = useState(false);
  const done = plan.steps.filter((step) => step.status === "completed").length;
  const current = plan.steps.find((step) => step.status === "inProgress") ?? plan.steps[done];
  return (
    <div className="plan-strip" data-open={open}>
      <button type="button" className="strip" aria-expanded={open} onClick={() => setOpen(!open)}>
        <MorphLoader state="executing" />
        <span className="mono caption muted tabular">
          {done}/{plan.steps.length}
        </span>
        <span className="fade-x grow secondary">{current?.step ?? "Plan complete"}</span>
        <span className="progress" aria-hidden="true">
          <span style={{ width: `${(done / Math.max(plan.steps.length, 1)) * 100}%` }} />
        </span>
        <Chevron open={open} small />
      </button>
      {open ? <PlanSteps plan={plan} live /> : null}
    </div>
  );
}

function DraftOptions({ draft }: { draft: Draft }) {
  const app = useApp();
  const home = useStore(app.daemon, (daemon) => daemon?.userHome);
  const projects = useStore(app.settings, (settings) => settings?.projects ?? []);
  const [branch, setBranch] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    setBranch(undefined);
    app.request("git.branches", { cwd: draft.cwd }).then(
      (answer) => current && setBranch(answer.current ?? "(detached)"),
      () => current && setBranch(null),
    );
    return () => {
      current = false;
    };
  }, [app, draft.cwd]);
  const change = (patch: Partial<Draft>) => app.setView({ draft: { ...draft, ...patch } });
  const folders = (): MenuEntry[] => [
    ...projects.map((path): MenuEntry => ({
      label: basename(path),
      sub: tildePath(path, home),
      icon: "folder",
      checked: path === draft.cwd,
      onSelect: () => change({ cwd: path }),
    })),
    ...(projects.length ? [{ separator: true } as const] : []),
    { label: "Open folder…", icon: "plus", onSelect: () => void app.pickFolder() },
  ];
  return (
    <div className="draft-options">
      <div className="row">
        <Menu entries={folders} className="ghost" title="Where the session works">
          <Icon name="folder" />
          <span className="fade-x" title={tildePath(draft.cwd, home)}>
            {basename(draft.cwd)}
          </span>
          <Icon name="chevrons-up-down" size={14} className="muted" />
        </Menu>
        {branch ? (
          <span className="chip mono">
            <Icon name="git-branch" size={14} /> {branch}
          </span>
        ) : null}
        {branch ? (
          <label className="row meta">
            <input
              type="checkbox"
              checked={draft.worktree}
              onChange={(event) => change({ worktree: event.currentTarget.checked })}
            />
            New worktree
          </label>
        ) : null}
        {branch && draft.worktree ? (
          <input
            className="field small branch-field"
            placeholder="branch name (optional)"
            value={draft.branch}
            onChange={(event) => change({ branch: event.currentTarget.value })}
          />
        ) : null}
      </div>
      {branch === null || draft.worktree ? (
        <div className="caption muted hint-line">
          {branch === null
            ? "Not in a git repository: the session works in the folder itself."
            : "The session gets its own checkout on a new branch. Uncommitted changes are not carried over."}
        </div>
      ) : null}
    </div>
  );
}

const Key = ({ children }: { children: string }) => <kbd className="key">{children}</kbd>;
const Dot = () => <span aria-hidden="true">·</span>;

const NO_SESSION = new Store<{ state: null; loading: boolean; error: null }>({
  state: null,
  loading: false,
  error: null,
});

const command = (
  name: string,
  detail: string,
  icon: IconName,
  run: () => void,
): Suggestion & Named => ({ name, label: `/${name}`, detail, icon, group: "Commands", run });

function slashCommands(app: CycleApp, info: SessionInfo | null): (Suggestion & Named)[] {
  const list = [command("new", "Start a new session", "compose", () => app.newSession())];
  if (!info) return list;
  const sessionId = info.id;
  return [
    ...list,
    command("compact", "Summarize the conversation to free up context", "collapse", () => {
      void app.attempt(app.request("session.compact", { sessionId }));
    }),
    command(
      "review",
      "Review uncommitted changes, or a branch, a commit, or what you name",
      "eye",
      () => {
        void app.review(sessionId, { kind: "uncommitted" });
      },
    ),
    command("fork", "Continue in a copy of this session", "git-fork", () => {
      void app.fork(sessionId);
    }),
    command("diff", "Show what changed", "file-diff", () => app.setView({ panel: "changes" })),
    command("terminal", "Open a terminal here", "terminal", () => {
      app.setView({ panel: "terminal" });
    }),
    command("archive", "Archive this session", "archive", () => {
      app.updateSession({ sessionId, archived: true });
    }),
  ];
}

export function Composer({ sessionId }: { sessionId: string | null }) {
  const app = useApp();
  const draft = useStore(app.view, (view) => view.draft);
  const models = useStore(app.models, (value) => value);
  const returned = useStore(app.returned, (value) => value);
  const session = useStore(sessionId ? app.conversation(sessionId) : NO_SESSION, (conversation) => {
    const state = conversation.state;
    return {
      info: state?.info ?? null,
      running: state ? activeTurn(state) !== null || state.info.status === "running" : false,
      waiting: (state?.approvals.length ?? 0) > 0,
      plan: state?.plan ?? null,
      usage: state?.usage ?? null,
    };
  });
  const { info, running } = session;
  const key = sessionId ?? `new:${draft?.cwd ?? ""}`;
  const cwd = info?.cwd ?? draft?.cwd ?? "";

  const [text, setText] = useState(() => app.draftText(key));
  const [images, setImages] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<Trigger | null>(null);
  const lookup = useRef(0);
  const history = useRef(-1);

  // Each session keeps its own unsent text.
  useEffect(() => {
    setText(app.draftText(key));
    setImages([]);
    setSuggestions([]);
    history.current = -1;
    field.current?.focus();
  }, [app, key, returned]);

  useLayoutEffect(() => {
    const node = field.current;
    if (!node) return;
    node.style.height = "0";
    node.style.height = `${Math.min(node.scrollHeight, 220)}px`;
  }, [text]);

  const change = (next: string) => {
    setText(next);
    app.saveDraftText(key, next);
  };

  const addFiles = useCallback(
    async (files: Iterable<File>) => {
      const read = await Promise.all([...files].map(readImage));
      const ok = read.filter((value): value is string => value !== null);
      if (ok.length < read.length) app.toast("Only images up to 8 MB can be attached.", "error");
      if (ok.length) setImages((current) => [...current, ...ok]);
    },
    [app],
  );

  // A file dropped anywhere in the window lands here.
  useEffect(() => {
    const over = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!event.relatedTarget) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer?.files.length) return;
      event.preventDefault();
      setDragging(false);
      void addFiles(event.dataTransfer.files);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [addFiles]);

  const commands = useMemo(() => slashCommands(app, info), [app, info]);

  const suggest = (value: string, caret: number) => {
    const found = triggerAt(value, caret);
    trigger.current = found;
    const ticket = ++lookup.current;
    if (!found) {
      setSuggestions([]);
      return;
    }
    setActive(0);
    if (found.kind === "/") {
      const matching = matchNames(commands, found.query);
      setSuggestions(matching);
      if (!cwd) return;
      void app.request("skills.list", { cwd }).then(
        ({ skills }) => {
          if (ticket !== lookup.current) return;
          const rows = skillRows(skills.filter((skill) => skill.enabled));
          const wanted = matchSkills(rows, found.query)
            .slice(0, 12)
            .map((skill): Suggestion => ({
              label: skill.members ? skill.name : `$${skill.name}`,
              detail: skill.description,
              icon: skill.members ? "plug" : "sparkle",
              group: "Skills",
              insert: skill.members ? pluginPrompt(skill.name) : `$${skill.name} `,
            }));
          setSuggestions([...matching, ...wanted]);
        },
        () => {},
      );
      return;
    }
    // The folder's other sessions first among sessions, each newest first.
    const others = Object.values(app.sessions.get().byId)
      .filter((other) => other.id !== sessionId && !other.archived)
      .toSorted(
        (a, b) =>
          Number(projectOf(b) === cwd) - Number(projectOf(a) === cwd) || b.updatedAt - a.updatedAt,
      )
      .map((other) => ({ id: other.id, title: mentionTitle(sessionTitle(other)), info: other }));
    const sessions = matchSessions(others, found.query).map((row): Suggestion => {
      const folder = others.find((other) => other.id === row.id)?.info.cwd ?? "";
      return {
        label: row.title,
        detail: basename(folder),
        icon: "message",
        group: "Sessions",
        insert: `@${row.title} `,
        run: () => void mentioned.set(row.title, row.id),
      };
    });
    setSuggestions(sessions);
    if (!cwd) return;
    const show = (rows: PathRow[]) => {
      if (ticket !== lookup.current) return;
      setSuggestions([
        ...matchPaths(rows, found.query).map((file): Suggestion => {
          const parent = file.path.slice(0, Math.max(file.path.lastIndexOf("/"), 0));
          return {
            label: `${basename(file.path)}${file.directory ? "/" : ""}`,
            ...(parent ? { detail: parent } : {}),
            icon: file.directory ? "folder" : fileIcon(file.path),
            group: "Files",
            insert: `${file.path}${file.directory ? "/" : ""} `,
          };
        }),
        ...sessions,
      ]);
    };
    // With nothing typed yet, what the folder holds; then what the search finds.
    if (!found.query) {
      void app.request("files.list", { path: cwd }).then(
        ({ entries }) =>
          show(entries.map((entry) => ({ path: entry.name, directory: entry.directory }))),
        () => {},
      );
      return;
    }
    void app.request("files.search", { root: cwd, query: found.query }).then(
      ({ files }) => show(files),
      () => {},
    );
  };

  const pick = (suggestion: Suggestion) => {
    const found = trigger.current;
    setSuggestions([]);
    trigger.current = null;
    if (suggestion.run) {
      suggestion.run();
      if (suggestion.insert === undefined) {
        change("");
        return;
      }
    }
    if (!found || suggestion.insert === undefined) return;
    const caret = field.current?.selectionStart ?? text.length;
    const next = text.slice(0, found.start) + suggestion.insert + text.slice(caret);
    change(next);
    const position = found.start + suggestion.insert.length;
    requestAnimationFrame(() => field.current?.setSelectionRange(position, position));
  };

  /** `/review` with what to review after it: a turn of its own rather than a prompt. */
  const submitReview = async (reviewed: string, argument: string) => {
    const typed = text;
    change("");
    let branches: string[] = [];
    if (argument && !/\s/.test(argument)) {
      const found = await app.request("git.branches", { cwd }).catch(() => null);
      branches = found ? [...found.local, ...found.remote] : [];
    }
    if (!(await app.review(reviewed, reviewTarget(argument, branches)))) change(typed);
  };

  const submit = async (steer: boolean) => {
    const argument = sessionId && !images.length ? reviewArgument(text) : null;
    if (sessionId && argument !== null) {
      await submitReview(sessionId, argument);
      return;
    }
    const prompt = expandMentions(text.trim(), mentioned);
    if ((!prompt && !images.length) || sending) return;
    const attached = images;
    change("");
    setImages([]);
    history.current = -1;
    if (sessionId) {
      await app.send(sessionId, prompt, attached, steer ? "steer" : "auto");
      return;
    }
    setSending(true);
    const created = await app.createAndSend(prompt, attached);
    setSending(false);
    if (!created) {
      change(plainMentions(prompt));
      setImages(attached);
    } else {
      app.saveDraftText(key, "");
    }
  };

  const recall = (step: number): boolean => {
    const state = sessionId ? app.conversation(sessionId).get().state : null;
    const prompts = (state?.turns ?? [])
      .flatMap((turn) => turn.items)
      .flatMap((item) => (item.kind === "userMessage" && item.text ? [item.text] : []))
      .toReversed();
    const next = history.current + step;
    if (next < -1 || next >= prompts.length) return false;
    history.current = next;
    const recalled = next === -1 ? "" : (prompts[next] ?? "");
    // A recalled prompt shows its mentions as they were typed, and still sends their links.
    for (const part of mentionParts(recalled)) {
      if (typeof part !== "string") mentioned.set(part.title, part.id);
    }
    setText(plainMentions(recalled));
    return true;
  };

  const chooseModel = (model: string, effort: string | null) => {
    if (sessionId) app.updateSession({ sessionId, model, effort });
    else if (draft) app.setView({ draft: { ...draft, model, effort } });
    void app.request("settings.set", { model, effort }).catch(() => {});
  };
  const chooseMode = (mode: SessionMode) => {
    if (sessionId) app.updateSession({ sessionId, mode });
    else if (draft) app.setView({ draft: { ...draft, mode } });
  };
  const currentModel = info?.model || draft?.model || null;
  const currentEffort = (info ? info.effort : draft?.effort) ?? null;
  const mode = info?.mode ?? draft?.mode ?? "auto";
  const canSend = (text.trim().length > 0 || images.length > 0) && !sending;
  const archived = info?.archived ?? false;

  return (
    <div className="composer-wrap">
      {!sessionId && draft ? <DraftOptions draft={draft} /> : null}
      {session.plan && running ? <PlanStrip plan={session.plan} /> : null}
      {archived ? (
        <div className="strip">
          <Icon name="info" size={14} className="muted" />
          <span className="grow secondary">This session is archived.</span>
          <button
            type="button"
            className="ghost strip-action"
            onClick={() => sessionId && app.updateSession({ sessionId, archived: false })}
          >
            Unarchive
          </button>
        </div>
      ) : null}
      <div className="composer" data-dragging={dragging}>
        {suggestions.length ? (
          <div className="menu suggestions" data-side="top" data-align="start" role="listbox">
            <MenuList
              entries={sectioned(suggestions).map((row): MenuEntry =>
                "heading" in row
                  ? row
                  : {
                      label: row.label,
                      ...(row.detail ? { detail: row.detail } : {}),
                      ...(row.icon ? { icon: row.icon } : {}),
                      onSelect: () => pick(row),
                    },
              )}
              active={active}
              onPick={(entry) => entry.onSelect()}
            />
          </div>
        ) : null}
        {images.length ? (
          <div className="attachments">
            {images.map((src, index) => (
              <span key={index} className="thumb">
                <img src={src} alt="" />
                <button
                  type="button"
                  aria-label="Remove image"
                  onClick={() => setImages(images.filter((_, other) => other !== index))}
                >
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={field}
          rows={1}
          value={text}
          disabled={archived}
          placeholder={running ? "Queue a follow-up…" : "Message Cycle…"}
          aria-label="Message"
          onChange={(event) => {
            change(event.currentTarget.value);
            suggest(event.currentTarget.value, event.currentTarget.selectionStart);
          }}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (files.length) {
              event.preventDefault();
              void addFiles(files);
            }
          }}
          onBlur={() => setTimeout(() => setSuggestions([]), 120)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (suggestions.length) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActive((active + step + suggestions.length) % suggestions.length);
                return;
              }
              const chosen = suggestions[active];
              if ((event.key === "Enter" || event.key === "Tab") && chosen) {
                event.preventDefault();
                pick(chosen);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setSuggestions([]);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit(event.metaKey || event.ctrlKey);
            } else if (event.key === "ArrowUp" && (!text || history.current >= 0)) {
              if (recall(1)) event.preventDefault();
            } else if (event.key === "ArrowDown" && history.current >= 0) {
              if (recall(-1)) event.preventDefault();
            } else if (event.key === "Escape" && running && sessionId && !text) {
              app.interrupt(sessionId);
            }
          }}
        />
        <div className="composer-controls">
          <label className="icon-button" title="Attach images" aria-label="Attach images">
            <Icon name="paperclip" />
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(event) => {
                void addFiles(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <ModelPicker
            models={models}
            current={{ model: currentModel, effort: currentEffort }}
            begun={Boolean(sessionId)}
            onChoose={chooseModel}
          />
          <Menu
            side="top"
            title="How much the agent may do unasked"
            entries={() =>
              // Full access runs everything unasked, so it stands apart and in the warning color.
              SESSION_MODES.flatMap((value): MenuEntry[] => [
                ...(value === "fullAccess" ? [{ separator: true } as const] : []),
                {
                  label:
                    value === "auto"
                      ? `${MODE_LABELS[value].label} (default)`
                      : MODE_LABELS[value].label,
                  sub: MODE_LABELS[value].sub,
                  icon: MODE_LABELS[value].icon,
                  warning: value === "fullAccess",
                  checked: value === mode,
                  onSelect: () => chooseMode(value),
                },
              ])
            }
            width={320}
          >
            <span className={mode === "fullAccess" ? "tone-warning" : undefined}>
              {MODE_LABELS[mode].label}
            </span>
          </Menu>
          <span className="grow" />
          <ContextRing usage={session.usage} />
          {running && sessionId ? (
            <button
              type="button"
              className="send stop"
              title="Stop (Esc)"
              aria-label="Stop"
              onClick={() => app.interrupt(sessionId)}
            >
              <Icon name="stop" size={12} />
            </button>
          ) : null}
          {!running || canSend ? (
            <button
              type="button"
              className="send"
              title={running ? "Queue (↵)" : "Send (↵)"}
              aria-label={running ? "Queue" : "Send"}
              disabled={!canSend}
              onClick={() => void submit(false)}
            >
              {sending ? <Spinner /> : <Icon name="send" />}
            </button>
          ) : null}
        </div>
      </div>
      <div className="hint-line fade-x">
        {archived ? null : running && !text ? (
          <span>Type to queue a follow-up</span>
        ) : running ? (
          <>
            <Key>↵</Key>
            <span>Queue</span>
            <Dot />
            <Key>⌘↵</Key>
            <span>Send into this turn</span>
            <Dot />
            <Key>Esc</Key>
            <span>Stop</span>
          </>
        ) : (
          <>
            <Key>↵</Key>
            <span>Send</span>
            <Dot />
            <Key>⇧↵</Key>
            <span>New line</span>
            <Dot />
            <Key>@</Key>
            <span>Mention</span>
            <Dot />
            <Key>/</Key>
            <span>Commands</span>
          </>
        )}
      </div>
    </div>
  );
}
