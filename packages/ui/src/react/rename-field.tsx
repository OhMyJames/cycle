// A session's title edited where it is shown (the conversation's header, a row of the sidebar), not in a dialog.
import { isComposing } from "@ui-sdk/core";
import { Input } from "@ui-sdk/react/input";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { SessionSummary } from "../api.ts";
import { useI18n } from "./i18n.tsx";
import { SessionAgent } from "./session-agent.tsx";
import { useAppStore } from "./store-context.tsx";

/** How long a failed rename says why before it goes quiet; the title is back to what it was at once. */
const PROBLEM_MS = 8000;

/**
 * The field the title is edited in. It starts with the title selected; Enter or leaving it keeps what is typed, Escape
 * keeps the old title. `onDone` gets the text, or null when the rename was given up, and whether a key ended it (the
 * focus then goes back where it was; a blur has put it elsewhere already). Its keys and presses are its own: a row of
 * the sidebar's list around it does not walk, select or search on them.
 */
export function RenameField({
  initial,
  onDone,
}: {
  initial: string;
  onDone: (text: string | null, byKey: boolean) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(initial);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  // Until a frame has passed, a blur is the menu that started the rename handing the focus back, not the person leaving.
  const settled = useRef(false);
  const finish = (text: string | null, byKey: boolean) => {
    if (done.current) return; // Enter, then the blur of the field going away
    done.current = true;
    onDone(text, byKey);
  };
  useLayoutEffect(() => {
    const take = () => {
      input.current?.focus();
      input.current?.select();
    };
    take();
    // Again a frame later, if the menu the rename was chosen from took the focus back when it closed.
    const frame = requestAnimationFrame(() => {
      if (document.activeElement !== input.current) take();
      settled.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <Input
      ref={input}
      data-kind="rename-field"
      aria-label={t("rename.label")}
      value={value}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => setValue(event.currentTarget.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        // The Enter or Escape that ends an input method's text (Chinese) is that text's, not the field's.
        if (isComposing(event.nativeEvent)) return;
        if (event.key === "Enter") {
          event.preventDefault();
          finish(value, true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(null, true);
        }
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={() => settled.current && finish(value, false)}
    />
  );
}

/**
 * What a shown title needs to be renamed in place: the title to show (the new one from the moment it is kept until the
 * list says it, so it does not flick back), why the last rename failed, and `finish`, which takes what the field
 * ended with. `rename` answers with why it failed, or nothing. Whether the field is open is the caller's.
 */
export function useRename(current: string, rename: (title: string) => Promise<string | undefined>) {
  const [pending, setPending] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  // The list has the new title (or another): what it says is shown again.
  const [seen, setSeen] = useState(current);
  if (seen !== current) {
    setSeen(current);
    setPending(undefined);
  }
  useEffect(() => {
    if (problem === undefined) return;
    const timer = setTimeout(() => setProblem(undefined), PROBLEM_MS);
    return () => clearTimeout(timer);
  }, [problem]);
  const finish = (text: string | null) => {
    setProblem(undefined);
    const next = text?.trim() ?? "";
    // Given up, emptied, or the same: nothing is asked.
    if (next === "" || next === current) return;
    setPending(next);
    void rename(next).then((error) => {
      if (error === undefined) return;
      setPending(undefined);
      setProblem(error);
    });
  };
  return { shown: pending ?? current, problem, finish };
}

/** Why a rename failed, beside the title it left as it was. */
export function RenameProblem({ problem }: { problem: string | undefined }) {
  const { t } = useI18n();
  if (problem === undefined) return null;
  return (
    <span data-slot="rename-problem" role="alert">
      {t("rename.failed", { reason: problem })}
    </span>
  );
}

/**
 * The open session's title and where it runs, in the conversation's header. A press on the title edits it there, as
 * the header's menu's Rename does. Keyed by the session, so a rename in flight stays with its own.
 */
export function SessionHeading({
  session,
  title,
  editing,
  onEditingChange,
}: {
  session: SessionSummary;
  /** As the sidebar shows it: the folder's name while it has none. */
  title: string;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const store = useAppStore();
  const { t } = useI18n();
  const hint = useId();
  const { shown, problem, finish } = useRename(title, (next) =>
    store.renameSession(session.sessionId, next, "header", session.environmentId),
  );
  const titleButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    titleButton.current?.focus();
  }, [editing]);
  return (
    <div data-slot="session-heading">
      <SessionAgent session={session} />
      {editing ? (
        <RenameField
          initial={title}
          onDone={(text, byKey) => {
            refocus.current = byKey;
            onEditingChange(false);
            finish(text);
          }}
        />
      ) : (
        <h1>
          <button
            ref={titleButton}
            type="button"
            data-kind="session-title"
            aria-describedby={hint}
            onClick={() => onEditingChange(true)}
          >
            {shown}
          </button>
          <span id={hint} hidden>
            {t("session.rename")}
          </span>
        </h1>
      )}
      {editing ? null : <RenameProblem problem={problem} />}
      <span data-slot="session-where" title={session.cwd}>
        {session.cwd}
      </span>
    </div>
  );
}
