// The input of the composer: a Lexical editor whose document is read and written as Markdown (composer-markdown.ts), so
// that what is typed shows as it will read, and what goes out is what was typed. Enter sends; the rest of the keys that
// the composer has a use for (the arrows that walk through what was sent, the menus) are asked first.

import { $isListItemNode, $isListNode } from "@lexical/list";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { isComposing } from "@ui-sdk/core";
import {
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  INSERT_LINE_BREAK_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  type LexicalEditor,
  PASTE_COMMAND,
} from "lexical";
import { createElement, type RefObject, useEffect, useRef } from "react";
import {
  $setMarkdown,
  type MentionRef,
  markdownOf,
  NODES,
  setMarkdown,
  TRANSFORMERS_FOR_COMPOSER,
} from "../composer-markdown.ts";
import { $createMentionNode } from "./mention-node.tsx";

export type InputKey = "enter" | "up" | "down" | "right" | "tab" | "escape";

/** Where the caret is, for what a key means there. */
export type Caret = {
  /** The text of the block the caret is in, up to the caret. A menu's trigger is looked for in it. */
  before: string;
  /** In the first block of the document, and in the last: the arrows are the caret's elsewhere. */
  first: boolean;
  last: boolean;
  /** The caret is in the first block, at its start. */
  atStart: boolean;
};

export type InputHandle = {
  focus: () => void;
  caret: () => Caret;
  /** Replaces the last `length` characters before the caret (in its block) with `text`. */
  replaceBeforeCaret: (length: number, text: string, mention?: MentionRef) => void;
};

export type MarkdownInputProps = {
  /** The Markdown. The editor is made to hold it when it is not what the editor last said. */
  value: string;
  /** The mentions the draft holds: the `@path` of each that the text says is shown as a block, not as words. */
  mentions?: readonly MentionRef[] | undefined;
  onChange: (markdown: string) => void;
  disabled: boolean;
  label: string;
  placeholder: string;
  /**
   * The placeholder is a message the agent suggested (CYCL-225), which `keyShortcuts` take: said so to those who cannot
   * see it, and marked for the eye.
   */
  suggested?: { keyShortcuts: string } | undefined;
  /**
   * Asked first of the keys named in `InputKey`. True: the key was used, and nothing else happens. Enter, with or without
   * a modifier, is asked too; one the parent does not use is a new line (a line break, as Shift+Enter makes in a
   * plain editor), never a new paragraph.
   */
  onKey: (key: InputKey, event: KeyboardEvent) => boolean;
  /** Files pasted into the input: pictures only, or any file (`pasteFiles`). Files not taken paste as nothing. */
  onPasteFiles: (files: File[]) => void;
  /** Which pasted files go to `onPasteFiles`: pictures (the default), or any file, when the agent takes files. */
  pasteFiles?: "images" | "any";
  handle?: RefObject<InputHandle | null>;
  /** The document or the caret changed: the menus look again at what is before the caret. */
  onCaret?: () => void;
  /** A menu of choices is open below the input: the input says so, and which one is active, to those who cannot see it. */
  menu?: { id: string; open: boolean; activeId?: string | undefined };
};

const caretOf = (editor: LexicalEditor): Caret => {
  const none: Caret = { before: "", first: true, last: true, atStart: true };
  return editor.read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return none;
    const anchor = selection.anchor;
    const node = anchor.getNode();
    const block = node.getTopLevelElement();
    if (block === null) return none;
    // The block's text up to the caret: what comes before the anchor's node in the block, then the node up to the caret.
    let before = "";
    let found = false;
    const walk = (parent: { getChildren?: () => unknown[] } & object): void => {
      for (const child of (parent.getChildren?.() ?? []) as {
        getKey: () => string;
        getTextContent: () => string;
        getChildren?: () => unknown[];
      }[]) {
        if (found) return;
        if (child.getKey() === node.getKey()) {
          before += anchor.type === "text" ? child.getTextContent().slice(0, anchor.offset) : "";
          found = true;
          return;
        }
        if (child.getChildren !== undefined) {
          walk(child);
          if (found) return;
        } else {
          before += child.getTextContent();
        }
      }
    };
    if (block.getKey() === node.getKey()) found = true;
    else walk(block);
    const first = block.getPreviousSibling() === null;
    return {
      before,
      first,
      last: block.getNextSibling() === null,
      atStart: first && before === "",
    };
  });
};

