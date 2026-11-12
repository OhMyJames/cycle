export interface DiffLine {
  type: "add" | "del" | "context" | "hunk";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface FileDiff {
  path: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parses a unified diff of one or more files. A patch with no file header,
 * as an agent's edit gives, is one file named by `fallbackPath`.
 */
export function parseDiff(patch: string, fallbackPath = ""): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const start = (path: string): FileDiff => {
    const file: FileDiff = { path, additions: 0, deletions: 0, lines: [] };
    files.push(file);
    inHunk = false;
    return file;
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = / b\/(.+)$/.exec(line);
      current = start(match?.[1] ?? fallbackPath);
      continue;
    }
    if (!inHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      if (line.startsWith("+++ ") && current && line !== "+++ /dev/null") {
        current.path = line.slice(4).replace(/^b\//, "").trim() || current.path;
      }
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      current ??= start(fallbackPath);
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      current.lines.push({ type: "hunk", oldLine: null, newLine: null, text: line });
      continue;
    }
    if (!inHunk) {
      // Text before any hunk is a header, except in a bare list of +/- lines.
      if (current || !/^[+\- ]/.test(line)) continue;
      current = start(fallbackPath);
      inHunk = true;
      oldLine = 1;
      newLine = 1;
    }
    if (!current) continue;
    if (line.startsWith("+")) {
      current.additions++;
      current.lines.push({ type: "add", oldLine: null, newLine: newLine++, text: line.slice(1) });
    } else if (line.startsWith("-")) {
      current.deletions++;
      current.lines.push({ type: "del", oldLine: oldLine++, newLine: null, text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      current.lines.push({
        type: "context",
        oldLine: oldLine++,
        newLine: newLine++,
        text: line.slice(1),
      });
    }
  }
  return files;
}

export function diffStats(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of parseDiff(patch)) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions };
}
