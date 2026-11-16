import type { FileContent, Machine } from "@cycle/protocol";

const MAX_TEXT = 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_MATCHES = 60;

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
};

/** A path with `.` and `..` resolved, so it can be compared with a folder. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

export function isInside(path: string, folder: string): boolean {
  const child = normalizePath(path);
  const parent = normalizePath(folder);
  return child === parent || child.startsWith(parent === "/" ? "/" : `${parent}/`);
}

function looksBinary(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 8192);
  for (let index = 0; index < end; index++) if (bytes[index] === 0) return true;
  return false;
}

export function describeFile(path: string, bytes: Uint8Array): FileContent {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  const mime = IMAGE_TYPES[extension];
  const image =
    mime && bytes.length <= MAX_IMAGE
      ? { mime, data: Buffer.from(bytes).toString("base64") }
      : null;
  const binary = looksBinary(bytes);
  if (binary) return { size: bytes.length, binary: true, text: "", truncated: false, image };
  const truncated = bytes.length > MAX_TEXT;
  const text = new TextDecoder().decode(truncated ? bytes.subarray(0, MAX_TEXT) : bytes);
  return { size: bytes.length, binary: false, text, truncated, image };
}

/** Reads the agent's machine for the page, through the harness. */
export class Files {
  private readonly harness: Machine;
  /** The folders a file may be read under. */
  private readonly allowed: () => string[];

  constructor(harness: Machine, allowed: () => string[]) {
    this.harness = harness;
    this.allowed = allowed;
  }

  async list(path: string): Promise<{ name: string; directory: boolean }[]> {
    const entries = await this.harness.readDirectory(normalizePath(path));
    return entries.toSorted(
      (a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
    );
  }

  async read(path: string): Promise<FileContent> {
    const target = normalizePath(path);
    if (!this.allowed().some((folder) => isInside(target, folder))) {
      throw new Error("Files are read only inside a folder a session runs in.");
    }
    return describeFile(target, await this.harness.readFile(target));
  }

  async search(root: string, query: string): Promise<{ path: string; directory: boolean }[]> {
    if (!query.trim()) return [];
    const matches = await this.harness.searchFiles(normalizePath(root), query);
    return matches.filter((match) => !/(^|\/)\.git(\/|$)/.test(match.path)).slice(0, MAX_MATCHES);
  }
}