/** The caret is in an item of a list. Called in a command's listener, where the editor's state can be read. */
const $inListItem = (): boolean => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  // The anchor may be an item, something in one, or the list itself (at an element offset, between its items).
  const node = selection.anchor.getNode();
  return [node, ...node.getParents()].some((n) => $isListItemNode(n) || $isListNode(n));
};

function Behaviour({ props }: { props: MarkdownInputProps }) {
  const [editor] = useLexicalComposerContext();
  // What the props say now, for the handlers that are made once.
  const latest = useRef(props);
  latest.current = props;
  const emitted = useRef(props.value);

  useEffect(() => {
    editor.setEditable(!props.disabled);
  }, [editor, props.disabled]);

  // The editor tells of what the person did; what was put there from outside is not told back unless it was changed on the way.
  useEffect(
    () =>
      editor.registerUpdateListener(({ dirtyElements, dirtyLeaves }) => {
        latest.current.onCaret?.();
        if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;
        const markdown = markdownOf(editor);
        if (markdown === emitted.current) return;
        emitted.current = markdown;
        latest.current.onChange(markdown);
      }),
    [editor],
  );

  // A text that did not come from the editor (a message taken back, one recalled, the box emptied by a send).
  useEffect(() => {
    if (props.value === emitted.current) return;
    emitted.current = props.value;
    setMarkdown(editor, props.value, latest.current.mentions);
    editor.update(() => $getRoot().selectEnd(), { discrete: true, tag: "history-merge" });
  }, [editor, props.value]);

  useEffect(() => {
    const key =
      (name: InputKey) =>
      (event: KeyboardEvent | null): boolean => {
        if (event === null) return false;
        if (name === "enter") {
          // Enter that confirms an IME composition is not a send; Safari reports it as !event.isComposing.
          if (isComposing(event)) return false;
          // Cmd/Ctrl+Enter is never a line break. The parent may use it (to queue); one it leaves is an app shortcut
          // (approving a permission), so the DOM keydown goes on bubbling to window.
          if (event.metaKey || event.ctrlKey) {
            event.preventDefault();
            // Used here (queued, say): the window's shortcut for it (Allow once) must not run as well.
            if (latest.current.onKey("enter", event)) event.stopPropagation();
            return true;
          }
          event.preventDefault();
          // Not used by the parent: a new line, the one Shift+Enter makes, whichever modifier asked for it. In a list the
          // new line is the next item, and on an empty item it ends the list (CYCL-142): a line break would keep what
          // follows in the item above, so "2." could never be typed.
          if (latest.current.onKey("enter", event)) return true;
          if ($inListItem()) editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined);
          else editor.dispatchCommand(INSERT_LINE_BREAK_COMMAND, false);
          return true;
        }
        if (isComposing(event)) return false;
        if (!latest.current.onKey(name, event)) return false;
        event.preventDefault();
        return true;
      };
    const stops = [
      editor.registerCommand(KEY_ENTER_COMMAND, key("enter"), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ARROW_UP_COMMAND, key("up"), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ARROW_DOWN_COMMAND, key("down"), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ARROW_RIGHT_COMMAND, key("right"), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_TAB_COMMAND, key("tab"), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(KEY_ESCAPE_COMMAND, key("escape"), COMMAND_PRIORITY_HIGH),
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          const data = (event as ClipboardEvent).clipboardData;
          const pictures = Array.from(data?.files ?? []).filter(
            (f) => latest.current.pasteFiles === "any" || f.type.startsWith("image/"),
          );
          if (pictures.length > 0) {
            event.preventDefault();
            latest.current.onPasteFiles(pictures);
            return true;
          }
          // Text goes in as text, whatever it came from: pasted HTML would bring formatting nobody typed.
          const text = data?.getData("text/plain") ?? "";
          if (text === "") return false;
          event.preventDefault();
          editor.update(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) selection.insertRawText(text);
          });
          return true;
        },
        COMMAND_PRIORITY_HIGH,
      ),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  }, [editor]);

  useEffect(() => {
    const handle = latest.current.handle;
    if (handle === undefined) return;
    handle.current = {
      focus: () => editor.focus(),
      caret: () => caretOf(editor),
      replaceBeforeCaret: (length, text, mention) =>
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;
          const node = selection.anchor.getNode();
          if ($isTextNode(node) && selection.anchor.type === "text") {
            const end = selection.anchor.offset;
            const take = Math.min(length, end);
            node.spliceText(end - take, take, text, true);
            let left = length - take;
            let prev = node.getPreviousSibling();
            while (left > 0 && prev !== null) {
              const before = prev.getPreviousSibling();
              if ($isTextNode(prev)) {
                const size = prev.getTextContentSize();
                const drop = Math.min(left, size);
                prev.spliceText(size - drop, drop, "", false);
                left -= drop;
              }
              prev = before;
            }
          } else {
            // Element anchor right after a text node (e.g., boundary after restored draft).
            const prev =
              selection.anchor.type === "element" && selection.anchor.offset > 0
                ? (node as { getChildAtIndex?: (i: number) => unknown }).getChildAtIndex?.(
                    selection.anchor.offset - 1,
                  )
                : null;
            if ($isTextNode(prev as never)) {
              const t = prev as unknown as {
                getTextContentSize: () => number;
                spliceText: (o: number, d: number, s: string, move: boolean) => void;
              };
              const size = t.getTextContentSize();
              const take = Math.min(length, size);
              t.spliceText(size - take, take, text, true);
            } else {
              selection.insertRawText(text);
            }
          }
          if (mention !== undefined) {
            const now = $getSelection();
            if ($isRangeSelection(now))
              now.insertNodes([
                $createMentionNode(mention.path, mention.kind),
                $createTextNode(" "),
              ]);
          }
        }),
    };
    return () => {
      handle.current = null;
    };
  }, [editor]);

  return null;
}

