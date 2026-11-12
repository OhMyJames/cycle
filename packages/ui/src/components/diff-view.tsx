import { memo, useMemo, useState } from "react";
import { type FileDiff, parseDiff } from "../lib/diff.ts";

const FIRST_LINES = 400;

/** One file's changed lines, with both line numbers in the gutter. */
export const DiffLines = memo(function DiffLines({
  file,
  wrap,
}: {
  file: FileDiff;
  wrap?: boolean;
}) {
  const [all, setAll] = useState(false);
  const lines = all ? file.lines : file.lines.slice(0, FIRST_LINES);
  return (
    <div className="diff" data-wrap={wrap ?? false}>
      <table>
        <tbody>
          {lines.map((line, index) =>
            line.type === "hunk" ? (
              <tr key={index} className="hunk">
                <td colSpan={3}>{line.text}</td>
              </tr>
            ) : (
              <tr key={index} className={line.type}>
                <td className="gutter">{line.oldLine ?? ""}</td>
                <td className="gutter">{line.newLine ?? ""}</td>
                <td className="code">
                  <span className="sign">
                    {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
                  </span>
                  {line.text}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {!all && file.lines.length > FIRST_LINES ? (
        <button type="button" className="ghost" onClick={() => setAll(true)}>
          Show {file.lines.length - FIRST_LINES} more lines
        </button>
      ) : null}
    </div>
  );
});

export function Stats({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="stats tabular">
      {additions ? <span className="plus">+{additions}</span> : null}
      {deletions ? <span className="minus">−{deletions}</span> : null}
    </span>
  );
}

/** A patch of one file, parsed once however often its card redraws. */
export function PatchView({ patch, path, wrap }: { patch: string; path: string; wrap?: boolean }) {
  const file = useMemo(() => parseDiff(patch, path)[0], [patch, path]);
  if (!file?.lines.length) return <div className="note">No changes to show.</div>;
  return <DiffLines file={file} {...(wrap === undefined ? {} : { wrap })} />;
}
