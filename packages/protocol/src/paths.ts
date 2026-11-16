/** A folder as a session's agent knows it, and as this machine does. */
export interface FolderIn {
  /** The path on this machine. */
  cwd: string;
  /** Where a sandbox sees that folder, when it sees it somewhere else. */
  sandboxCwd: string | null;
}

/**
 * Where a path an agent said points on this machine. A sandbox names the folder its own way, so
 * a file its tools touched is opened here at the same file, not at a path that is not here.
 */
export function toMachinePath(path: string, folder: FolderIn): string {
  const inside = folder.sandboxCwd;
  if (!inside || !folder.cwd) return path;
  if (path !== inside && !path.startsWith(`${inside}/`)) return path;
  return `${folder.cwd}${path.slice(inside.length)}`;
}
