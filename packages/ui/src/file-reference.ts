// A file a reply names, so that it can be opened in the Files tab: in inline code (`packages/ui/src/app.tsx:364`) or in a
// link (`[app](src/app.tsx#L12)`). Pure, so every rule is tested without a page. The rules are old-cycle's
// (`packages/ui/src/content/file-reference.ts`): inline code is full of things that look like paths and are not (
// `state.active`, `process.env`, a command, a glob, a package), so only what can only be a path counts.

/** A file named in a reply: where it is, inside the session's folder, and the line named with it, if any. */
export type FileReference = { path: string; line?: number };

/**
 * A bare name counts as a file only with one of these extensions, since inline code is full of `state.active` and
 * `process.env`. One with a folder in it needs only some extension.
 */
const NAME_EXTENSIONS = new Set(
  (
    "ts tsx mts cts js jsx mjs cjs json jsonc md mdx markdown txt css scss html vue svelte py rs go " +
    "swift java kt c h cpp rb sh zsh bash toml yaml yml lock lockb sql csv log xml plist"
  ).split(" "),
);

/** `path:12`, `path:12:3`, `path:12-20`, `path#L12` and `path#L12-L20`, as editors and agents write them. */
const LOCATION = /^(.+?)(?::(\d+)(?:[:-]\d+)?|#L(\d+)(?:-L?\d+)?)$/;

/** Characters a path in prose never has, but code, commands and globs do. */
const NOT_A_PATH = /[\s<>"'`|*?(){}[\]$;,=!^\\]/;

const located = (written: string): { path: string; line?: number } => {
  const match = LOCATION.exec(written);
  if (match?.[1] === undefined) return { path: written };
  const line = Number(match[2] ?? match[3]);
  return line >= 1 ? { path: match[1], line } : { path: match[1] };
};

/**
 * Where `path` is inside `root` (the session's folder), from `root` itself when it is relative: its parts, with `.` and
 * `..` worked out. Nothing for a path that leaves the folder or is the folder.
 */
const inside = (path: string, root: string): string | undefined => {
  const base = root.replace(/\/+$/, "");
  const full = path.startsWith("/") ? path : `${base}/${path}`;
  const parts: string[] = [];
  for (const part of full.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.pop() === undefined) return undefined;
    } else parts.push(part);
  }
  const normal = `/${parts.join("/")}`;
  return normal.startsWith(`${base}/`) ? normal.slice(base.length + 1) : undefined;
};

const found = (path: string, line: number | undefined, root: string): FileReference | undefined => {
  const at = inside(path, root);
  if (at === undefined) return undefined;
  return line === undefined ? { path: at } : { path: at, line };
};

/** The file a reply's inline code names, inside `root`. Anything that could as well be code, a command or a package stays text. */
export const codeReference = (text: string, root: string): FileReference | undefined => {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.includes("://") || NOT_A_PATH.test(trimmed)) return undefined;
  if (/^[~@-]/.test(trimmed)) return undefined;
  const { path, line } = located(trimmed);
  const name = path.split("/").at(-1) ?? "";
  if (!path.startsWith("/")) {
    const extension = /\.([A-Za-z][\w-]*)$/.exec(name)?.[1];
    if (extension === undefined) return undefined;
    if (!path.includes("/") && !NAME_EXTENSIONS.has(extension.toLowerCase())) return undefined;
  }
  return found(path, line, root);
};

/** The scheme a reply's relative link is given before Streamdown's link check, which drops any link it cannot resolve. */
export const FILE_LINK_SCHEME = "cycle-file:";

/**
 * Whether a link's address is a path rather than an address: no scheme (a name before `:12` is not one), not a fragment
 * alone. `file:` is a path too.
 */
export const isPathLink = (href: string): boolean =>
  href !== "" &&
  !href.startsWith("#") &&
  (/^file:\/\/\//i.test(href) || !/^[a-z][a-z\d+.-]*:(?!\d)/i.test(href));

/** The file a reply's link points at, inside `root`: `src/app.tsx`, `/abs/src/app.tsx#L12`, `file:///abs/app.tsx`. */
export const linkReference = (
  href: string | undefined,
  root: string,
): FileReference | undefined => {
  if (href === undefined) return undefined;
  const local = href.startsWith(FILE_LINK_SCHEME)
    ? href.slice(FILE_LINK_SCHEME.length)
    : href.replace(/^file:\/\/(?=\/)/i, "");
  if (!isPathLink(local)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURI(local);
  } catch {
    return undefined;
  }
  const [beforeQuery = ""] = decoded.split("?");
  const { path, line } = located(beforeQuery);
  const [bare = ""] = path.split("#");
  return bare === "" ? undefined : found(bare, line, root);
};
