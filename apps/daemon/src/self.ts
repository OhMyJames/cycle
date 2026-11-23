import { dirname, join } from "node:path";

const MAIN = new URL("./main.ts", import.meta.url).pathname;

/** True in the single-file executable `bun build --compile` makes: its code is inside it. */
export const compiled = (): boolean => Bun.main.startsWith("/$bunfs");

/** The command that runs this program again: the executable itself, or this same Bun running main.ts from source (by path, not by name: an ssh session has no PATH to find `bun` on). */
export const selfCommand = (): string[] => [process.execPath, ...(compiled() ? [] : [MAIN])];

/**
 * An agent's own binary, by the name it is shipped under. In the executable it is beside it (scripts/build.ts puts it
 * there: a compiled program cannot find a package's platform binary). From source there is none: the harness finds
 * its own.
 */
export const shippedExecutable = (name: string): string | undefined =>
  compiled() ? join(dirname(process.execPath), name) : undefined;
