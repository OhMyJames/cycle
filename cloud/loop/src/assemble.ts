// Everything one Project owns: tracker, store, lock, daemon connection, pipeline. Shared by the CLI and the server.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ProjectApi, sessionOfId } from "./api.ts";
import { type ConfigFile, readTuning } from "./config-file.ts";
import { type ImportResult, importLegacyState, needsImport } from "./db/import.ts";
import { openLoopStore, SqliteStore } from "./db/store.ts";
import { deadlineFor, recordHeartbeat, WORKER_BEAT_KEY } from "./engine/heartbeat.ts";
import { effectiveWorkers } from "./loop.ts";
import { Pipeline } from "./pipeline.ts";
import { DEFAULT_TIMEOUT_MS, PlanTracker } from "./plan-mcp.ts";
import {
  type DeliveryConfig,
  gitWorkspace,
  initDeliveryRepo,
  inspectRepoGitConfig,
  originUrlFromGitConfig,
  repoGitConfigPath,
} from "./ports/git.ts";
import { githubForge } from "./ports/github.ts";
import { DaemonSessions } from "./ports/sessions.ts";
import { docsBaseOf } from "./pr.ts";
import { type LoopFields, resolveLoopFields, resolveProject } from "./project.ts";
import { repoDisplayName } from "./projects.ts";
import { runCommand } from "./runner.ts";
import type { SecretKind } from "./secrets.ts";
import { acquireLock } from "./store.ts";
import { DEFAULT_CHECK_MINUTES, DEFAULT_MAX_ASK, defaultConfig } from "./types.ts";

export type SetUpOptions = {
  dataDir: string;
  configPath: string;
  once: boolean;
  dryRun: boolean;
  workersFlag: number | undefined;
  stopped: () => boolean;
  log: (line: string) => void;
};

export type ProjectUnit = {
  name: string;
  pipeline: Pick<Pipeline, "step" | "intervalSeconds">;
  release: () => Promise<void>;
  close: () => Promise<void>;
  workers: number;
  /** Emits a liveness heartbeat so the supervisor knows the Work loop is responsive even during long turns (CYC-484). */
  beat?: () => void;
  /** What the `loop/` methods use of this Project (CYC-482). */
  api?: ProjectApi;
};

