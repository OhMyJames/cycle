// A session's files (docs/protocol.md §8 "文件"、"diff"): searching them, listing and reading them, and what git says
// has changed. Git runs only for a repository the person trusts (.agents/notes/2026-11-22-files-and-diff-sources.md).
import { isAbsolute } from "node:path";
import type { AgentApp } from "@agentclientprotocol/sdk/experimental/v2";
import { diffFile, diffStatus, filesSearch, foldersList, fsList, fsRead } from "@cycle/protocol";
import { workspaceFile, workspaceStatus } from "../diff.ts";
import { INVALID_PARAMS, RpcError } from "../errors.ts";
import { searchFiles } from "../files.ts";
import { listFolders } from "../folders.ts";
import { listFolder, readFile } from "../fs.ts";
import { ignoredNames } from "../git.ts";
import { type Core, cycleOn } from "./core.ts";

export const registerFiles = (app: AgentApp, core: Core): void => {
  const cycle = cycleOn(app, core.log);
  const trusted = (repository: string) => core.trust.of(repository).trusted === true;
  cycle(filesSearch, async (params) => {
    // A conversation with no session yet looks in the folder it has chosen: the same search, the same bounds.
    let cwd: string;
    if (params.cwd !== undefined) {
      if (!isAbsolute(params.cwd) || params.cwd.includes("\0"))
        throw new RpcError(INVALID_PARAMS, "cwd must be an absolute path", { cwd: params.cwd });
      cwd = params.cwd;
    } else {
      cwd = (await core.session(params.sessionId as string)).entry.cwd;
    }
    const found = await searchFiles(cwd, params.query, params.limit);
    return { root: cwd, ...found };
  });
  cycle(foldersList, (params) => listFolders(params.path, params.hidden === true));
  cycle(fsList, (params) =>
    // Git says what it ignores only for a repository the person trusts, since it reads that repository's
    // configuration.
    listFolder(core.cwdOf(params.sessionId), params.path, (dir, names) =>
      ignoredNames(dir, names, trusted),
    ),
  );
  cycle(fsRead, (params) => readFile(core.cwdOf(params.sessionId), params.path, params.offset));
  cycle(diffStatus, (params) => workspaceStatus(core.cwdOf(params.sessionId), trusted));
  cycle(diffFile, (params) => workspaceFile(core.cwdOf(params.sessionId), params.path, trusted));
};
