import {
  type AttachmentKind,
  type Plan,
  type PromptDocument,
  type SessionInfo,
  type SessionMode,
  type SlashCommand,
  type Usage,
  activeTurn,
  harnessLabel,
} from "@cycle/protocol";
import { isComposing } from "@ui-sdk/core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  type CycleApp,
  type Draft,
  NO_CAPABILITIES,
  projectOf,
  sessionTitle,
} from "../client/app.ts";
import { Store, useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import {
  MAX_ATTACHMENT_BYTES,
  acceptOf,
  attachLabel,
  attachmentKind,
  matchCommands,
  keepAccepted,
} from "../lib/attach.ts";
import { canSandbox, harnessesOf } from "../lib/draft.ts";
import { basename, compactNumber, tildePath } from "../lib/format.ts";
import { modeNamed, modesOf } from "../lib/modes.ts";
import { reviewArgument, reviewTarget } from "../lib/review.ts";
import { sandboxSummary } from "../lib/sandbox-form.ts";
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
import { useRowKeys } from "./controls.tsx";
import { Icon, type IconName, Spinner } from "./icons.tsx";
import { Chevron } from "./items.tsx";
import { PlanSteps } from "./plan.tsx";
import { Menu, type MenuEntry, MenuList } from "./menu.tsx";
import { ModeMenu } from "./mode-menu.tsx";
import { ModelPicker } from "./model-picker.tsx";

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

function readDataUrl(file: File): Promise<string | null> {
  if (file.size > MAX_ATTACHMENT_BYTES) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => resolve(null));
    reader.readAsDataURL(file);
  });
}

/** A file the composer attaches: an image, or a document the agent can read. */
type Attached = { kind: "image"; data: string } | { kind: "document"; document: PromptDocument };

