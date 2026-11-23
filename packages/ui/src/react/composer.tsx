import { Button } from "@ui-sdk/react/button";
import { Popover, PopoverContent, PopoverTrigger } from "@ui-sdk/react/popover";
import { MotionGlobalConfig, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { FileSearch, PlanUsage, SendVia } from "../api.ts";
import {
  type Accepts,
  ATTACHMENT_LIMITS,
  type AttachmentKind,
  type AttachmentProblem,
  base64Bytes,
  canAdd,
  IMAGE_TYPES,
  isPdfBytes,
  kindOf,
  textOfBytes,
  textType,
} from "../attachments.ts";
import {
  fileUri,
  type Mention,
  mentionText,
  NOT_RECALLING,
  type Recall,
  recall,
  sentTexts,
} from "../draft.ts";
import {
  mentionableSessions,
  mentionQuery,
  mentionRow,
  sessionLabel,
  sessionUri,
} from "../mention.ts";
import type { ContextState, Status } from "../model/conversation.ts";
import { type PlanItem, type QueuedPrompt, textOf } from "../model/index.ts";
import { commandText, filterCommands, slashQuery } from "../slash.ts";
import { optionsOf, propertiesOf } from "./config-form.tsx";
import { ContextDetails, planRowsOf } from "./context-details.tsx";
import { useI18n } from "./i18n.tsx";
import { AttachIcon, CloseIcon, PlusIcon, SendIcon, StopIcon } from "./icons.tsx";
import { type InputHandle, type InputKey, MarkdownInput } from "./markdown-input.tsx";
import { optionId, PickerMenu, type PickerRow } from "./picker-menu.tsx";
import { PlanStrip } from "./plan.tsx";
import { sessionTitle } from "./session-list.tsx";
import { SettingChips, type SettingsOf } from "./setting-chips.tsx";
import { MOD } from "./sidebar.tsx";
import { useAppState, useAppStore } from "./store-context.tsx";
import { Tip } from "./tip.tsx";

export type ComposerProps = {
  /** The environment it is on, for what its daemon can do. */
  environmentId: string;
  /** The session this box is for, as `viewKey` names it. A box is made anew for each session. */
  sessionKey: string;
  /** False when there is no session, or it is still being read. */
  enabled: boolean;
  /** The editor can keep taking a draft while remote actions are disabled. */
  connected: boolean;
  activity: Status;
  /** The agent takes images in a prompt: the person may attach them. Without it or files, the controls are not there. */
  canAttach?: boolean;
  /**
   * The agent takes embedded files (`promptCapabilities.embeddedContext`): text files and PDFs may be attached too
   * (.agents/notes/2026-11-22-attach-any-file.md).
   */
  canAttachFiles?: boolean;
  /** The agent can take a message into the turn that is running (docs/protocol.md §8). */
  canSteer?: boolean;
  /** A message was sent from the box (not yet known to have arrived): the conversation follows it. */
  onSent?: () => void;
  /** The session's settings and the agent's schema for them; offered in the utility bar under the input. */
  settings?: SettingsOf | undefined;
  /** Asks for a setting; a promise it returns settles when the asking is over. */
  onSetting?: (key: string, value: string) => unknown;
  /**
   * Why nothing can be sent yet, though the box takes what is written (a blank conversation with no folder): said in
   * the extension tray above the box, and Send waits.
   */
  blocked?: string | undefined;
  /** What the empty box says, in place of what it says for a session's state. */
  placeholder?: string | undefined;
  /** A blank conversation: @ looks in its folder, which needs a daemon that says `filesInFolder`. */
  blank?: boolean;
  /** The session's active plan while entries remain unfinished, rendered as a single row in the extension tray. */
  plan?: PlanItem | undefined;
  /** How full the session's context is, and its compactions: the ring on the right of the utility bar. */
  context?: ContextState | undefined;
  /** The account's plan limits as the session's agent last told them, shown under the context. */
  planUsage?: PlanUsage | undefined;
};

/** What a box with no conversation behind it has of a list: one array, so that reading it twice is the same value. */
const NONE: never[] = [];

/** How long after the last key the files are asked for. */
const MENTION_DELAY = 120;

/** A file as ACP carries an image: base64. Read in pieces, so that a large one does not overflow the call. */
const toBase64 = async (file: File): Promise<string> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
};

/** What a queued message is called in the list: its words on one line, or what else it holds. */
const previewOf = (prompt: QueuedPrompt): { text: string; images: number; files: number } => ({
  text: textOf(prompt.prompt).replace(/\s+/g, " ").trim(),
  images: prompt.prompt.filter((b) => b.type === "image").length,
  files: prompt.prompt.filter((b) => b.type === "resource").length,
});

