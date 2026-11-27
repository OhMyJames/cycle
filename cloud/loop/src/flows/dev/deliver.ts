import type { CriteriaBook } from "../../criteria.ts";
import { Blocked, tail } from "../../engine/flow.ts";
import { renderPr, renderPrTitle, validatePr } from "../../pr.ts";
import type { Issue } from "../../types.ts";
import { type DevRun, type FlowHost, netForge, type Save, where } from "./context.ts";

export async function deliver(
  h: FlowHost,
  run: DevRun,
  issue: Issue,
  book: CriteriaBook,
  save: Save,
): Promise<void> {
  const { config } = h.d;
  const worktree = h.need(run.worktree ?? undefined);
  const at = where(h, worktree);

  const pushed = await h.netExec(run.key, "git push", () =>
    h.d.workspace.push(at, run.remoteBranch),
  );
  if (pushed.code !== 0) throw new Blocked(`git push 失败：${tail(pushed.output)}`);

  const commits = await h.d.workspace.commitSubjects(at, config.baseRef);
  const summary = commits
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.includes("checkpoint (auto-loop)"))
    .map((line) => `- ${line}`)
    .join("\n");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const title = renderPrTitle(issue);
  const graph = await h.d.store.loadGraph(run.key);
  const body = renderPr({
    issue,
    criteria: book.items,
    checks: (await h.d.store.loadCi(run.key)).checks,
    rounds: run.round,
    summary,
    sessions: { dev: run.devSessionId, qa: run.qaSessionId },
    documents: run.dev.fullFlowDocs,
    docsBase: config.docsBase,
    ...(graph !== undefined ? { graph } : {}),
  });
  const prCheck = validatePr(issue.key, title, body);
  if (!prCheck.ok) throw new Blocked(prCheck.reason);
  const bodyPath = join(config.stateDir, "runs", run.key, "pr-body.md");
  await mkdir(join(config.stateDir, "runs", run.key), { recursive: true, mode: 0o700 });
  await writeFile(bodyPath, body, { mode: 0o600 });

  const { forge } = h.d;
  let prUrl: string | undefined;
  if (run.dev.prUrl !== null) {
    // Pushing a CI fix to the same branch: keep the existing pull request and refresh its description.
    const prUrlNow = run.dev.prUrl;
    const edited = await netForge(h, run.key, "gh pr edit", () =>
      forge.editPr(at, prUrlNow, { title, bodyPath }),
    );
    if (!edited.ok) throw new Blocked(`gh pr edit 失败：${tail(edited.error)}`);
    prUrl = run.dev.prUrl;
  } else {
    const created = await netForge(h, run.key, "gh pr create", () =>
      forge.createPr(at, {
        base: config.baseBranch,
        head: run.remoteBranch,
        title,
        bodyPath,
      }),
    );
    if (created.ok) {
      prUrl = created.url;
    } else {
      // The pull request may already be there (a delivery that was cut off after it was made).
      const existing = await netForge(h, run.key, "gh pr view", () =>
        forge.prFor(at, run.remoteBranch),
      );
      if (!existing.ok) throw new Blocked(`gh pr create 失败：${tail(created.error)}`);
      prUrl = existing.url;
      const edited = await netForge(h, run.key, "gh pr edit", () =>
        forge.editPr(at, run.remoteBranch, { title, bodyPath }),
      );
      if (!edited.ok) throw new Blocked(`gh pr edit 失败：${tail(edited.error)}`);
    }
  }
  await save({ phase: "ci", dev: { prUrl } });
}
