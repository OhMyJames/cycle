import { memo, useMemo, useState } from "react";
import { type FileDiff, parseDiff } from "../lib/diff.ts";

const FIRST_LINES = 400;

const SIGNS = { add: "+", del: "−", context: "", hunk: "" } as const;

/**
 * One file's changed lines as a panel shows them: the line's number, its sign, then its text, with
 * a gap where lines were left out.
 */
export const DiffLines = memo(function DiffLines({
  file,
  wrap,
}: {
  file: FileDiff;
  wrap?: boolean;
}) {
  const [all, setAll] = useState(false);
  const lines = all ? file.lines : file.lines.slice(0, FIRST_LINES);
  const width = String(
    file.lines.reduce((most, line) => Math.max(most, line.oldLine ?? 0, line.newLine ?? 0), 0),
  ).length;
  return (
    <div className="diff no-scrollbar" data-wrap={wrap ?? false}>
      <div className="diff-lines">
        {lines.map((line, index) =>
          line.type === "hunk" ? (
            // The first part needs no break before it; a later one names where it is.
            index === 0 ? null : (
              <div key={index} className="diff-line" data-kind="hunk">
                <span className="number" style={{ width: `${width}ch` }}>
                  ⋯
                </span>
                <span className="sign" />
                <span className="text">{line.text.replace(/^@@.*?@@ ?/, "")}</span>
              </div>
            )
          ) : (
            <div key={index} className="diff-line" data-kind={line.type}>
              <span className="number" style={{ width: `${width}ch` }}>
                {line.type === "del" ? line.oldLine : line.newLine}
              </span>
              <span className="sign">{SIGNS[line.type]}</span>
              <span className="text">{line.text}</span>
            </div>
          ),
        )}
      </div>
      {!all && file.lines.length > FIRST_LINES ? (
        <button type="button" className="ghost" onClick={() => setAll(true)}>
          Show {file.lines.length - FIRST_LINES} more lines
        </button>
      ) : null}
    </div>
  );
});

/** Lines added in green and removed in red. A count of none is left out, unless both are. */
export function Stats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="stats tabular">
      {additions > 0 || deletions === 0 ? <span className="plus">+{additions}</span> : null}
      {deletions > 0 ? <span className="minus">−{deletions}</span> : null}
    </span>
  );
}

/** A patch of one file, parsed once however often its card redraws. */
export function PatchView({ patch, path, wrap }: { patch: string; path: string; wrap?: boolean }) {
  const file = useMemo(() => parseDiff(patch, path)[0], [patch, path]);
  if (!file?.lines.length) return <div className="note">No changes to show.</div>;
  return <DiffLines file={file} {...(wrap === undefined ? {} : { wrap })} />;
}

/**
 * A change as the conversation shows it: a sheet of paper with the file's name and its counts, then
 * its lines with a sign column and no numbers, at most 256 high.
 */
export const CodeDiff = memo(function CodeDiff({
  file,
  onOpen,
}: {
  file: FileDiff;
  onOpen?: (() => void) | undefined;
}) {
  const lines = file.lines.slice(0, FIRST_LINES);
  return (
    <div className="code-diff paper">
      <div className="code-diff-header">
        {onOpen ? (
          <button type="button" className="code-diff-name fade-x-start" onClick={onOpen}>
            {file.path}
          </button>
        ) : (
          <span className="code-diff-name fade-x-start">{file.path}</span>
        )}
        <Stats additions={file.additions} deletions={file.deletions} />
      </div>
      {lines.length ? (
        <div className="code-diff-body no-scrollbar">
          {lines.map((line, index) =>
            line.type === "hunk" ? (
              index === 0 ? null : (
                <div key={index} className="code-diff-gap" />
              )
            ) : (
              <div key={index} className="code-diff-line" data-kind={line.type}>
                <span className="sign">{SIGNS[line.type]}</span>
                {line.text}
              </div>
            ),
          )}
          {file.lines.length > FIRST_LINES ? (
            <div className="code-diff-line" data-kind="context">
              <span className="sign" />
              {file.lines.length - FIRST_LINES} more lines
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
