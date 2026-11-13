import {
  type ModelInfo,
  type Plan,
  SESSION_MODES,
  type SessionInfo,
  type SessionMode,
  type Usage,
  activeTurn,
  sameModelFamily,
} from "@cycle/protocol";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CycleApp, Draft } from "../client/app.ts";
import { Store, useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { basename, compactNumber, tildePath } from "../lib/format.ts";
import { Icon, type IconName, Spinner } from "./icons.tsx";
import { Menu, type MenuEntry, MenuList } from "./menu.tsx";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export const MODE_LABELS: Record<SessionMode, { label: string; sub: string; icon: IconName }> = {
  readOnly: {
    label: "Ask first",
    sub: "Reads freely, asks before commands and edits",
    icon: "eye",
  },
  auto: { label: "Auto", sub: "Works inside the project, asks to leave it", icon: "zap" },
  fullAccess: { label: "Full access", sub: "Never asks, no sandbox", icon: "alert" },
};

interface Suggestion {
  label: string;
  sub?: string;
  icon: IconName;
  /** Replaces the typed token with text, or runs something instead. */
  insert?: string;
  run?: () => void;
}

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
  const slash = /^\/([\w-]*)$/.exec(before);
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

/** The models a session may use, under the provider that serves each. */
function modelEntries(
  models: ModelInfo[],
  current: { model: string | null; effort: string | null },
  choose: (model: string, effort: string | null) => void,
  /** Whether the conversation has begun, and so stays with its kind of model. */
  begun: boolean,
): MenuEntry[] {
  const active =
    models.find((model) => model.id === current.model) ?? models.find((m) => m.isDefault);
  const open = begun && active ? models.filter((model) => sameModelFamily(model, active)) : models;
  const groups = new Map<string, ModelInfo[]>();
  for (const model of open) {
    const name = model.provider?.name ?? "Codex";
    groups.set(name, [...(groups.get(name) ?? []), model]);
  }
  return [
    ...[...groups].flatMap(([name, group]): MenuEntry[] => [
      { heading: name },
      ...group.map((model): MenuEntry => ({
        label: model.isDefault ? `${model.name} (default)` : model.name,
        ...(model.provider ? {} : { sub: model.description }),
        checked: model.id === active?.id,
        onSelect: () => choose(model.id, null),
      })),
    ]),
    ...(open.length < models.length
      ? [
          { separator: true } as const,
          {
            heading: active?.provider
              ? "Codex's own models need a new session"
              : "Your providers' models need a new session",
          } as const,
        ]
      : []),
    ...(active?.efforts.length
      ? [
          { separator: true } as const,
          { heading: "Reasoning effort" } as const,
          ...active.efforts.map((effort): MenuEntry => ({
            label: effort.id === active.defaultEffort ? `${effort.id} (default)` : effort.id,
            ...(effort.description ? { sub: effort.description } : {}),
            checked: (current.effort ?? active.defaultEffort) === effort.id,
            onSelect: () => choose(active.id, effort.id),
          })),
        ]
      : []),
  ];
}

function PlanStrip({ plan }: { plan: Plan }) {
  const [open, setOpen] = useState(false);
  const done = plan.steps.filter((step) => step.status === "completed").length;
  const current = plan.steps.find((step) => step.status === "inProgress") ?? plan.steps[done];
  return (
    <div className="plan-strip">
      <button
        type="button"
        className="strip-row"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="list" />
        <span className="tabular muted">
          {done}/{plan.steps.length}
        </span>
        <span className="truncate grow">{current?.step ?? "Plan complete"}</span>
        <span className="progress" aria-hidden="true">
          <span style={{ width: `${(done / Math.max(plan.steps.length, 1)) * 100}%` }} />
        </span>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
      </button>
      {open ? (
        <ol className="plan-steps">
          {plan.steps.map((step, index) => (
            <li key={index} data-status={step.status}>
              {step.status === "completed" ? (
                <Icon name="check" />
              ) : step.status === "inProgress" ? (
                <Spinner size={12} />
              ) : (
                <span className="bullet" />
              )}
              {step.step}
            </li>
          ))}
        </ol>
      ) : null}
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
        <Menu entries={folders} className="button" title="Where the session works">
          <Icon name="folder" />
          <span className="truncate" title={tildePath(draft.cwd, home)}>
            {basename(draft.cwd)}
          </span>
          <Icon name="chevron-down" size={12} />
        </Menu>
        {branch ? (
          <span className="chip">
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
            className="field branch-field"
            placeholder="branch name (optional)"
            value={draft.branch}
            onChange={(event) => change({ branch: event.currentTarget.value })}
          />
        ) : null}
      </div>
      <div className="caption muted hint-line">
        {branch === null
          ? "Not in a git repository: the session works in the folder itself."
          : draft.worktree
            ? "The session gets its own checkout on a new branch. Uncommitted changes are not carried over."
            : branch
              ? `The session works in the checkout, on ${branch}.`
              : ""}
      </div>
    </div>
  );
}

const NO_SESSION = new Store<{ state: null; loading: boolean; error: null }>({
  state: null,
  loading: false,
  error: null,
});

function slashCommands(app: CycleApp, info: SessionInfo | null): Suggestion[] {
  const list: Suggestion[] = [
    { label: "/new", sub: "Start a new session", icon: "compose", run: () => app.newSession() },
  ];
  if (!info) return list;
  const sessionId = info.id;
  return [
    ...list,
    {
      label: "/compact",
      sub: "Summarize the conversation to free up context",
      icon: "compress",
      run: () => void app.attempt(app.request("session.compact", { sessionId })),
    },
    {
      label: "/fork",
      sub: "Continue in a copy of this session",
      icon: "git-fork",
      run: () => void app.fork(sessionId),
    },
    {
      label: "/diff",
      sub: "Show what changed",
      icon: "file-diff",
      run: () => app.setView({ panel: "changes" }),
    },
    {
      label: "/terminal",
      sub: "Open a terminal here",
      icon: "terminal",
      run: () => app.setView({ panel: "terminal" }),
    },
    {
      label: "/archive",
      sub: "Archive this session",
      icon: "archive",
      run: () => app.updateSession({ sessionId, archived: true }),
    },
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
      const matching = commands.filter((command) => command.label.startsWith(`/${found.query}`));
      setSuggestions(matching);
      if (!cwd) return;
      void app.request("skills.list", { cwd }).then(
        ({ skills }) => {
          if (ticket !== lookup.current) return;
          const wanted = skills
            .filter(
              (skill) =>
                skill.enabled && skill.name.toLowerCase().includes(found.query.toLowerCase()),
            )
            .slice(0, 12)
            .map((skill): Suggestion => ({
              label: `$${skill.name}`,
              sub: skill.description.slice(0, 90),
              icon: "sparkle",
              insert: `$${skill.name} `,
            }));
          setSuggestions([...matching, ...wanted]);
        },
        () => {},
      );
      return;
    }
    if (!cwd || !found.query) {
      setSuggestions([]);
      return;
    }
    void app.request("files.search", { root: cwd, query: found.query }).then(
      ({ files }) => {
        if (ticket !== lookup.current) return;
        setSuggestions(
          files.slice(0, 12).map((file) => ({
            label: basename(file.path),
            sub: file.path,
            icon: file.directory ? "folder" : "file",
            insert: `${file.path}${file.directory ? "/" : ""} `,
          })),
        );
      },
      () => {},
    );
  };

  const pick = (suggestion: Suggestion) => {
    const found = trigger.current;
    setSuggestions([]);
    trigger.current = null;
    if (suggestion.run) {
      change("");
      suggestion.run();
      return;
    }
    if (!found || suggestion.insert === undefined) return;
    const caret = field.current?.selectionStart ?? text.length;
    const next = text.slice(0, found.start) + suggestion.insert + text.slice(caret);
    change(next);
    const position = found.start + suggestion.insert.length;
    requestAnimationFrame(() => field.current?.setSelectionRange(position, position));
  };

  const submit = async (steer: boolean) => {
    const prompt = text.trim();
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
      change(prompt);
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
    setText(next === -1 ? "" : (prompts[next] ?? ""));
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
  const modelName =
    models.find((model) => model.id === currentModel)?.name ??
    currentModel ??
    models.find((model) => model.isDefault)?.name ??
    "Model";
  const canSend = (text.trim().length > 0 || images.length > 0) && !sending;
  const archived = info?.archived ?? false;

  return (
    <div className="composer-wrap">
      {!sessionId && draft ? <DraftOptions draft={draft} /> : null}
      {session.plan && running ? <PlanStrip plan={session.plan} /> : null}
      {archived ? (
        <div className="strip-row archived-strip">
          <Icon name="archive" />
          <span className="grow">This session is archived.</span>
          <button
            type="button"
            className="button"
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
              entries={suggestions.map((suggestion) => ({
                label: suggestion.label,
                ...(suggestion.sub ? { sub: suggestion.sub } : {}),
                icon: suggestion.icon,
                onSelect: () => pick(suggestion),
              }))}
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
          <label className="icon-button" title="Attach images">
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
          <Menu
            side="top"
            title="Model and reasoning effort"
            entries={() =>
              modelEntries(
                models,
                { model: currentModel, effort: currentEffort },
                chooseModel,
                Boolean(sessionId),
              )
            }
          >
            <span className="truncate">{modelName}</span>
            {currentEffort ? <span className="muted">{currentEffort}</span> : null}
          </Menu>
          <Menu
            side="top"
            title="How much the agent may do unasked"
            entries={() =>
              SESSION_MODES.map((value) => ({
                label:
                  value === "auto"
                    ? `${MODE_LABELS[value].label} (default)`
                    : MODE_LABELS[value].label,
                sub: MODE_LABELS[value].sub,
                icon: MODE_LABELS[value].icon,
                checked: value === mode,
                onSelect: () => chooseMode(value),
              }))
            }
          >
            <Icon
              name={MODE_LABELS[mode].icon}
              size={14}
              className={mode === "fullAccess" ? "tone-warning" : ""}
            />
            <span>{MODE_LABELS[mode].label}</span>
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
              <Icon name="stop" />
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
              {sending ? <Spinner /> : <Icon name={running ? "clock" : "arrow-up"} />}
            </button>
          ) : null}
        </div>
      </div>
      <div className="hint-line caption muted">
        {running
          ? "↵ Queue · ⌘↵ Send into this turn · Esc Stop"
          : "↵ Send · ⇧↵ New line · @ Files · / Commands"}
      </div>
    </div>
  );
}
