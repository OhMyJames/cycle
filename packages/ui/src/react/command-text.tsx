import { type CSSProperties, useEffect, useState, useSyncExternalStore } from "react";
import { codeTheme, themesOf } from "../code-theme.ts";
import { pluginFor } from "./markdown.tsx";

type Token = { content: string; htmlStyle?: Record<string, string> | undefined; color?: string };

/**
 * A shell command coloured as bash by the same Shiki plugin and theme as the code blocks of a reply. Until the
 * highlighter is ready (it loads the grammar on first use) the command is its plain text; the words are the same either
 * way, so Copy and the text of the element do not depend on it.
 */
export function CommandText({ text }: { text: string }) {
  const id = useSyncExternalStore(codeTheme.subscribe, codeTheme.get, codeTheme.get);
  const [done, setDone] = useState<{ key: string; lines: Token[][] } | undefined>(undefined);
  const key = `${id}\0${text}`;
  useEffect(() => {
    let live = true;
    const plugin = pluginFor(id);
    const options = {
      code: text,
      language: "bash" as never,
      themes: [...themesOf(id)] as never,
    };
    const take = (result: { tokens: Token[][] }) => {
      if (live) setDone({ key, lines: result.tokens });
    };
    try {
      const now = plugin.highlight(options, take);
      if (now !== null) take(now);
    } catch {
      // Stays plain text.
    }
    return () => {
      live = false;
    };
  }, [id, text, key]);
  if (done === undefined || done.key !== key) return text;
  const joined = done.lines.map((line) => line.map((t) => t.content).join("")).join("\n");
  if (joined !== text) return text;
  let offset = 0;
  return done.lines.map((line, row) => {
    const start = offset;
    offset += line.reduce((n, t) => n + t.content.length, 0) + 1;
    let at = start;
    return (
      <span key={start} data-slot="tool-command-line">
        {line.map((token) => {
          const style = token.htmlStyle ?? (token.color ? { color: token.color } : {});
          const light = style.color ?? token.color;
          const dark = style["--shiki-dark"];
          const k = at;
          at += token.content.length;
          return light === undefined ? (
            token.content
          ) : (
            <span
              key={k}
              data-token=""
              style={{ "--tok-l": light, "--tok-d": dark ?? light } as CSSProperties}
            >
              {token.content}
            </span>
          );
        })}
        {row < done.lines.length - 1 ? "\n" : null}
      </span>
    );
  });
}
