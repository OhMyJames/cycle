import { type ReactNode, createContext, memo, useContext, useRef, useState } from "react";
import { host } from "../client/host.ts";
import { useApp } from "../context.ts";
import { highlight } from "../lib/highlight.ts";
import { sessionOfLink } from "../lib/suggest.ts";
import {
  type MdToken,
  type ParsedMarkdown,
  endsInOpenFence,
  fileReference,
  parseMarkdown,
} from "../lib/markdown-parse.ts";
import { Icon } from "./icons.tsx";

/** What a click on a file named in a reply does. */
export const OpenFileContext = createContext<((path: string, line: number | null) => void) | null>(
  null,
);

export function CopyButton({
  text,
  label = "Copy",
  className = "icon-button",
  size,
}: {
  text: string | (() => string);
  label?: string;
  className?: string;
  size?: number;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(typeof text === "string" ? text : text()).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      <Icon name={copied ? "check" : "copy"} {...(size === undefined ? {} : { size })} />
    </button>
  );
}

/**
 * A code block: a header 32 high with only the language, and copy 4 from the top and right. A block
 * with no language, such as command output, has no header, and its copy floats over the code while
 * hovered or focused.
 */
export const CodeBlock = memo(function CodeBlock({
  code,
  language,
  plain,
}: {
  code: string;
  language: string | null;
  /** Skip highlighting: the block is still being written. */
  plain?: boolean;
}) {
  const html = plain ? null : highlight(code, language);
  return (
    <div className="code-block" data-language={language ?? ""}>
      {language ? <div className="code-block-header">{language}</div> : null}
      <CopyButton text={code} label="Copy code" className="code-copy" />
      {html === null ? (
        <pre className="no-scrollbar">
          <code>{code}</code>
        </pre>
      ) : (
        <pre className="no-scrollbar">
          <code dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      )}
    </div>
  );
});

function InlineCode({ text }: { text: string }) {
  const openFile = useContext(OpenFileContext);
  const reference = openFile ? fileReference(text) : null;
  if (!reference || !openFile) return <code>{text}</code>;
  return (
    <code
      className="file-link"
      role="link"
      tabIndex={0}
      onClick={() => openFile(reference.path, reference.line)}
      onKeyDown={(event) => {
        if (event.key === "Enter") openFile(reference.path, reference.line);
      }}
    >
      {text}
    </code>
  );
}

/** A session named in a prompt or a reply: its title, which opens it. */
export function SessionMention({ id, children }: { id: string; children: ReactNode }) {
  const app = useApp();
  return (
    <button
      type="button"
      className="mention"
      title="Open this session"
      onClick={() => app.selectSession(id)}
    >
      <Icon name="message" size={12} />
      {children}
    </button>
  );
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  const safe = /^(https?:|mailto:)/i.test(href);
  // A session the agent names back, as a prompt's mention of it is drawn.
  const session = sessionOfLink(href);
  if (session) return <SessionMention id={session}>{children}</SessionMention>;
  return (
    <a
      href={safe ? href : undefined}
      onClick={(event) => {
        event.preventDefault();
        if (safe) host.openExternal(href);
      }}
    >
      {children}
    </a>
  );
}

function inline(tokens: MdToken[] | undefined): ReactNode {
  if (!tokens) return null;
  return tokens.map((token, index) => {
    switch (token.type) {
      case "strong":
        return <strong key={index}>{inline(token.tokens)}</strong>;
      case "em":
        return <em key={index}>{inline(token.tokens)}</em>;
      case "del":
        return <del key={index}>{inline(token.tokens)}</del>;
      case "codespan":
        return <InlineCode key={index} text={token.text ?? ""} />;
      case "br":
        return <br key={index} />;
      case "link":
        return (
          <Link key={index} href={token.href ?? ""}>
            {inline(token.tokens)}
          </Link>
        );
      case "image":
        return /^(https:|data:image\/)/.test(token.href ?? "") ? (
          <img key={index} src={token.href} alt={token.text ?? ""} loading="lazy" />
        ) : (
          <span key={index}>{token.text}</span>
        );
      case "text":
        return token.tokens ? <span key={index}>{inline(token.tokens)}</span> : (token.text ?? "");
      case "escape":
        return token.text ?? "";
      default:
        // Raw HTML and anything unknown is shown as the text it is, never run.
        return token.raw;
    }
  });
}

function blockNode(token: MdToken, streaming: boolean): ReactNode {
  switch (token.type) {
    case "space":
      return null;
    case "heading": {
      const Tag = `h${Math.min(token.depth ?? 2, 4)}` as "h1" | "h2" | "h3" | "h4";
      return <Tag>{inline(token.tokens)}</Tag>;
    }
    case "paragraph":
      return <p>{inline(token.tokens)}</p>;
    case "text":
      return <p>{token.tokens ? inline(token.tokens) : token.text}</p>;
    case "code":
      return (
        <CodeBlock
          code={token.text ?? ""}
          language={token.lang?.split(/\s/)[0] || null}
          plain={streaming && endsInOpenFence(token)}
        />
      );
    case "blockquote":
      return <blockquote>{blocks(token.tokens ?? [], streaming)}</blockquote>;
    case "hr":
      return <hr />;
    case "list": {
      const items = (token.items ?? []).map((item, index) => (
        <li key={index} className={item.task ? "task" : undefined}>
          {item.task ? <input type="checkbox" checked={item.checked ?? false} readOnly /> : null}
          {blocks(item.tokens ?? [], streaming, true)}
        </li>
      ));
      return token.ordered ? (
        <ol start={typeof token.start === "number" ? token.start : undefined}>{items}</ol>
      ) : (
        <ul>{items}</ul>
      );
    }
    case "table":
      return (
        <div className="table-wrap no-scrollbar">
          <table>
            <thead>
              <tr>
                {(token.header ?? []).map((cell, index) => (
                  <th key={index} style={{ textAlign: alignOf(token, index) }}>
                    {inline(cell.tokens)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(token.rows ?? []).map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td key={index} style={{ textAlign: alignOf(token, index) }}>
                      {inline(cell.tokens)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return <p>{token.raw}</p>;
  }
}

function alignOf(token: MdToken, index: number): "left" | "right" | "center" | undefined {
  const align = token.align?.[index];
  return align === "left" || align === "right" || align === "center" ? align : undefined;
}

/** Blocks nested in a list item or a quote. A loose `text` block in a list stays inline. */
function blocks(tokens: MdToken[], streaming: boolean, tight = false): ReactNode {
  return tokens.map((token, index) =>
    tight && token.type === "text" ? (
      <span key={index}>{token.tokens ? inline(token.tokens) : token.text}</span>
    ) : (
      <Block key={index} token={token} streaming={streaming} />
    ),
  );
}

const Block = memo(
  function Block({ token, streaming }: { token: MdToken; streaming: boolean }) {
    return blockNode(token, streaming);
  },
  (before, after) =>
    before.streaming === after.streaming &&
    (before.token === after.token ||
      (before.token.type === after.token.type && before.token.raw === after.token.raw)),
);

/**
 * Draws markdown. While `streaming`, each chunk parses and redraws only the
 * last block; every block before it is the same object as last time and is
 * skipped.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  const parsed = useRef<ParsedMarkdown | null>(null);
  if (parsed.current?.text !== text) parsed.current = parseMarkdown(parsed.current, text);
  const list = parsed.current.blocks;
  return (
    <div className="markdown">
      {list.map((token, index) => (
        <Block key={index} token={token} streaming={streaming && index === list.length - 1} />
      ))}
    </div>
  );
});
