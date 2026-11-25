// Runs the real CLI with the real harness list, except `claude`'s executable is looked up on PATH so tests can stub it
// without spawning the SDK-bundled Claude binary.
import { runCli } from "../../src/cli.ts";
import { HARNESSES } from "../../src/harnesses.ts";

const harnesses = HARNESSES.map((h) =>
  h.id === "claude" && h.cli
    ? { ...h, cli: { ...h.cli, executable: () => Bun.which("claude") ?? undefined } }
    : h,
);

await runCli(Bun.argv.slice(2), harnesses);
