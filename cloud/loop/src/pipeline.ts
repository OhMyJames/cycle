// Where the engine and the flows are put together (CYC-479): the engine (engine/) with the dev flow and the research
// flow, the planning node, and the real `gh` and `git` where a caller brings no ports of its own. The engine itself
// imports none of them.

import { Engine } from "./engine/engine.ts";
import type { Deps } from "./engine/flow.ts";
import { devFlow } from "./flows/dev/index.ts";
import { PlanFlow } from "./flows/plan.ts";
import { ResearchFlow } from "./flows/research/index.ts";
import { todoIntake } from "./flows/ticket.ts";
import { gitWorkspace } from "./ports/git.ts";
import { githubForge } from "./ports/github.ts";

export type { Deps, StepResult } from "./engine/flow.ts";

/** What a caller gives: the ports are made from `exec` and `env` when it does not bring its own. */
export type DepsInput = Omit<Deps, "forge" | "workspace"> &
  Partial<Pick<Deps, "forge" | "workspace">>;

export class Pipeline extends Engine {
  constructor(input: DepsInput) {
    super(
      {
        ...input,
        forge: input.forge ?? githubForge({ exec: input.exec, env: input.env }),
        workspace:
          input.workspace ??
          gitWorkspace({
            exec: input.exec,
            env: input.env,
            repoRoot: input.config.repoRoot,
            remote: input.config.remote,
            stateDir: input.config.stateDir,
          }),
      },
      (host) => ({
        flows: { dev: devFlow(host), research: new ResearchFlow(host) },
        todo: todoIntake(host),
        plan: new PlanFlow(host),
      }),
    );
  }
}
