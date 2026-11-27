// An @ the person picked, as one block in the composer's document: it is put in whole, and taken out whole. It reads and
// writes as the `@path` text that the draft and the message say, so only the editor knows it is a block (CYC-358).

import { DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode } from "lexical";
import { createElement, type ReactNode } from "react";
import { mentionText } from "../draft.ts";
import { FileIcon, FolderIcon, MessageIcon } from "./icons.tsx";

export type MentionKind = "file" | "folder" | "session";

type Serialized = SerializedLexicalNode & { path: string; kind: MentionKind };

/** The icon of a mention, the same in the box and in a sent message. */
export const MentionIcon = ({ kind }: { kind: MentionKind }) =>
  kind === "session"
    ? createElement(MessageIcon, { size: 12 })
    : kind === "folder"
      ? createElement(FolderIcon, { size: 12 })
      : createElement(FileIcon, { size: 12 });

export class MentionNode extends DecoratorNode<ReactNode> {
  __path: string;
  __kind: MentionKind;

  static override getType(): string {
    return "mention";
  }

  static override clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__path, node.__kind, node.__key);
  }

  static override importJSON(json: Serialized): MentionNode {
    return new MentionNode(json.path, json.kind);
  }

  constructor(path: string, kind: MentionKind, key?: NodeKey) {
    super(key);
    this.__path = path;
    this.__kind = kind;
  }

  override exportJSON(): Serialized {
    return {
      ...super.exportJSON(),
      type: "mention",
      version: 1,
      path: this.__path,
      kind: this.__kind,
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
    return createElement(
      "span",
      { "data-slot": "mention-chip", "data-kind": this.__kind, title: said },
      createElement(MentionIcon, { kind: this.__kind }),
      said,
    );
  }
}

export const $createMentionNode = (path: string, kind: MentionKind): MentionNode =>
  new MentionNode(path, kind);

export const $isMentionNode = (node: LexicalNode | null | undefined): node is MentionNode =>
  node instanceof MentionNode;
