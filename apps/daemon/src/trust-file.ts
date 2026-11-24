import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { Trust } from "@cycle/protocol";
import { z } from "zod";
import { INVALID_PARAMS, RESOURCE_NOT_FOUND, RpcError } from "./errors.ts";
import { JsonFile, readJsonFile } from "./json-file.ts";

const TrustFileSchema = z.object({
  version: z.literal(1),
  folders: z.record(z.string(), z.boolean()),
});

/** The trust file is there but cannot be read. It is not replaced. */
export class TrustUnreadableError extends Error {
  constructor(path: string, detail: string) {
    super(
      `The folder trust at ${path} cannot be read (${detail}). Fix or move it; it is not replaced.`,
    );
    this.name = "TrustUnreadableError";
  }
}

/** Whether `path` is `folder` or inside it. Both are real, absolute paths. */
export const within = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(folder === "/" ? "/" : `${folder}/`);

/**
 * The real path of a folder a client names: absolute, there, and a folder. Errors as
 * docs/protocol.md §8 "信任文件夹" says.
 */
export const realFolder = async (path: string): Promise<string> => {
  if (path.includes("\0")) throw new RpcError(INVALID_PARAMS, "The path is not valid", {});
  if (!isAbsolute(path)) throw new RpcError(INVALID_PARAMS, "The path must be absolute", { path });
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new RpcError(RESOURCE_NOT_FOUND, "No such folder", { path });
    // A path through a file (/etc/hosts/x) leads to no folder; anything else cannot be looked at (as folders/list says).
    if (code === "ENOTDIR")
      throw new RpcError(INVALID_PARAMS, "That is not a folder", { path, reason: "not_a_folder" });
    throw new RpcError(INVALID_PARAMS, "The folder cannot be read", { path, reason: "unreadable" });
  }
  const isFolder = await stat(real).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isFolder)
    throw new RpcError(INVALID_PARAMS, "That is not a folder", { path, reason: "not_a_folder" });
  return real;
};

const decision = (folders: ReadonlyMap<string, boolean>, real: string): Trust => {
  for (let at = real; ; at = dirname(at)) {
    const trusted = folders.get(at);
    if (trusted !== undefined) return { path: real, trusted, from: at };
    if (dirname(at) === at) return { path: real, trusted: null, from: null };
  }
};

/**
 * Which folders may run the commands their own configuration names (docs/protocol.md §8
 * "信任文件夹"): real path to true or false; a folder with no entry has no decision. A decision
 * covers the folders under it; the nearest one wins. Written whole, to a temporary file and then
 * renamed, and private to the account, like the session index (json-file.ts).
 */
export class FolderTrust {
  readonly #file: JsonFile<ReadonlyMap<string, boolean>>;

  private constructor(path: string, folders: Map<string, boolean>) {
    this.#file = new JsonFile<ReadonlyMap<string, boolean>>(path, folders, (value) => ({
      version: 1,
      folders: Object.fromEntries(value),
    }));
  }

  static async load(path: string): Promise<FolderTrust> {
    const parsed = await readJsonFile(
      path,
      TrustFileSchema,
      (detail) => new TrustUnreadableError(path, detail),
    );
    return new FolderTrust(path, new Map(Object.entries(parsed?.folders ?? {})));
  }

  /** The decision for a real path: its own, else the nearest folder above it with one. */
  of(real: string): Trust {
    return decision(this.#file.value, real);
  }

  /** Answered with the decision as this change left it, before any made after it. */
  set(real: string, trusted: boolean): Promise<Trust> {
    return this.#file.change((current) => {
      const folders = new Map(current).set(real, trusted);
      return { value: folders, answer: decision(folders, real) };
    });
  }
}
