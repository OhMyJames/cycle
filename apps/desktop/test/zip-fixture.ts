// Bundles on disk and the zip archives of them, for the tests of updating by the difference.
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { parseDirectory, parseEnd } from "../src/shared/zip.ts";

/** What a bundle holds: a file's text, a file with a mode, or a link. Folders follow from the paths. */
export type Spec = Record<string, string | { text: string; mode: number } | { link: string }>;

const encode = (text: string) => new TextEncoder().encode(text);

export const writeBundle = async (root: string, spec: Spec): Promise<void> => {
  for (const [path, what] of Object.entries(spec)) {
    const at = join(root, path);
    await mkdir(dirname(at), { recursive: true });
    if (typeof what === "object" && "link" in what) await symlink(what.link, at);
    else {
      const mode = typeof what === "string" ? 0o644 : what.mode;
      await writeFile(at, typeof what === "string" ? what : what.text, { mode });
      // The umask takes bits from the mode given to writeFile; the table must say what the spec says.
      await chmod(at, mode);
    }
  }
};

export type ZipOptions = {
  /** Paths to store as they are, not deflated. */
  stored?: string[];
  /** Local headers carry an extra field of this many bytes, which the directory's entries do not. */
  localExtra?: number;
  /** Replaces what the archive holds of a file (compressed bytes), to make one that does not match. */
  corrupt?: Record<string, Uint8Array>;
  /** What the directory says a file's size is, when that is not the truth. */
  claimedSize?: Record<string, number>;
};

/** An archive like ditto's: `Cycle.app/<path>` for each file, a local header and then the data. */
export const makeZip = (spec: Spec, options: ZipOptions = {}): Uint8Array => {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array) => {
    parts.push(bytes);
    offset += bytes.length;
  };
  for (const [path, what] of Object.entries(spec)) {
    if (typeof what === "object" && "link" in what) continue;
    const data = encode(typeof what === "string" ? what : what.text);
    const name = encode(`Cycle.app/${path}`);
    const method = options.stored?.includes(path) ? 0 : 8;
    const body = options.corrupt?.[path] ?? (method === 0 ? data : deflateRawSync(data));
    const extra = new Uint8Array(options.localExtra ?? 0);
    const crc = Bun.hash.crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, extra.length, true);
    const head = offset;
    push(new Uint8Array(local.buffer));
    push(name);
    push(extra);
    push(body);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(10, method, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, body.length, true);
    entry.setUint32(24, options.claimedSize?.[path] ?? data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, head, true);
    central.push(new Uint8Array(entry.buffer), name);
  }
  const directoryOffset = offset;
  for (const piece of central) push(piece);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, central.length / 2, true);
  end.setUint16(10, central.length / 2, true);
  end.setUint32(12, offset - directoryOffset, true);
  end.setUint32(16, directoryOffset, true);
  push(new Uint8Array(end.buffer));
  const out = new Uint8Array(offset);
  let at = 0;
  for (const piece of parts) {
    out.set(piece, at);
    at += piece.length;
  }
  return out;
};

/** Unpacks an archive made here into `into`, the way the updater's `extract` would (for the whole-archive path). */
export const unzip = async (zip: Uint8Array, into: string): Promise<void> => {
  const end = parseEnd(zip.subarray(Math.max(0, zip.length - 70000)));
  const entries = parseDirectory(
    zip.subarray(end.directoryOffset, end.directoryOffset + end.directorySize),
    end.entries,
  );
  for (const entry of entries.values()) {
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const start =
      entry.offset +
      30 +
      view.getUint16(entry.offset + 26, true) +
      view.getUint16(entry.offset + 28, true);
    const body = zip.subarray(start, start + entry.csize);
    const data = entry.method === 8 ? inflateRawSync(body) : body;
    const at = join(into, entry.name);
    await mkdir(dirname(at), { recursive: true });
    await writeFile(at, data);
  }
};