export function MarkdownInput(props: MarkdownInputProps) {
  // The document it starts with. Later changes of the text arrive through the plugin, which tells them from the editor's own.
  const first = useRef({ text: props.value, mentions: props.mentions });
  return (
    <LexicalComposer
      initialConfig={{
        namespace: "composer",
        nodes: NODES,
        editable: !props.disabled,
        editorState: () => $setMarkdown(first.current.text, first.current.mentions),
        onError: (error) => {
          throw error;
        },
      }}
    >
      <RichTextPlugin
        contentEditable={
          <ContentEditable
            data-slot="composer-input"
            aria-label={props.label}
            aria-multiline
            aria-haspopup={props.menu === undefined ? undefined : "listbox"}
            aria-expanded={props.menu?.open}
            aria-controls={props.menu?.open ? props.menu.id : undefined}
            aria-activedescendant={props.menu?.open ? props.menu.activeId : undefined}
            aria-placeholder={props.placeholder}
            aria-keyshortcuts={props.suggested?.keyShortcuts}
            placeholder={createElement(
              "div",
              {
                "data-slot": "composer-placeholder",
                ...(props.suggested !== undefined ? { "data-suggested": "" } : {}),
              },
              props.placeholder,
            )}
          />
        }
        placeholder={null}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <HistoryPlugin />
      <ListPlugin />
      <MarkdownShortcutPlugin transformers={TRANSFORMERS_FOR_COMPOSER} />
      <Behaviour props={props} />
    </LexicalComposer>
  );
}
