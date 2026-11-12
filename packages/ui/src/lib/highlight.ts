import hljs from "highlight.js/lib/common";

const MAX_HIGHLIGHT = 60_000;
const cache = new Map<string, string>();
const CACHE_LIMIT = 300;

const BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  sh: "bash",
  zsh: "bash",
  bash: "bash",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  json: "json",
  html: "xml",
  xml: "xml",
  svg: "xml",
  css: "css",
  scss: "scss",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  php: "php",
  sql: "sql",
  toml: "ini",
  ini: "ini",
  diff: "diff",
  lua: "lua",
};

export function languageOf(path: string): string | null {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return BY_EXTENSION[extension] ?? null;
}

function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Highlighted HTML for code, escaped so it is safe to set as HTML. Results
 * are kept, so a block drawn again after a scroll costs nothing.
 */
export function highlight(code: string, language: string | null): string {
  const name = language && hljs.getLanguage(language) ? language : null;
  if (!name || code.length > MAX_HIGHLIGHT) return escapeHtml(code);
  const key = `${name}\0${code}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  let html: string;
  try {
    html = hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch {
    html = escapeHtml(code);
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value ?? "");
  cache.set(key, html);
  return html;
}
