import type { LoopProject } from "@cycle/protocol";
import type { Config } from "./config.ts";

/** `owner/name` from a repository address (https, ssh or scp form): no host, scheme or credentials. */
export const repoDisplayName = (url: string): string => {
  const path = url
    .replace(/^[a-z+]+:\/\/(?:[^/@]*@)?[^/]+\//i, "")
    .replace(/^[^@/]*@[^:]+:/, "")
    .replace(/\.git$/, "")
    .replace(/^\/+|\/+$/g, "");
  // Only an `owner/name` is shown; anything else (no path, an address that is not one) is not echoed.
  return /^[\w.-]+(?:\/[\w.-]+)+$/.test(path) ? path : "repository";
};

/** What a client may see of each Project. Built field by field: a new config field is not exposed by accident. */
export const projectsList = (config: Config): { projects: LoopProject[] } => ({
  projects: config.projects.map((p) => ({
    name: p.name,
    projectKey: p.projectKey,
    repo: { displayName: repoDisplayName(p.repo.url), forge: p.repo.forge },
  })),
});