async function readAttachment(
  file: File,
  accepted: readonly AttachmentKind[],
): Promise<Attached | null> {
  const kind = attachmentKind(file, accepted);
  if (!kind) return null;
  const data = await readDataUrl(file);
  if (!data) return null;
  return kind === "image"
    ? { kind: "image", data }
    : { kind: "document", document: { kind, name: file.name, data } };
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
      title={`Context: ${compactNumber(usage.last.total)} of ${compactNumber(usage.contextWindow)} tokens (${percent}%). This session has used ${compactNumber(usage.total.total)} in all${usage.costUsd !== null ? `, about $${usage.costUsd.toFixed(2)} so far` : ""}.`}
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
  const harnesses = useStore(app.models, (models) => harnessesOf(models).join(" "))
    .split(" ")
    .filter(Boolean);
  // A sandbox is offered for the agents that can run in one here.
  const boxable = useStore(app.models, (models) => canSandbox(models, draft.harness));
  const environments = useStore(app.sandboxes, (value) => value.environments);
  const chosen = boxable ? environments.find((one) => one.id === draft.sandbox) : undefined;
  const boxed = chosen !== undefined;
  // Folders beyond its own, for an agent that can reach them outside a sandbox.
  const reaches = useStore(
    app.harnesses,
    (list) => list.find((each) => each.name === draft.harness)?.capabilities.directories ?? false,
  );
  const addFolder = async () => {
    const folder = await app.chooseFolder();
    const now = app.view.get().draft;
    if (!folder || !now || folder === now.cwd || now.directories.includes(folder)) return;
    app.setView({ draft: { ...now, directories: [...now.directories, folder] } });
  };
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
  const places = (): MenuEntry[] => [
    {
      label: "Local",
      sub: "On this machine",
      icon: "terminal",
      checked: !boxed,
      onSelect: () => change({ sandbox: null }),
    },
    ...environments.map((one): MenuEntry => ({
      label: one.name,
      sub: `Sandbox · ${sandboxSummary(one)}`,
      icon: "file-lock",
      checked: one.id === chosen?.id,
      onSelect: () => change({ sandbox: one.id }),
    })),
    { separator: true },
    {
      label: "Edit environments…",
      icon: "sliders",
      onSelect: () => app.setView({ page: "settings", settingsSection: "sandboxes" }),
    },
  ];
  return (
    <div className="draft-options">
      <div className="row">
        {harnesses.length > 1 ? (
          // The agent comes first: what follows is its to offer, and a session stays with it.
          <div className="segmented small" role="radiogroup" aria-label="Agent">
            {harnesses.map((name) => (
              <button
                key={name}
                type="button"
                role="radio"
                className="segment"
                aria-checked={name === draft.harness}
                onClick={() => app.setDraftHarness(name)}
              >
                {harnessLabel(name)}
              </button>
            ))}
          </div>
        ) : null}
        {boxable ? (
          <Menu entries={places} className="ghost" title="Where the agent runs">
            <Icon name={boxed ? "file-lock" : "terminal"} />
            <span className="fade-x">{chosen?.name ?? "Local"}</span>
            <Icon name="chevron-down-sm" size={14} className="muted" />
          </Menu>
        ) : (
          <span className="chip" title="This agent runs on this machine only">
            <Icon name="terminal" size={14} /> Local
          </span>
        )}
      </div>
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
        {branch && !boxed ? (
          <label className="row meta">
            <input
              type="checkbox"
              checked={draft.worktree}
              onChange={(event) => change({ worktree: event.currentTarget.checked })}
            />
            New worktree
          </label>
        ) : null}
        {branch && draft.worktree && !boxed ? (
          <input
            className="field small branch-field"
            placeholder="branch name (optional)"
            aria-label="Branch name, optional"
            value={draft.branch}
            onChange={(event) => change({ branch: event.currentTarget.value })}
          />
        ) : null}
      </div>
      {reaches && !boxed ? (
        <div className="row">
          {draft.directories.map((path) => (
            <span key={path} className="chip" title={tildePath(path, home)}>
              <Icon name="folder" size={14} /> {basename(path)}
              <button
                type="button"
                className="ghost"
                aria-label={`Stop reaching ${basename(path)}`}
                onClick={() =>
                  change({ directories: draft.directories.filter((other) => other !== path) })
                }
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
          <button
            type="button"
            className="ghost meta"
            title="Let the agent reach another folder too"
            onClick={() => void addFolder()}
          >
            <Icon name="plus" size={14} /> Add folder
          </button>
        </div>
      ) : null}
      {boxed || branch === null || draft.worktree ? (
        <div className="caption muted hint-line">
          {boxed
            ? "The agent runs in a Docker sandbox that holds this folder, made the first time with what its environment says. Files, changes and terminals here are still this machine's."
            : branch === null
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
  // A session stays with its agent, so only that agent's models are its to choose.
  const harness = info?.harness ?? draft?.harness;
  const pickable = harness ? models.filter((model) => model.harness === harness) : models;
  const key = sessionId ?? `new:${draft?.cwd ?? ""}`;
  const cwd = info?.cwd ?? draft?.cwd ?? "";
  const capabilities = useStore(
    app.harnesses,
    (list) => list.find((each) => each.name === harness)?.capabilities ?? NO_CAPABILITIES,
  );

  const [text, setText] = useState(() => app.draftText(key));
  const [images, setImages] = useState<string[]>([]);
  const thumbs = useRowKeys(images.length);
  const [documents, setDocuments] = useState<PromptDocument[]>([]);
  const chips = useRowKeys(documents.length);
  // The latest attachments, for an effect that runs only when the agent changes.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
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
    // What a stopped turn or an unsent first prompt gave back comes with its attachments.
    const back = app.takeReturned(key);
    setImages(back?.images ?? []);
    setDocuments(back?.documents ?? []);
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

  const accepted = capabilities.attachments;

  // Another agent may take less: what it cannot read leaves the composer, and the owner is told.
  useEffect(() => {
    const kept = keepAccepted(
      { images: imagesRef.current, documents: documentsRef.current },
      accepted,
    );
    if (!kept.dropped.length) return;
    setImages(kept.images);
    setDocuments(kept.documents);
    app.toast(
      `Removed ${kept.dropped.join(", ")}: ${harnessLabel(harness ?? "")} cannot read ${kept.dropped.length > 1 ? "them" : "it"}.`,
      "info",
    );
  }, [app, accepted, harness]);
  const addFiles = useCallback(
    async (files: Iterable<File>) => {
      const read = await Promise.all([...files].map((file) => readAttachment(file, accepted)));
      const ok = read.filter((value): value is Attached => value !== null);
      if (ok.length < read.length) {
        const what = accepted.some((kind) => kind !== "image")
          ? "Only images, PDFs and text files"
          : "Only images";
        app.toast(`${what} up to 8 MB can be attached.`, "error");
      }
      const added = ok.flatMap((each) => (each.kind === "image" ? [each.data] : []));
      const readDocs = ok.flatMap((each) => (each.kind === "document" ? [each.document] : []));
      if (added.length) setImages((current) => [...current, ...added]);
      if (readDocs.length) setDocuments((current) => [...current, ...readDocs]);
    },
    [app, accepted],
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
      if (capabilities.commands && harness) {
        const show = (list: SlashCommand[]) => {
          if (ticket !== lookup.current) return;
          const own = new Set(matching.map((row) => row.label));
          const wanted = matchCommands(list, found.query)
            .filter((each) => !own.has(`/${each.name}`))
            .slice(0, 12)
            .map((each): Suggestion => ({
              label: `/${each.name}`,
              detail: [each.argumentHint, each.description].filter(Boolean).join(" · "),
              icon: each.builtin ? "terminal" : "sparkle",
              group: `${harnessLabel(harness)} commands`,
              insert: `/${each.name} `,
            }));
          setSuggestions([...matching, ...wanted]);
        };
        const cached = sessionId ? app.commands.get()[sessionId] : undefined;
        if (cached) {
          show(cached);
          return;
        }
        void app
          .request("commands.list", sessionId ? { sessionId } : { harness, cwd })
          .then(({ commands: list }) => {
            if (sessionId) app.commands.update((all) => ({ ...all, [sessionId]: list }));
            show(list);
          })
          .catch(() => {});
        return;
      }
      if (!cwd) return;
      void app.request("skills.list", { cwd, ...(harness ? { harness } : {}) }).then(
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
    const argument = sessionId && !images.length && !documents.length ? reviewArgument(text) : null;
    if (sessionId && argument !== null) {
      await submitReview(sessionId, argument);
      return;
    }
    const prompt = expandMentions(text.trim(), mentioned);
    if ((!prompt && !images.length && !documents.length) || sending) return;
    const attached = images;
    const carried = documents;
    change("");
    setImages([]);
    setDocuments([]);
    history.current = -1;
    if (sessionId) {
      if (!(await app.send(sessionId, prompt, attached, steer ? "steer" : "auto", carried))) {
        // Not sent: the owner gets it back to try again.
        change(plainMentions(prompt));
        setImages(attached);
        setDocuments(carried);
      }
      return;
    }
    setSending(true);
    const created = await app.createAndSend(prompt, attached, carried);
    setSending(false);
    if (!created) {
      change(plainMentions(prompt));
      setImages(attached);
      setDocuments(carried);
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
  const agent = info?.harness ?? draft?.harness ?? "";
  const allModes = useStore(app.modes, (modes) => modes);
  const agentModes = modesOf(allModes, agent);
  const mode = modeNamed(allModes, agent, info?.mode ?? draft?.mode);
  const canSend = (text.trim().length > 0 || images.length > 0 || documents.length > 0) && !sending;
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
        {documents.length ? (
          <div className="attachments">
            {documents.map((document, index) => (
              <span key={chips.keys[index]} className="chip" title={document.name}>
                <Icon name={document.kind === "pdf" ? "file" : "file-text"} size={14} />
                <span className="fade-x">{document.name}</span>
                <button
                  type="button"
                  className="ghost"
                  aria-label={`Remove ${document.name}`}
                  onClick={() => {
                    chips.remove(index);
                    setDocuments(documents.filter((_, other) => other !== index));
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {images.length ? (
          <div className="attachments">
            {images.map((src, index) => (
              <span key={thumbs.keys[index]} className="thumb">
                <img src={src} alt="" />
                <button
                  type="button"
                  aria-label="Remove image"
                  onClick={() => {
                    thumbs.remove(index);
                    setImages(images.filter((_, other) => other !== index));
                  }}
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
            if (isComposing(event)) return;
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
          <label
            className="icon-button"
            title={attachLabel(accepted)}
            aria-label={attachLabel(accepted)}
          >
            <Icon name="paperclip" />
            <input
              type="file"
              accept={acceptOf(accepted)}
              multiple
              hidden
              onChange={(event) => {
                void addFiles(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
              }}
            />
          </label>
          <ModelPicker
            models={pickable}
            current={{ model: currentModel, effort: currentEffort }}
            begun={Boolean(sessionId)}
            onChoose={chooseModel}
          />
          <ModeMenu side="top" modes={agentModes} current={mode} onChoose={chooseMode} />
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
