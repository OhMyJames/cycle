import type { WorktreePort } from "@cycle/protocol";

/**
 * The port the Claude Code harness is given for the worktrees its agent enters. The harness is
 * built before the daemon, whose hub makes them, so the desk is given at once and served later, as
 * Cycle's tools are. Until then it refuses: Claude Code is never left to make its own.
 */
export class WorktreeDesk implements WorktreePort {
  private source: WorktreePort | null = null;

  /** The hub's part, once there is a hub. */
  serve(source: WorktreePort): void {
    this.source = source;
  }

  async enter(request: Parameters<WorktreePort["enter"]>[0]): Promise<{ path: string }> {
    if (!this.source) throw new Error("Cycle is not ready to make worktrees.");
    return this.source.enter(request);
  }

  async leave(request: Parameters<WorktreePort["leave"]>[0]): Promise<void> {
    // Nothing is removed on an agent's say: with no hub there is nothing to tell the owner of.
    await this.source?.leave(request);
  }
}
