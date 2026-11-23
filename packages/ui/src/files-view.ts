// Where each session's Files tab is (CYCL-92): the folders opened in its tree, and the file shown, if one is. Kept while
// the window is open, not across a restart: the tree is read again from the daemon anyway. A file named in the
// conversation is shown by asking here, then showing the tab. Plain TypeScript, no React and no DOM.

export type FilesState = {
  /** Folders open in the tree, relative to the session's folder. */
  readonly expanded: ReadonlySet<string>;
  /** The file shown in place of the tree; undefined: the tree is shown. */
  readonly file: string | undefined;
};

const START: FilesState = { expanded: new Set(), file: undefined };

/** The folders a path is in, outermost first: `a/b/c` is in `a` and `a/b`. */
export const foldersOf = (path: string): string[] => {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, at) => parts.slice(0, at + 1).join("/"));
};

/**
 * A path the conversation gave (absolute, or a `file://` address) as one inside the session's folder, or undefined when
 * it is not in it: the Files tab shows that folder and nothing else.
 */
export const insideFolder = (where: string, cwd: string): string | undefined => {
  let path = where;
  if (path.startsWith("file://")) {
    try {
      path = decodeURIComponent(new URL(path).pathname);
    } catch {
      return undefined;
    }
  }
  // Without its trailing slashes: "/" is "", so that what is under it starts with "/".
  const root = cwd.replace(/\/+$/, "");
  if (!path.startsWith(`${root}/`)) return undefined;
  const inside = path.slice(root.length + 1).replace(/\/+$/, "");
  if (inside === "" || inside.split("/").some((s) => s === "" || s === "." || s === ".."))
    return undefined;
  return inside;
};

/**
 * Where a path an agent wrote is inside the session's folder: relative to the folder (a leading `./` is dropped),
 * absolute, or a `file:` URI under it. Anything else (one that climbs out, a Windows path, one with a backslash) is
 * nothing.
 */
export const agentPathInFolder = (file: string, cwd: string): string | undefined => {
  if (file.includes("\\") || /^[a-zA-Z]:/.test(file)) return undefined;
  if (file.startsWith("/") || file.startsWith("file://")) return insideFolder(file, cwd);
  return insideFolder(`${cwd.replace(/\/+$/, "")}/${file.replace(/^(\.\/)+/, "")}`, cwd);
};

/** A path as a list shows it: inside the session's folder, relative to it; elsewhere, as the agent gave it. */
export const shownPath = (path: string, cwd: string | undefined): string =>
  (cwd !== undefined ? insideFolder(path, cwd) : undefined) ?? path;

export class FilesViews {
  readonly #states = new Map<string, FilesState>();
  readonly #listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** A session's tab (`environmentId:sessionId`). The same object until it changes, so that it can be watched. */
  get = (key: string): FilesState => this.#states.get(key) ?? START;

  #put(key: string, state: FilesState): void {
    this.#states.set(key, state);
    for (const listener of [...this.#listeners]) listener();
  }

  /** Opens a folder of the tree, or closes it. */
  toggle(key: string, folder: string): void {
    const old = this.get(key);
    const expanded = new Set(old.expanded);
    if (!expanded.delete(folder)) expanded.add(folder);
    this.#put(key, { ...old, expanded });
  }

  /** Shows a file; the folders it is in are opened, so that going back finds it in the tree. */
  show(key: string, file: string): void {
    const old = this.get(key);
    const expanded = new Set([...old.expanded, ...foldersOf(file)]);
    this.#put(key, { expanded, file });
  }

  /** Shows a folder in the tree: it and the folders it is in are opened. */
  reveal(key: string, folder: string): void {
    const old = this.get(key);
    this.#put(key, {
      expanded: new Set([...old.expanded, ...foldersOf(folder), folder]),
      file: undefined,
    });
  }

  /** Back from a file to the tree. */
  back(key: string): void {
    const old = this.get(key);
    if (old.file !== undefined) this.#put(key, { ...old, file: undefined });
  }

  forget(key: string): void {
    if (this.#states.delete(key)) for (const listener of [...this.#listeners]) listener();
  }
}
