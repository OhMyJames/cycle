// What the agents keep in their homes, and clearing their caches (docs/protocol.md §16 "本地存储").
import { storageClean, storageRead } from "@cycle/protocol";
import { cleanStorage, readStorage } from "../storage.ts";
import { type Core, cycleOn } from "./core.ts";

export const registerStorage = (app: Parameters<typeof cycleOn>[0], core: Core): void => {
  const cycle = cycleOn(app, core.log);
  cycle(storageRead, async () => ({ agents: await readStorage(core.agentHomes(), core.dataDir) }));
  cycle(storageClean, async (params) => {
    // A turn of that agent may be running a package install in its cache: take it out from under it and the install is corrupt.
    const busy = [...core.sessions.values()].some(
      (s) =>
        s.entry.agent === params.agent &&
        !s.closed &&
        (s.entry.turnOpen === true ||
          s.status() === "running" ||
          s.status() === "requires_action" ||
          s.pending.size > 0 ||
          s.backgroundCount() > 0),
    );
    if (busy)
      return {
        cleaned: false as const,
        problem: "busy" as const,
        message: "A session of this agent is working. Clean up when it has finished.",
      };
    return cleanStorage(core.agentHomes(), core.dataDir, params.agent);
  });
};
