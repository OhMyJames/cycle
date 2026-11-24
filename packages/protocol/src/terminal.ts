import { z } from "zod";
import { cycleMethod } from "./method.ts";

/**
 * A shell the person opens beside a session (docs/protocol.md §8 "终端"): its pseudo-terminal runs in the daemon,
 * in the session's folder, and reaches a client over this connection. Agents never see it.
 */
export const TERMINAL_LIMITS = {
  /** Bytes of one `input`. */
  input: 64 * 1024,
  cols: { min: 2, max: 1000 },
  rows: { min: 1, max: 500 },
} as const;

const TerminalId = z.string().min(1).max(200);
const Cols = z.number().int().min(TERMINAL_LIMITS.cols.min).max(TERMINAL_LIMITS.cols.max);
const Rows = z.number().int().min(TERMINAL_LIMITS.rows.min).max(TERMINAL_LIMITS.rows.max);

export const TerminalInfoSchema = z.object({
  terminalId: z.string(),
  sessionId: z.string(),
  /** The shell's name, until the shell sets a title of its own. */
  title: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
  status: z.enum(["running", "exited"]),
  /** Only once exited; null when a signal ended it. */
  exitCode: z.number().int().nullable().optional(),
});
export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;

export const TerminalAttachedSchema = z.object({
  terminal: TerminalInfoSchema,
  /** Escape sequences that redraw the screen, scrollback included. */
  screen: z.string(),
  /** The last piece of output `screen` already holds. */
  seq: z.number().int().nonnegative(),
});
export type TerminalAttached = z.infer<typeof TerminalAttachedSchema>;

const Done = z.object({});

export const terminalCreate = cycleMethod(
  "_cycle/terminal/create",
  z.object({
    sessionId: z.string(),
    cols: Cols,
    rows: Rows,
    /** Runs this action of the session's environment in it instead of a shell (capability `environments`). */
    actionId: z.string().optional(),
  }),
  TerminalAttachedSchema,
);

export const terminalList = cycleMethod(
  "_cycle/terminal/list",
  z.object({ sessionId: z.string() }),
  z.object({ terminals: z.array(TerminalInfoSchema) }),
);

export const terminalAttach = cycleMethod(
  "_cycle/terminal/attach",
  z.object({ terminalId: TerminalId }),
  TerminalAttachedSchema,
);

export const terminalDetach = cycleMethod(
  "_cycle/terminal/detach",
  z.object({ terminalId: TerminalId }),
  Done,
);

export const terminalInput = cycleMethod(
  "_cycle/terminal/input",
  // Counted in UTF-16 units here, and again in bytes by the daemon.
  z.object({ terminalId: TerminalId, data: z.string().max(TERMINAL_LIMITS.input) }),
  Done,
);

export const terminalResize = cycleMethod(
  "_cycle/terminal/resize",
  z.object({ terminalId: TerminalId, cols: Cols, rows: Rows }),
  Done,
);

export const terminalClose = cycleMethod(
  "_cycle/terminal/close",
  z.object({ terminalId: TerminalId }),
  Done,
);

/** Notifications the daemon sends about terminals. */
export const TERMINAL_NOTIFICATIONS = {
  /** `{terminalId, seq, data}`, to the connections attached to it. */
  output: "_cycle/terminal/output",
  /** `{terminalId, seq, screen, cols, rows}`, to an attached connection that fell behind. */
  reset: "_cycle/terminal/reset",
  /** `{sessionId, terminals}`, to every connection. */
  changed: "_cycle/terminal/changed",
} as const;

export const TerminalOutputSchema = z.object({
  terminalId: z.string(),
  seq: z.number().int().positive(),
  data: z.string(),
});
export type TerminalOutput = z.infer<typeof TerminalOutputSchema>;

export const TerminalResetSchema = z.object({
  terminalId: z.string(),
  seq: z.number().int().nonnegative(),
  screen: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
});
export type TerminalReset = z.infer<typeof TerminalResetSchema>;

export const TerminalChangedSchema = z.object({
  sessionId: z.string(),
  terminals: z.array(TerminalInfoSchema),
});
export type TerminalChanged = z.infer<typeof TerminalChangedSchema>;
