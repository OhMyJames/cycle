import { parseArgs } from "node:util";

/** Cycle's own options: the one table both the scan for the command and the parse are read from. */
const OPTIONS = {
  "data-dir": { type: "string" },
  socket: { type: "string" },
  help: { type: "boolean" },
  /** `logs`: how many lines from the end. */
  lines: { type: "string" },
  /** `stop`: stop even when sessions are working, interrupting them. */
  force: { type: "boolean" },
  /** `stop`: wait until no session is working, then stop. */
  wait: { type: "boolean" },
  /** `update`: the release to install, instead of the one the desktop app last said it is. */
  version: { type: "string" },
  /** `update`: switch to the new version now, without waiting for sessions to finish. */
  now: { type: "boolean" },
} as const;
const WITH_VALUE = Object.entries(OPTIONS)
  .filter(([, option]) => option.type === "string")
  .map(([name]) => `--${name}`);

/**
 * Cycle's options, and what follows the command. For the commands in `forwarding` (`login`, and each agent's own name:
 * they run the agent's binary, which has options of its own), everything after the command word is the agent's, as it
 * was typed (`--version`, `-p`, `--`, a value that looks like an option): Cycle's options are read only before it.
 */
export const parseCli = (argv: string[], forwarding: readonly string[]) => {
  let own = argv;
  let forwarded: string[] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (WITH_VALUE.includes(arg)) i++;
    else if (!arg.startsWith("-")) {
      if (forwarding.includes(arg)) {
        own = argv.slice(0, i + 1);
        forwarded = argv.slice(i + 1);
      }
      break;
    }
  }
  const { values, positionals } = parseArgs({
    args: own,
    options: OPTIONS,
    allowPositionals: true,
  });
  return { values, positionals, forwarded };
};
