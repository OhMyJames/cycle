// A file a reply names, so that it can be opened in the Files tab: in inline code (`packages/ui/src/app.tsx:364`) or in a
// link (`[app](src/app.tsx#L12)`). Pure, so every rule is tested without a page. The rules are old-cycle's
// (`packages/ui/src/content/file-reference.ts`): inline code is full of things that look like paths and are not (
// `state.active`, `process.env`, a command, a glob, a package), so only what can only be a path counts.

import { insideFolder } from "./files-view.ts";

/**
 * A file named in a reply: where it is, inside the session's folder, and the line named with it, if any, with the last
 * line of a range (`a.ts:12-20`, `a.ts#L12-L20`) when one is named past it. A link that ends in `/` names a folder.
 */
export type FileReference = { path: string; line?: number; end?: number; folder?: true };

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

/**
 * `path:12`, `path:12:3`, `path:12-20`, `path#L12` and `path#L12-L20`, as editors and agents write them. After `:12`, a
 * `:3` is a column, not a line, and a range only ends with `-20`.
 */
const LOCATION = /^(.+?)(?::(\d+)(?::\d+|-(\d+))?|#L(\d+)(?:-L?(\d+))?)$/;

/** Characters a path in prose never has, but code, commands and globs do. */
const NOT_A_PATH = /[\s<>"'`|*?(){}[\]$;,=!^\\]/;

type Located = { path: string; line?: number; end?: number };

const located = (written: string): Located => {
  const match = LOCATION.exec(written);
  if (match?.[1] === undefined) return { path: written };
  const line = Number(match[2] ?? match[4]);
  if (!(line >= 1)) return { path: match[1] };
  // A range that ends where it starts, or before, is the one line.
  const end = Number(match[3] ?? match[5]);
  return end > line ? { path: match[1], line, end } : { path: match[1], line };
};

/**
 * Where `path` is inside `root` (the session's folder), from `root` itself when it is relative: `.` and `..` worked out,
 * then the same rule as every other way into Files (`insideFolder`). Nothing for a path that leaves the folder or is it.
 */
const inside = (path: string, root: string): string | undefined => {
  const full = path.startsWith("/") ? path : `${root.replace(/\/+$/, "")}/${path}`;
  const parts: string[] = [];
  for (const part of full.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.pop() === undefined) return undefined;
    } else parts.push(part);
  }
  return insideFolder(`/${parts.join("/")}`, root);
};

const found = (
  { path, line, end }: Located,
  root: string,
  folder = false,
): FileReference | undefined => {
  const at = inside(path, root);
  if (at === undefined) return undefined;
  if (folder) return { path: at, folder: true };
  if (line === undefined) return { path: at };
  return end === undefined ? { path: at, line } : { path: at, line, end };
};

/** `github.com/user/repo.git`, `example.com/index.html`: an address without its scheme, not a folder of the session. */
const DOMAIN =
  /^[a-z\d-]+(?:\.[a-z\d-]+)*\.(?:com|org|net|io|dev|app|ai|co|edu|gov|sh|so|xyz|me|us|uk|cn|de)\//i;

/** The file a reply's inline code names, inside `root`. Anything that could as well be code, a command or a package stays text. */
export const codeReference = (text: string, root: string): FileReference | undefined => {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed.includes("://") || NOT_A_PATH.test(trimmed)) return undefined;
  if (/^[~@-]/.test(trimmed)) return undefined;
  const where = located(trimmed);
  const { path } = where;
  if (DOMAIN.test(path)) return undefined;
  const name = path.split("/").at(-1) ?? "";
  // Without an extension, even a whole path could as well be a folder: only a file is opened from inline code.
  const extension = /\.([A-Za-z][\w-]*)$/.exec(name)?.[1];
  if (extension === undefined) return undefined;
  if (!path.includes("/") && !NAME_EXTENSIONS.has(extension.toLowerCase())) return undefined;
  return found(where, root);
};

/**
 * The scheme a reply's link to a path is given before Streamdown's link check, which drops any link it cannot resolve.
 * A `file:` link or one like `app.tsx:12` is made a plain path before that (`pathLinkUrl`), since an earlier step drops
 * any scheme it does not know, and would read `app.tsx` as one.
 */
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
  const local = (
    href.startsWith(FILE_LINK_SCHEME) ? href.slice(FILE_LINK_SCHEME.length) : href
  ).replace(/^file:\/\/(?=\/)/i, "");
  if (!isPathLink(local)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURI(local);
  } catch {
    return undefined;
  }
  const [beforeQuery = ""] = decoded.split("?");
  const where = located(beforeQuery);
  const [bare = ""] = where.path.split("#");
  return bare === "" ? undefined : found({ ...where, path: bare }, root, bare.endsWith("/"));
};

/**
 * A link's address as the markdown is read, before any check: a path to a file (`file:///abs/a.ts`, `a.ts:12`) is made
 * one the checks keep (`/abs/a.ts`, `./a.ts:12`); anything else is as it was.
 */
export const pathLinkUrl = (url: string): string => {
  if (/^file:\/\/\//i.test(url)) return url.slice("file://".length);
  if (/^[^/:#?]+:\d/.test(url) && isPathLink(url)) return `./${url}`;
  return url;
};