export const setUpProject = async (file: ConfigFile, o: SetUpOptions): Promise<ProjectUnit> => {
  const { dataDir, configPath, once, dryRun, workersFlag } = o;
  const clock = { now: () => new Date() };
  const { stateDir } = file;
  const name = file.projectKey;
  const plog = (line: string) => o.log(`[${name}] ${line}`);
  const tracker = new PlanTracker({
    url: file.planUrl,
    key: file.planKey,
    projectKey: file.projectKey,
    ...(file.tuning?.trackerTimeoutSeconds !== undefined
      ? { timeoutMs: file.tuning.trackerTimeoutSeconds * 1000 }
      : {}),
  });
  // Research (CYC-447) is resolved only when it is on; the folder is a document, which `get_project` does not list.
  const research = file.research?.enabled === true ? file.research : null;
  // The planning node (CYC-322), likewise only when it is on.
  const planning = file.planning?.enabled === true ? file.planning : null;
  const {
    research: found,
    planning: planned,
    ...setup
  } = resolveProject(
    await tracker.getProject(),
    file,
    research === null
      ? undefined
      : {
          type: research.type,
          folder: research.folder,
          documents: await tracker.listDocuments(),
        },
    planning ?? undefined,
  );
  tracker.setColumns(setup.columns);
  if (planned !== null) tracker.setBacklogColumn(planned.backlogColumn);
  // The phase fields only mirror the run: if they cannot be used, say why once and do not write them.
  let loopFields: LoopFields | null = null;
  try {
    const resolved = resolveLoopFields(await tracker.getCustomFields());
    if ("fields" in resolved) loopFields = resolved.fields;
    else plog(`warning: the phase fields are off: ${resolved.problem}`);
  } catch (error) {
    plog(
      `warning: the phase fields are off: list_custom_fields failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  tracker.setLoopFields(loopFields);
  const config = {
    ...defaultConfig({ repoRoot: file.repoRoot, stateDir, ...setup }),
    docsBase: docsBaseOf(file.planUrl, file.projectKey),
    ...(file.devAgent !== undefined ? { devAgent: file.devAgent } : {}),
    ...(file.qaAgent !== undefined ? { qaAgent: file.qaAgent } : {}),
    ...(file.reviewAgent !== undefined ? { reviewAgent: file.reviewAgent } : {}),
    ...(file.devModel !== undefined ? { devModel: file.devModel } : {}),
    ...(file.qaModel !== undefined ? { qaModel: file.qaModel } : {}),
    ...(file.reviewModel !== undefined ? { reviewModel: file.reviewModel } : {}),
    ...(file.devEffort !== undefined ? { devEffort: file.devEffort } : {}),
    ...(file.qaEffort !== undefined ? { qaEffort: file.qaEffort } : {}),
    ...(file.reviewEffort !== undefined ? { reviewEffort: file.reviewEffort } : {}),
    research:
      research === null || found === null
        ? null
        : { ...found, readRoots: research.readRoots, maxFollowups: research.maxFollowups },
    planning:
      planning === null || planned === null
        ? null
        : {
            ...planned,
            maxPending: planning.maxPending,
            intervalMinutes: planning.intervalMinutes,
            maxSplit: planning.maxSplit,
            checkMinutes: planning.checkMinutes ?? DEFAULT_CHECK_MINUTES,
            maxAsk: planning.maxAsk ?? DEFAULT_MAX_ASK,
          },
    prReview:
      file.prReview?.enabled === true ? { maxReviewsPerPr: file.prReview.maxReviewsPerPr } : null,
    dryRun,
  };
  const tuning = {
    initial: file.tuning ?? {},
    reload: async () => {
      const next = await readTuning(configPath, file.projectKey);
      tracker.setTimeoutMs(
        next.trackerTimeoutSeconds !== undefined
          ? next.trackerTimeoutSeconds * 1000
          : DEFAULT_TIMEOUT_MS,
      );
      return next;
    },
  };
  // The lock first: with it held no step is working on a run, so the files can be moved into loop.db (CYC-476).
  const release = dryRun ? async () => {} : await acquireLock(stateDir);
  let imported: ImportResult | null = null;
  try {
    if (!dryRun && needsImport(stateDir)) {
      imported = await importLegacyState(stateDir, clock.now);
      plog(
        `imported ${imported.runs} runs, ${imported.events} events and ${imported.plans} planning rounds into loop.db; stats are the same; the old files are kept as ${imported.kept.join(", ")}`,
      );
    }
  } catch (error) {
    await release();
    throw error;
  }
  // The loop writes intents, which only loop.db holds: a real run creates it when there is nothing to import.
  const store = openLoopStore(stateDir, clock.now, dryRun);
  if (imported !== null) {
    await store.event("storage", "storage_imported", {
      runs: imported.runs,
      events: imported.events,
      plans: imported.plans,
    });
  }
  // A session waits for a person: the run's event, a `person` heartbeat (never stuck), and a Notice naming the session.
  const waiting = async (sessionId: string, title: string): Promise<void> => {
    const runs = await store.unfinished();
    const run = runs.find((r) => sessionOfId(r, sessionId) !== undefined);
    if (run !== undefined) {
      recordHeartbeat(store, run.key, {
        phase: run.phase,
        waitingOn: "person",
        deadline: null,
      });
      await store.event(run.key, "permission_pending");
      const session = sessionOfId(run, sessionId);
      if (store instanceof SqliteStore && session !== undefined)
        store.notice(
          run.key,
          "permission",
          title === "" ? `${session.kind} session is waiting for a person` : title,
          `permission:${sessionId}:${clock.now().toISOString()}`,
          session,
        );
      return;
    }
    const round = (await store.unfinishedPlans()).find((r) => r.triageSessionId === sessionId);
    if (round !== undefined && store instanceof SqliteStore)
      store.notice(
        `plan-${round.id}`,
        "permission",
        title === "" ? "triage session is waiting for a person" : title,
        `permission:${sessionId}:${clock.now().toISOString()}`,
        { kind: "triage", id: sessionId },
      );
  };
  const answered = async (sessionId: string): Promise<void> => {
    const runs = await store.unfinished();
    const run = runs.find((r) => sessionOfId(r, sessionId) !== undefined);
    if (run !== undefined && run.phase !== "blocked" && run.phase !== "done") {
      recordHeartbeat(store, run.key, {
        phase: run.phase,
        waitingOn: "session",
        deadline: deadlineFor("session", clock.now(), config),
      });
    }
  };
  const sessions = new DaemonSessions(
    process.env.CYCLE_SOCKET ?? join(dataDir, "daemon.sock"),
    (sessionId, title) => {
      plog(`waiting for a person in session ${sessionId}: ${title}`);
      void waiting(sessionId, title);
    },
    (run, kind, data) => store.event(run, kind, data),
    (sessionId) => {
      void answered(sessionId);
    },
    file.projectKey,
  );
  // CYC-478: verify shared repo `.git/config` is clean at startup, initialize `<stateDir>/delivery.git`, and redact
  // any credential-shaped text leaving via GitHub or tracker comments.
  const onRedact = (kinds: SecretKind[], runKey = "outbound") => {
    void store.event(runKey, "secrets_redacted", { kinds: kinds.join(",") });
  };
  tracker.setOnRedact((kinds, issueKey) => onRedact(kinds, issueKey));

  let delivery: DeliveryConfig | undefined;
  let effectiveRepoUrl = file.repo?.url;
  try {
    if (!dryRun) {
      const cfgPath = repoGitConfigPath(config.repoRoot);
      if (cfgPath !== undefined) {
        const cfgText = readFileSync(cfgPath, "utf8");
        const inspected = inspectRepoGitConfig(cfgText);
        if (!inspected.ok) {
          throw new Error(`refusing to start: ${config.repoRoot} ${inspected.reason}`);
        }
        effectiveRepoUrl ??= originUrlFromGitConfig(cfgText);
        if (effectiveRepoUrl !== undefined) {
          const deliveryRepo = await initDeliveryRepo(
            stateDir,
            effectiveRepoUrl,
            runCommand,
            process.env,
          );
          delivery = {
            repo: deliveryRepo,
            repoConfigHash: inspected.hash,
            onTamper: (reason) => {
              plog(`security notice: ${reason}`);
              if (store instanceof SqliteStore) {
                store.notice(
                  file.projectKey,
                  "supervisor",
                  reason,
                  `git-tamper:${file.projectKey}:${clock.now().toISOString()}`,
                );
              }
            },
          };
        }
      }
      await sessions.start();
    }
  } catch (error) {
    await sessions.close().catch(() => {});
    await release();
    throw error;
  }
  const repoSlug = effectiveRepoUrl !== undefined ? repoDisplayName(effectiveRepoUrl) : undefined;
  const pipeline = new Pipeline({
    config: {
      ...config,
      repoSlug: repoSlug !== undefined && repoSlug !== "repository" ? repoSlug : null,
    },
    tracker,
    sessions,
    exec: runCommand,
    forge: githubForge({
      exec: runCommand,
      env: process.env,
      ...(repoSlug !== undefined && repoSlug !== "repository" ? { repo: repoSlug } : {}),
      ...(!dryRun ? { stateDir } : {}),
      onRedact: (kinds) => onRedact(kinds, "forge"),
    }),
    workspace: gitWorkspace({
      exec: runCommand,
      env: process.env,
      repoRoot: config.repoRoot,
      remote: config.remote,
      stateDir: config.stateDir,
      ...(delivery !== undefined ? { delivery } : {}),
    }),
    store,
    clock,
    log: plog,
    env: process.env,
    stopped: o.stopped,
    tuning,
  });
  const close = async () => {
    await release();
    if (!dryRun) await sessions.close();
  };
  const workers = effectiveWorkers({ once, dryRun, flag: workersFlag, file: file.workers });
  if (workers > 4)
    plog(`warning: ${workers} workers; each one holds a session and a worktree, watch memory`);
  const api: ProjectApi = {
    projectKey: file.projectKey,
    tracker,
    store,
    labels: {
      auto: file.autoLabel,
      pending: file.planning?.pending ?? "待批准",
      skip: file.planning?.skip ?? "Loop 跳过",
    },
    workers,
    cancelRun: (key) => pipeline.cancelRun(key),
  };
  const beat = () =>
    recordHeartbeat(store, WORKER_BEAT_KEY, {
      phase: "alive",
      waitingOn: "idle",
      deadline: null,
    });
  return { name, pipeline, release, close, workers, beat, api };
};
