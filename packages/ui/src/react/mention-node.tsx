// An @ the person picked, as one block in the composer's document: it is put in whole, and taken out whole. It reads and
// writes as the `@path` text that the draft and the message say, so only the editor knows it is a block (CYC-358).

import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import { DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode } from "lexical";
import { createElement, type HTMLAttributes, type ReactNode } from "react";
import { mentionText } from "../draft.ts";
import { sessionChipText } from "../mention.ts";
import { FileIcon, FolderIcon, MessageIcon } from "./icons.tsx";

export type MentionKind = "file" | "folder" | "session";

type Serialized = SerializedLexicalNode & {
  path: string;
  kind: MentionKind;
  name?: string | undefined;
};

/** The icon of a mention, the same in the box and in a sent message. */
export const MentionIcon = ({ kind }: { kind: MentionKind }) =>
  kind === "session"
    ? createElement(MessageIcon, { size: 12 })
    : kind === "folder"
      ? createElement(FolderIcon, { size: 12 })
      : createElement(FileIcon, { size: 12 });

/**
 * A session @ mention chip with a tooltip showing its full session name. Renders an interactive `<button>` when
 * `onClick` is provided (keeping Tooltip's `aria-labelledby` for its full accessible name) and a plain `<span>`
 * otherwise (stripping `type` and `aria-labelledby`, which are invalid on a generic span).
 */
export function SessionMentionView({
  shown,
  fullName,
  onClick,
}: {
  shown: string;
  fullName: string;
  onClick?: (() => void) | undefined;
}) {
  return (
    <Tooltip type="label">
      <TooltipTrigger
        render={
          onClick !== undefined
            ? (props) => (
                <button
                  {...props}
                  type="button"
                  data-slot="mention-chip"
                  data-kind="session"
                  onClick={(event) => {
                    props.onClick?.(event);
                    onClick();
                  }}
                >
                  <MentionIcon kind="session" />
                  <span data-slot="mention-label">{shown}</span>
                </button>
              )
            : ({ type: _type, "aria-labelledby": _labelledBy, ...props }) => (
                <span
                  {...(props as HTMLAttributes<HTMLSpanElement>)}
                  data-slot="mention-chip"
                  data-kind="session"
                >
                  <MentionIcon kind="session" />
                  <span data-slot="mention-label">{shown}</span>
                </span>
              )
        }
      />
      <TooltipContent
        side="top"
        sideOffset={6}
        collisionPadding={8}
        container={typeof document === "undefined" ? null : document.body}
      >
        {fullName}
      </TooltipContent>
    </Tooltip>
  );
}

export class MentionNode extends DecoratorNode<ReactNode> {
  __path: string;
  __kind: MentionKind;
  __name: string | undefined;

  static override getType(): string {
    return "mention";
  }

  static override clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__path, node.__kind, node.__name, node.__key);
  }

  static override importJSON(json: Serialized): MentionNode {
    return new MentionNode(json.path, json.kind, json.name);
  }

  constructor(path: string, kind: MentionKind, name?: string, key?: NodeKey) {
    super(key);
    this.__path = path;
    this.__kind = kind;
    this.__name = name;
  }

  override exportJSON(): Serialized {
    return {
      ...super.exportJSON(),
      type: "mention",
      version: 1,
      path: this.__path,
      kind: this.__kind,
      ...(this.__name !== undefined ? { name: this.__name } : {}),
    };
  }

  override createDOM(): HTMLElement {
    return document.createElement("span");
  }

  override updateDOM(): false {
    return false;
  }

  override isInline(): true {
    return true;
  }

  /** What the text says of it: the `@path` the draft and the message hold. */
  override getTextContent(): string {
    return mentionText({ path: this.__path, kind: this.__kind === "folder" ? "folder" : "file" });
  }

  override decorate(): ReactNode {
    const said = this.getTextContent().slice(1);
    if (this.__kind === "session") {
      const fullName = this.__name !== undefined && this.__name !== "" ? this.__name : said;
      return createElement(SessionMentionView, { shown: sessionChipText(said), fullName });
    }
    return createElement(
      "span",
      { "data-slot": "mention-chip", "data-kind": this.__kind, title: said },
      createElement(MentionIcon, { kind: this.__kind }),
      createElement("span", { "data-slot": "mention-label" }, said),
    );
  }
}

export const $createMentionNode = (path: string, kind: MentionKind, name?: string): MentionNode =>
  new MentionNode(path, kind, name);

export const $isMentionNode = (node: LexicalNode | null | undefined): node is MentionNode =>
  node instanceof MentionNode;