/** How a file came to the box, as analytics counts it. */
type AttachVia = "button" | "paste" | "drop";

/** Why a file was not attached, in the words analytics counts (never its name). */
const refusalOf = (p: AttachmentProblem): "type" | "too_large" | "too_many" =>
  p.reason === "type" ? "type" : p.reason === "too-many" ? "too_many" : "too_large";

/** The message box on the page, for a shortcut or a page that hands it the focus. One composer is on a page at a time. */
export const composerInput = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-slot="composer"] [data-slot="composer-input"]');

export function Composer({
  environmentId,
  sessionKey,
  enabled,
  connected,
  activity,
  canAttach = false,
  canAttachFiles = false,
  canSteer = false,
  onSent,
  settings,
  onSetting,
  blocked,
  placeholder: told,
  blank = false,
  plan,
  context,
  planUsage,
}: ComposerProps) {
  const { t, number } = useI18n();
  const store = useAppStore();
  const draft = useSyncExternalStore(store.drafts.subscribe, () => store.drafts.get(sessionKey));
  // Only what the box shows is watched: the conversation is made anew by every streamed update, and the box must not be drawn again for each.
  const working = activity !== "idle";
  const queue = useAppState((s) => s.views[sessionKey]?.conversation.queue ?? NONE);
  const commands = useAppState((s) => s.views[sessionKey]?.conversation.commands ?? NONE);
  // A permission waiting for an answer: ⌘Enter is its "Allow once" (app.tsx), the same test as there.
  const permissionWaits = useAppState((s) => (s.views[sessionKey]?.permissions.length ?? 0) > 0);
  const { text, attachments, kept } = draft;
  // A daemon that has not said it queues is asked nothing it would refuse: a message waits for the turn to end.
  const capabilities = useAppState((s) => s.status[environmentId]?.capabilities);
  const canQueue = capabilities?.queue === true;
  // While it works, Enter puts the message into the running turn where the agent and the daemon can; ⌘Enter queues it.
  const steers = working && canQueue && canSteer && capabilities?.steer === true;
  const canFind =
    connected && (blank ? capabilities?.filesInFolder === true : capabilities?.files === true);
  // Other sessions of the same daemon, which it gives the agent as a record of what was said (docs/protocol.md §8). An
  // older daemon does not say it can: then there is no such group.
  const canMentionSessions = connected && capabilities?.sessionMentions === true;
  const sessions = useAppState((s) => s.sessions[environmentId] ?? NONE);
  const recalled = useRef<Recall>(NOT_RECALLING);
  const [problem, setProblem] = useState<string | undefined>();
  const [dropping, setDropping] = useState(false);
  const [wrapped, setWrapped] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const input = useRef<InputHandle | null>(null);
  // Something put a message back to be sent again (a failed turn's "Edit message"): the box takes the focus, to read it.
  const focusAsked = useAppState((s) => s.composerFocus);
  useEffect(() => {
    if (focusAsked > 0) input.current?.focus();
  }, [focusAsked]);
  // What is being named after a slash or an @, and which of the matches is under the arrows. Escape closes the menu until
  // what was typed changes.
  const menuId = useId();
  const [typed, setTyped] = useState<{ slash?: string | undefined; mention?: string | undefined }>(
    {},
  );
  const [dismissed, setDismissed] = useState<string | undefined>();
  const [pointed, setPointed] = useState<{ query: string | undefined; index: number }>({
    query: undefined,
    index: 0,
  });
  const [found, setFound] = useState<
    { query: string; result: FileSearch | undefined } | undefined
  >();
  // Files are asked for a moment after the last key, and only what answers the query as it stands now is shown. A search
  // that failed still answers (with no files), so the sessions waiting on it are shown.
  useEffect(() => {
    const query = typed.mention;
    if (query === undefined || !canFind) {
      setFound(undefined);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      void store.searchFiles(query).then((result) => {
        if (current) setFound({ query, result });
      });
    }, MENTION_DELAY);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [typed.mention, canFind, store]);
  const commandRows: PickerRow[] =
    typed.slash === undefined
      ? []
      : filterCommands(commands, typed.slash).map((command) => ({
          key: command.name,
          name: `/${command.name}`,
          ...(command.hint !== undefined ? { hint: command.hint } : {}),
          description: command.description,
        }));
  const hits =
    typed.mention !== undefined && found?.query === typed.mention
      ? (found.result?.entries ?? [])
      : [];
  // Sessions are known here at once, files a moment later: they are shown together, so the rows do not move under the
  // pointer when the files come.
  const filesAnswered = !canFind || found?.query === typed.mention;
  const others =
    typed.mention !== undefined && canMentionSessions && filesAnswered
      ? mentionableSessions(
          sessions,
          typed.mention,
          {
            environmentId,
            sessionId: blank ? undefined : sessionKey.slice(environmentId.length + 1),
          },
          sessionTitle,
        )
      : [];
  // Headed only when sessions are among them: a box that can name only files looks as it did.
  const grouped = others.length > 0;
  const mentionRows: PickerRow[] = [
    ...hits.map((hit) => {
      const row = mentionRow(hit.path, hit.kind);
      return {
        key: hit.path,
        name: row.name,
        description: row.folder,
        ...(grouped ? { group: t("composer.mentions.files") } : {}),
      };
    }),
    ...others.map((other) => ({
      key: `session:${other.sessionId}`,
      name: sessionTitle(other),
      description: other.cwd.split("/").filter(Boolean).at(-1) ?? other.cwd,
      group: t("composer.mentions.sessions"),
      kind: "session",
    })),
  ];
  const commandQuery = typed.slash === undefined ? undefined : `/${typed.slash}`;
  const mentionQueryText = typed.mention === undefined ? undefined : `@${typed.mention}`;
  const kind: "command" | "mention" | undefined =
    commandRows.length > 0 && commandQuery !== dismissed
      ? "command"
      : mentionRows.length > 0 && mentionQueryText !== dismissed
        ? "mention"
        : undefined;
  const rows = kind === "command" ? commandRows : kind === "mention" ? mentionRows : [];
  const query = kind === "command" ? commandQuery : mentionQueryText;
  const menuOpen = kind !== undefined;
  // A new query starts at the first match.
  const chosen = pointed.query === query ? pointed.index : 0;
  const active = Math.min(chosen, Math.max(rows.length - 1, 0));
  // Something was named that is not there: it is said, once, instead of showing nothing.
  // A bare @ says so only when the search went through the folder: one cut short by its time limit proves nothing.
  const nothingFound =
    kind === undefined &&
    typed.mention !== undefined &&
    found?.query === typed.mention &&
    found.result !== undefined &&
    (typed.mention !== "" || found.result.truncated !== true) &&
    mentionRows.length === 0 &&
    mentionQueryText !== dismissed;
  const lookAtCaret = () => {
    const caret = input.current?.caret();
    setTyped({
      slash: caret === undefined ? undefined : slashQuery(caret.before, caret.first),
      mention: caret === undefined ? undefined : mentionQuery(caret.before),
    });
  };
  const pick = (index: number) => {
    if (kind === "command") {
      const command = commands.find((c) => c.name === commandRows[index]?.key);
      if (command === undefined) return;
      // What was typed of it, the slash and the query, is replaced by the whole name and a space.
      input.current?.replaceBeforeCaret((typed.slash?.length ?? 0) + 1, commandText(command));
      store.track("slash_command_used", {});
    } else if (kind === "mention") {
      const hit = hits[index];
      const other = others[index - hits.length];
      const root = found?.result?.root;
      let mention: Mention;
      if (hit !== undefined && root !== undefined) {
        mention = {
          path: hit.path,
          kind: hit.kind,
          uri: fileUri(root, hit.path, hit.kind),
          name: mentionRow(hit.path, hit.kind).name.replace(/\/$/, ""),
        };
      } else if (other !== undefined) {
        const title = sessionTitle(other);
        mention = {
          path: sessionLabel(title),
          kind: "session",
          uri: sessionUri(other.sessionId),
          name: title,
        };
      } else return;
      // The @ and what was typed after it become the path and a space; the link for the agent is kept beside the text.
      input.current?.replaceBeforeCaret(
        (typed.mention?.length ?? 0) + 1,
        `${mentionText(mention)} `,
      );
      store.drafts.addMention(sessionKey, mention);
      store.track("mention_picked", { kind: mention.kind });
    }
    input.current?.focus();
  };
  // While the agent works, a message is queued: it goes when the turn ends well (docs/protocol.md §8).
  const canSend =
    enabled &&
    connected &&
    blocked === undefined &&
    (!working || canQueue) &&
    (text.trim() !== "" || attachments.length > 0 || kept.length > 0);
  const placeholder =
    told ??
    (!enabled
      ? t("conversation.loading")
      : activity === "requires_action"
        ? t("step.approval")
        : working
          ? t(
              steers
                ? "composer.placeholder.steer"
                : canQueue
                  ? "composer.placeholder.working"
                  : "composer.placeholder.busy",
              { key: QUEUE_KEY },
            )
          : t("composer.placeholder.idle"));

  // Single-line by default; once text wraps past one line, contains a newline or carries attachments, the box promotes
  // cleanly into its 3-row layout (2 lines of content + action row) without flickering
  // back and forth as the widened field reflows.
  const hasAttachments = attachments.length > 0 || kept.length > 0;
  const showQueue = working && canQueue;
  const showSend = !working || steers || !canQueue;
  const hasNewline = text.includes("\n");
  const textRef = useRef(text);
  textRef.current = text;

  const measureWrap = useRef(() => {
    const field = fieldRef.current;
    if (field === null || textRef.current === "") return;
    const inputEl = field.querySelector<HTMLElement>('[data-slot="composer-input"]');
    if (inputEl === null || inputEl.scrollHeight === 0) return;
    const style = getComputedStyle(inputEl);
    const lineHeight = Number.parseFloat(style.lineHeight) || 21;
    const paddingY =
      (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const contentHeight = inputEl.scrollHeight - paddingY;
    if (contentHeight > Math.ceil(lineHeight * 1.45)) setWrapped(true);
  });

  useLayoutEffect(() => {
    if (text === "") {
      if (wrapped) setWrapped(false);
      return;
    }
    if (wrapped || hasNewline || hasAttachments) return;
    measureWrap.current();
  }, [text, wrapped, hasNewline, hasAttachments]);

  useEffect(() => {
    if (wrapped || hasNewline || hasAttachments) return;
    const field = fieldRef.current;
    if (field === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measureWrap.current());
    observer.observe(field);
    return () => observer.disconnect();
  }, [wrapped, hasNewline, hasAttachments]);

  // Several buttons (Queue, Send now, Stop) fit beside one line: they do not make the box taller (CYCL-75).
  const expanded = hasAttachments || hasNewline || wrapped;

  const megabytes = (bytes: number) =>
    number(bytes / 1048576, { style: "unit", unit: "megabyte", maximumFractionDigits: 0 });
  /** A file's size on its chip: kilobytes below a megabyte (at least 1), else megabytes to one decimal. */
  const sizeOf = (bytes: number) =>
    bytes < 1048576
      ? number(Math.max(1, Math.round(bytes / 1024)), { style: "unit", unit: "kilobyte" })
      : number(bytes / 1048576, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 });
  const accepts: Accepts = { images: canAttach, files: canAttachFiles };
  const attachable = canAttach || canAttachFiles;
  const say = (p: AttachmentProblem): string => {
    switch (p.reason) {
      case "type":
        // Said by what this agent takes: the person learns what would work.
        return t(
          !canAttachFiles
            ? "composer.problem.type"
            : canAttach
              ? "composer.problem.typeFiles"
              : "composer.problem.typeNoImages",
          { name: p.name },
        );
      case "block-too-large":
        return t("composer.problem.blockTooLarge", {
          name: p.name,
          limit: megabytes(ATTACHMENT_LIMITS.blockBytes),
        });
      case "prompt-too-large":
        return t("composer.problem.promptTooLarge", {
          limit: megabytes(ATTACHMENT_LIMITS.promptBytes),
        });
      case "too-many":
        return t("composer.problem.tooMany", { count: ATTACHMENT_LIMITS.blocks - 1 });
    }
  };

  /**
   * Adds what can be added, one by one, by what the agent takes and the limits of a prompt; says why for the first that
   * cannot. An image or a PDF goes as base64; any other file is read, and goes as text if it is text, else is refused.
   */
  const attach = async (files: File[], via: AttachVia) => {
    if (!attachable || files.length === 0) return;
    // A file still being read when the message goes out, or the session goes, is not for what is written next.
    const generation = store.drafts.generation(sessionKey);
    // The list as it is now, for the code that waits (reading a file) between looking and adding: two images pasted in
    // a row must both stay, and a list captured when the first began would lose the first.
    const now = () => store.drafts.get(sessionKey).attachments;
    let first: string | undefined;
    const refuse = (p: AttachmentProblem) => {
      first ??= say(p);
      store.track("attachment_refused", { reason: refusalOf(p) });
    };
    for (const file of files) {
      const next = { name: file.name, type: file.type, bytes: file.size };
      const refused = canAdd(now(), next, accepts);
      if (refused !== undefined) {
        refuse(refused);
        continue;
      }
      const kind: AttachmentKind = kindOf(next);
      try {
        let data: string;
        let type: string;
        let bytes: number;
        if (kind === "text") {
          const text = textOfBytes(new Uint8Array(await file.arrayBuffer()));
          if (store.drafts.generation(sessionKey) !== generation) return;
          // Not text after all (a binary file of no type the box knows): it cannot go.
          if (text === undefined) {
            refuse({ reason: "type", name: file.name });
            continue;
          }
          data = text;
          type = textType(file.type);
          bytes = new TextEncoder().encode(text).length;
        } else {
          if (kind === "pdf" && !isPdfBytes(new Uint8Array(await file.slice(0, 5).arrayBuffer()))) {
            if (store.drafts.generation(sessionKey) !== generation) return;
            refuse({ reason: "type", name: file.name });
            continue;
          }
          data = await toBase64(file);
          // The message was sent while this was being read: the file is no longer for a message that is still being written.
          if (store.drafts.generation(sessionKey) !== generation) return;
          type = kind === "pdf" ? "application/pdf" : file.type;
          bytes = base64Bytes(data) ?? file.size;
        }
        // Another add may have finished while this one was reading: the limits are held to the list as it is now.
        const refusedNow = canAdd(now(), next, accepts);
        if (refusedNow !== undefined) {
          refuse(refusedNow);
          continue;
        }
        store.drafts.setAttachments(sessionKey, [
          ...now(),
          { id: crypto.randomUUID(), name: file.name, kind, type, data, bytes },
        ]);
        store.track("attachment_added", { kind, via });
      } catch {
        first ??= t("composer.problem.unreadable", { name: file.name });
      }
    }
    setProblem(first);
  };

  /** `steer`: into the running turn; otherwise, while the agent works, into the queue. */
  const send = async (steer: boolean, via: SendVia) => {
    if (!canSend) return;
    recalled.current = NOT_RECALLING;
    setProblem(undefined);
    onSent?.();
    await store.send(steer ? { steer: true, via } : { via });
  };

  const edit = async (queueId: string) => {
    if ((await store.dequeue(queueId)) !== undefined) {
      input.current?.focus();
    }
  };

  /**
   * The keys the box asks about first. Enter sends: while the agent works, into its turn where it can take it, else to
   * the queue. ⌘Enter queues. Shift+Enter (or Alt+Enter) is a new line, always. The arrows walk through what was sent.
   */
  const onKey = (key: InputKey, event: KeyboardEvent): boolean => {
    // An open menu has the keys first: the arrows choose, Enter and Tab take, Escape closes.
    if (menuOpen) {
      if (key === "up" || key === "down") {
        setPointed({ query, index: (active + (key === "up" ? rows.length - 1 : 1)) % rows.length });
        return true;
      }
      // `/compact` typed in full and Enter: the name is already there, and sending is what was meant. A file is still taken
      // (its link is made when it is picked), and Tab always takes.
      const complete = kind === "command" && rows[active]?.name === query;
      // Only a plain Enter takes: with Shift, Alt, Cmd or Ctrl it is not a menu pick.
      const plain =
        key === "enter" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey;
      if (key === "tab" || (plain && !complete)) {
        pick(active);
        return true;
      }
      if (key === "escape") {
        setDismissed(query);
        return true;
      }
      // ⌘Enter with a menu open sends nothing: half a command or a file name is not the message.
      if (key === "enter" && (event.metaKey || event.ctrlKey)) return true;
    }
    if (key === "enter") {
      // ⌘Enter (Ctrl+Enter off a Mac) queues while the agent works and sends when it does not. While a permission
      // waits, it is the card's "Allow once" (app.tsx), so it is left to go on to the window.
      if (QUEUE_MOD(event) && !event.shiftKey && !event.altKey) {
        if (permissionWaits) return false;
        void send(false, "shortcut");
        return true;
      }
      // Shift+Enter (and Alt+Enter) is always a new line.
      if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
      // Enter sends: into the running turn where it can steer, to the queue where it cannot.
      void send(steers, "enter");
      return true;
    }
    if (key !== "up" && key !== "down") return false;
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return false;
    // They are the caret's unless it has nowhere to go: the first block going up, the last going down.
    const caret = input.current?.caret();
    if (caret === undefined || (key === "up" ? !caret.first : !caret.last)) return false;
    // Read when the key is pressed, not watched.
    const items = store.getState().views[sessionKey]?.conversation.items ?? [];
    const found = recall(sentTexts(items), recalled.current, text, key);
    if (found === undefined) return false;
    recalled.current = found.state;
    store.drafts.setText(sessionKey, found.text);
    return true;
  };

  // Dropping files: listeners on the element itself (a drag is not something a keyboard does, so it is not a handler of the markup).
  const attachRef = useRef(attach);
  attachRef.current = attach;
  useEffect(() => {
    const el = root.current;
    if (el === null || !attachable) return;
    const hasFiles = (event: globalThis.DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const over = (event: globalThis.DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDropping(true);
    };
    const leave = (event: globalThis.DragEvent) => {
      if (event.relatedTarget instanceof Node && el.contains(event.relatedTarget)) return;
      setDropping(false);
    };
    const drop = (event: globalThis.DragEvent) => {
      setDropping(false);
      if (!hasFiles(event)) return;
      event.preventDefault();
      // Every file is looked at: one the agent cannot take is refused with the reason, not passed over in silence.
      void attachRef.current(Array.from(event.dataTransfer?.files ?? []), "drop");
    };
    el.addEventListener("dragover", over);
    el.addEventListener("dragleave", leave);
    el.addEventListener("drop", drop);
    return () => {
      el.removeEventListener("dragover", over);
      el.removeEventListener("dragleave", leave);
      el.removeEventListener("drop", drop);
    };
  }, [attachable]);

  const showBlocked = blocked !== undefined && blocked !== "" && connected;
  const hasExtensions =
    plan !== undefined || queue.length > 0 || showBlocked || dropping || problem !== undefined;

  const hasChoiceSettings =
    settings !== undefined &&
    onSetting !== undefined &&
    propertiesOf(settings.schema).some(([, property]) => {
      const choices = optionsOf(property);
      return choices !== undefined && choices.length > 0;
    });
  const hasTools = hasChoiceSettings || context !== undefined;

  const sendName = t(steers ? "composer.steer" : "composer.send");
  const menuLabel = t(
    kind === "command"
      ? "composer.commands.label"
      : canMentionSessions
        ? "composer.mentions.labelWithSessions"
        : "composer.mentions.label",
  );

  return (
    <div data-slot="composer" data-dropping={dropping || undefined} ref={root}>
      {/* Part 1: Extension tray — one compact row per extension type, docked cleanly above the input box. */}
      {hasExtensions ? (
        <div data-slot="composer-extensions">
          {plan !== undefined ? (
            <div data-slot="extension-row" data-kind="plan">
              <PlanStrip plan={plan} />
            </div>
          ) : null}
          {queue.length > 0 ? (
            <ul data-slot="queued" aria-label={t("composer.queued.label")}>
              {queue.map((entry) => {
                const preview = previewOf(entry);
                const label =
                  preview.text !== ""
                    ? preview.text
                    : preview.images > 0
                      ? t("composer.queued.images", { count: preview.images })
                      : t("composer.queued.files", { count: preview.files });
                return (
                  <li key={entry.queueId} data-slot="queued-message">
                    <span data-slot="queued-tag">{t("composer.queued.tag")}</span>
                    <span data-slot="queued-text" title={label}>
                      {label}
                    </span>
                    <Button
                      data-variant="ghost"
                      disabled={!connected}
                      aria-label={t("composer.queued.edit", { preview: label })}
                      onClick={() => void edit(entry.queueId)}
                    >
                      {t("composer.queued.editShort")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {showBlocked ? (
            <div data-slot="extension-row" data-kind="hint" role="status">
              {blocked}
            </div>
          ) : null}
          {dropping ? (
            <div data-slot="extension-row" data-kind="drop">
              {t(canAttachFiles ? "composer.dropFiles" : "composer.drop")}
            </div>
          ) : null}
          {problem !== undefined ? (
            <div data-slot="extension-row" data-severity="error" role="alert">
              {problem}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Part 2: Input box — single-line pill by default; promotes to 3-row layout on wrap, attachments, or multi-action. */}
      <div
        data-slot="composer-box"
        data-multiline={expanded || undefined}
        data-has-attachments={hasAttachments || undefined}
        data-no-lead={!attachable || undefined}
      >
        {/* Over the whole box, not the field: beside the buttons of one line the field can be narrow. */}
        {menuOpen ? (
          <PickerMenu
            id={menuId}
            label={menuLabel}
            rows={rows}
            active={active}
            onPick={pick}
            onHover={(index) => setPointed({ query, index })}
          />
        ) : nothingFound ? (
          <div data-slot="picker" role="status">
            {/* A bare @ in a folder with nothing in it says so, rather than opening nothing. */}
            {t(
              typed.mention === ""
                ? "composer.mentions.none"
                : canMentionSessions
                  ? "composer.mentions.emptyWithSessions"
                  : "composer.mentions.empty",
            )}
          </div>
        ) : null}
        {hasAttachments ? (
          <ul data-slot="attachments" aria-label={t("composer.attached")}>
            {kept.map((k) => (
              <li key={k.id} data-slot="attachment" data-kept="">
                <span data-slot="attachment-name">{k.name}</span>
                <button
                  type="button"
                  data-slot="attachment-remove"
                  aria-label={t("composer.remove", { name: k.name })}
                  onClick={() => store.drafts.removeKept(sessionKey, k.id)}
                >
                  <CloseIcon size={11} />
                </button>
              </li>
            ))}
            {attachments.map((a) => (
              <li key={a.id} data-slot="attachment" data-kind={a.kind} title={a.name}>
                {a.kind === "image" ? (
                  <img src={`data:${a.type};base64,${a.data}`} alt="" />
                ) : (
                  // A file is named and sized, never shown: its content is not drawn here.
                  <>
                    <AttachIcon size={12} />
                    <span data-slot="attachment-name">{a.name}</span>
                    <span data-slot="attachment-size">{sizeOf(a.bytes)}</span>
                  </>
                )}
                <button
                  type="button"
                  data-slot="attachment-remove"
                  aria-label={t("composer.remove", { name: a.name })}
                  onClick={() =>
                    store.drafts.setAttachments(
                      sessionKey,
                      store.drafts.get(sessionKey).attachments.filter((x) => x.id !== a.id),
                    )
                  }
                >
                  <CloseIcon size={11} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div data-slot="composer-lead">
          {attachable ? (
            <>
              <Tip label={t(canAttachFiles ? "composer.attachFiles" : "composer.attach")}>
                <Button
                  data-variant="ghost"
                  data-kind="composer-plus"
                  disabled={!enabled}
                  onClick={() => picker.current?.click()}
                >
                  <PlusIcon size={16} />
                </Button>
              </Tip>
              <input
                ref={picker}
                type="file"
                hidden
                multiple
                // Any file when the agent takes files: what it cannot take is refused with the reason once chosen.
                {...(canAttachFiles ? {} : { accept: IMAGE_TYPES.join(",") })}
                onChange={(event) => {
                  void attach(Array.from(event.currentTarget.files ?? []), "button");
                  event.currentTarget.value = "";
                }}
              />
            </>
          ) : null}
        </div>

        <div data-slot="composer-field" ref={fieldRef}>
          <MarkdownInput
            value={text}
            onChange={(markdown) => {
              if (markdown !== recalled.current.shown) recalled.current = NOT_RECALLING;
              store.drafts.setText(sessionKey, markdown);
            }}
            disabled={!enabled}
            label={t("composer.message")}
            placeholder={placeholder}
            onKey={onKey}
            pasteFiles={canAttachFiles ? "any" : "images"}
            onPasteFiles={(files) => void attach(files, "paste")}
            handle={input}
            onCaret={lookAtCaret}
            menu={{
              id: menuId,
              open: menuOpen,
              activeId: menuOpen ? optionId(menuId, active) : undefined,
            }}
          />
        </div>

        <div data-slot="composer-actions">
          {showQueue ? (
            <Button
              data-kind="queue"
              disabled={!canSend}
              title={t("composer.queueKey", { key: QUEUE_KEY })}
              aria-keyshortcuts={MOD === "⌘" ? "Meta+Enter" : "Control+Enter"}
              onClick={() => void send(false, "button")}
            >
              {t("composer.queue")}
            </Button>
          ) : null}
          {showSend ? (
            <Tip label={sendName}>
              <Button
                data-variant="solid"
                data-kind="round"
                data-action="send"
                disabled={!canSend}
                onClick={() => void send(steers, "button")}
              >
                <SendIcon size={15} />
              </Button>
            </Tip>
          ) : null}
          {working ? (
            <Tip label={t("composer.stop")} shortcut="mod+.">
              <Button
                data-variant="outline"
                data-kind="round"
                data-action="stop"
                disabled={!connected}
                onClick={() => void store.cancel()}
              >
                <StopIcon size={11} />
              </Button>
            </Tip>
          ) : null}
        </div>
      </div>

      {/* Part 3: Utility bar — borderless controls beneath the input box: permission on left, model + effort & context ring on right. */}
      {hasTools ? (
        <div data-slot="composer-tools">
          <div data-slot="composer-tools-start">
            {settings !== undefined && onSetting !== undefined ? (
              <SettingChips
                side="left"
                settings={settings}
                disabled={!enabled || !connected}
                onSet={onSetting}
              />
            ) : null}
          </div>
          <div data-slot="composer-tools-end">
            {settings !== undefined && onSetting !== undefined ? (
              <SettingChips
                side="right"
                settings={settings}
                disabled={!enabled || !connected}
                onSet={onSetting}
              />
            ) : null}
            {context !== undefined ? (
              <ContextMeter context={context} planUsage={planUsage} />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The key that queues: ⌘Enter on a Mac, Ctrl+Enter elsewhere. One name, in the placeholder and on the button. */
const QUEUE_KEY = `${MOD}Enter`;
const QUEUE_MOD = (event: KeyboardEvent) => (MOD === "⌘" ? event.metaKey : event.ctrlKey);

/**
 * How full the context is: a spring-driven progress ring with a synchronized rolling percentage. It is a button: the
 * details (`context-details.tsx`) open in the utility bar's popover, and say only what the agent reported
 * (docs/protocol.md §8, CYCL-74).
 */
function ContextMeter({
  context,
  planUsage,
}: {
  context: ContextState;
  planUsage?: PlanUsage | undefined;
}) {
  const { t, number } = useI18n();
  const store = useAppStore();
  const reduced = Boolean(useReducedMotion());
  const { usage } = context;
  const measured = usage !== undefined && usage.size > 0;
  const share = measured ? Math.max(0, Math.min(1, usage.used / usage.size)) : 0;
  const before = usage?.beforeCompaction === true;
  // Something in it that rounds to 0% is not empty: it says "<1%".
  const percentOf = useCallback(
    (v: number) =>
      v > 0 && v < 0.005
        ? t("composer.context.underPercent", { percent: number(0.01, { style: "percent" }) })
        : number(v, { style: "percent" }),
    [t, number],
  );
  const percent = percentOf(share);
  const tone =
    !measured || before
      ? undefined
      : share > 0.9
        ? "danger"
        : share > 0.7
          ? "attention"
          : undefined;
  const full = measured && !before && share >= 1;
  const r = 5.25;
  const around = 2 * Math.PI * r;
  const name = !measured
    ? t("composer.context.ringEmpty")
    : before
      ? t("composer.context.ringBefore", { percent })
      : t("composer.context.ring", { percent });

  const [open, setOpen] = useState(false);
  const titleId = useId();

  const arcRef = useRef<SVGCircleElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const initialShareRef = useRef(share);
  const initialPercentRef = useRef(percent);
  const raw = useMotionValue(share);
  // Fluid UI spring physics (ω ≈ 8, ζ ≈ 0.72 → k = 64, c = 11.5): weighted settle with gentle organic overshoot.
  const spring = useSpring(raw, { stiffness: 64, damping: 11.5, mass: 1 });
  const instant = reduced || MotionGlobalConfig.skipAnimations;

  useLayoutEffect(() => {
    if (instant) {
      raw.jump(share);
      spring.jump(share);
      if (arcRef.current !== null)
        arcRef.current.style.strokeDashoffset = `${around * (1 - share)}`;
      if (textRef.current !== null) textRef.current.textContent = percentOf(share);
      return;
    }
    raw.set(share);
  }, [share, instant, raw, spring, around, percentOf]);

  useEffect(() => {
    if (instant) return;
    return spring.on("change", (v) => {
      // Clamp to [0, 1] so underdamped spring overshoot settles smoothly without opening a gap at 12 o'clock.
      const clamped = Math.max(0, Math.min(1, v));
      if (arcRef.current !== null)
        arcRef.current.style.strokeDashoffset = `${around * (1 - clamped)}`;
      if (textRef.current !== null) textRef.current.textContent = percentOf(clamped);
    });
  }, [instant, spring, around, percentOf]);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next)
          store.track("context_details_opened", {
            state: !measured ? "empty" : before ? "before_compaction" : "measured",
            parts: measured && !before && (usage.parts?.length ?? 0) > 0,
            plan: planRowsOf(planUsage, Date.now()).length > 0,
          });
        setOpen(next);
      }}
    >
      <Tip label={name}>
        <PopoverTrigger
          data-kind="context-meter"
          data-tone={tone}
          data-full={full || undefined}
          data-empty={!measured || undefined}
          data-before={before || undefined}
        >
          <svg width="15" height="15" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r={r} data-slot="context-track" />
            <circle
              ref={arcRef}
              cx="7"
              cy="7"
              r={r}
              data-slot="context-fill"
              strokeDasharray={around}
              strokeDashoffset={around * (1 - initialShareRef.current)}
              transform="rotate(-90 7 7)"
            />
          </svg>
          {/* Always there, so the rolling number has somewhere to land; hidden while nothing is measured. */}
          <span ref={textRef} data-slot="context-percent" aria-hidden="true">
            {initialPercentRef.current}
          </span>
        </PopoverTrigger>
      </Tip>
      {/* Nothing in it takes the focus, so the details themselves do: a screen reader reads them as they open. */}
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        collisionPadding={12}
        initialFocus="content"
        aria-labelledby={titleId}
        data-kind="context"
      >
        <ContextDetails
          context={context}
          plan={planUsage}
          percentOf={percentOf}
          titleId={titleId}
        />
      </PopoverContent>
    </Popover>
  );
}
