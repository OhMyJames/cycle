import type { FileContent, SessionInfo } from "@cycle/protocol";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/icons.tsx";
import { CopyButton, Markdown } from "../components/markdown.tsx";
import { useStore } from "../client/store.ts";
import { useApp } from "../context.ts";
import { basename } from "../lib/format.ts";
import { highlight, languageOf } from "../lib/highlight.ts";

interface Entry {
  name: string;
  directory: boolean;
}

function Folder({
  path,
  depth,
  showHidden,
  selected,
  onOpen,
}: {
  path: string;
  depth: number;
  showHidden: boolean;
  selected: string | null;
  onOpen(path: string): void;
}) {
  const app = useApp();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    let current = true;
    app.request("files.list", { path }).then(
      (answer) => current && setEntries(answer.entries),
      () => current && setEntries([]),
    );
    return () => {
      current = false;
    };
  }, [app, path]);
  if (entries === null) return <div className="note">Reading…</div>;
  const shown = showHidden
    ? entries
    : entries.filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules");
  return shown.map((entry) => {
    const full = `${path}/${entry.name}`;
    const expanded = open.has(entry.name);
    return (
      <div key={entry.name}>
        <button
          type="button"
          className="tree-row"
          data-active={full === selected}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => {
            if (!entry.directory) return onOpen(full);
            setOpen((value) => {
              const next = new Set(value);
              if (next.has(entry.name)) next.delete(entry.name);
              else next.add(entry.name);
              return next;
            });
          }}
        >
          {entry.directory ? (
            <Icon name={expanded ? "chevron-down" : "chevron-right"} size={12} />
          ) : (
            <span style={{ width: 12 }} />
          )}
          <Icon name={entry.directory ? "folder" : "file"} size={14} />
          <span className="truncate">{entry.name}</span>
        </button>
        {entry.directory && expanded ? (
          <Folder
            path={full}
            depth={depth + 1}
            showHidden={showHidden}
            selected={selected}
            onOpen={onOpen}
          />
        ) : null}
      </div>
    );
  });
}

const Code = memo(function Code({
  path,
  text,
  line,
}: {
  path: string;
  text: string;
  line: number | null;
}) {
  const html = useMemo(() => highlight(text, languageOf(path)), [path, text]);
  const count = useMemo(() => text.split("\n").length, [text]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!line || !ref.current) return;
    ref.current.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: "center" });
  }, [line, html]);
  return (
    <div className="file-code" ref={ref}>
      <div className="line-numbers" aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <span key={index} data-line={index + 1} data-target={index + 1 === line}>
            {index + 1}
          </span>
        ))}
      </div>
      <pre>
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
});

function FileView({ path, line, root }: { path: string; line: number | null; root: string }) {
  const app = useApp();
  const [content, setContent] = useState<FileContent | { error: string } | null>(null);
  const [preview, setPreview] = useState(true);
  useEffect(() => {
    let current = true;
    setContent(null);
    app.request("files.read", { path }).then(
      (answer) => current && setContent(answer),
      (error: unknown) =>
        current && setContent({ error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      current = false;
    };
  }, [app, path]);
  const relative = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const markdown = /\.(md|markdown)$/i.test(path);
  return (
    <div className="file-view">
      <div className="file-view-header">
        <button
          type="button"
          className="icon-button small"
          title="Back to the files"
          aria-label="Back to the files"
          onClick={() => app.setView({ file: null })}
        >
          <Icon name="chevron-right" className="flip" />
        </button>
        <span className="truncate grow meta" title={path}>
          {relative}
        </span>
        {markdown ? (
          <button type="button" className="ghost" onClick={() => setPreview(!preview)}>
            {preview ? "Code" : "Preview"}
          </button>
        ) : null}
        <CopyButton text={path} label="Copy path" />
      </div>
      {content === null ? (
        <div className="note">Reading {basename(path)}…</div>
      ) : "error" in content ? (
        <div className="note">{content.error}</div>
      ) : content.image ? (
        <div className="image-view">
          <img
            src={`data:${content.image.mime};base64,${content.image.data}`}
            alt={basename(path)}
          />
        </div>
      ) : content.binary ? (
        <div className="note">A binary file of {content.size.toLocaleString()} bytes.</div>
      ) : markdown && preview ? (
        <div className="file-markdown">
          <Markdown text={content.text} />
        </div>
      ) : (
        <>
          <Code path={path} text={content.text} line={line} />
          {content.truncated ? <div className="note">The rest is too large to show.</div> : null}
        </>
      )}
    </div>
  );
}

/** The project's folder as a tree, and one file at a time. */
export function FilesPanel({ info }: { info: SessionInfo }) {
  const app = useApp();
  const file = useStore(app.view, (view) => view.file);
  const [showHidden, setShowHidden] = useState(false);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ path: string; directory: boolean }[]>([]);
  const root = info.cwd;
  useEffect(() => {
    if (!query.trim()) {
      setMatches([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      app.request("files.search", { root, query }).then(
        (answer) => current && setMatches(answer.files.filter((match) => !match.directory)),
        () => {},
      );
    }, 80);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [app, root, query]);
  const open = (path: string) => app.setView({ file: { path, line: null } });
  return (
    <>
      <header className="panel-header">
        <span className="truncate grow">Files</span>
        <button
          type="button"
          className="icon-button"
          aria-pressed={showHidden}
          title="Show hidden files"
          aria-label="Show hidden files"
          onClick={() => setShowHidden(!showHidden)}
        >
          <Icon name="eye" />
        </button>
      </header>
      {file ? (
        <FileView path={file.path} line={file.line} root={root} />
      ) : (
        <>
          <div className="panel-filter">
            <input
              className="field"
              placeholder="Find a file"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuery("");
                if (event.key === "Enter" && matches[0]) open(`${root}/${matches[0].path}`);
              }}
            />
          </div>
          <div className="panel-body tree">
            {query.trim() ? (
              matches.length ? (
                matches.map((match) => (
                  <button
                    key={match.path}
                    type="button"
                    className="tree-row"
                    onClick={() => open(`${root}/${match.path}`)}
                  >
                    <Icon name="file" size={14} />
                    <span className="truncate">
                      {basename(match.path)} <span className="muted">{match.path}</span>
                    </span>
                  </button>
                ))
              ) : (
                <div className="note">No files match.</div>
              )
            ) : (
              <Folder path={root} depth={0} showHidden={showHidden} selected={null} onOpen={open} />
            )}
          </div>
        </>
      )}
    </>
  );
}
