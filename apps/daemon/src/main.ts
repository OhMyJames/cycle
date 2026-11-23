#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runAdapter } from "@cycle/harness-claude/run";
import { parseCli } from "./args.ts";
import { claudeEnv } from "./claude-agent.ts";
import { defaultDataDir, loadConfig, pathsFor } from "./config.ts";
import { tailLines } from "./logger.ts";
import { proxy } from "./proxy.ts";
import { claudeExecutable } from "./self.ts";
import { onSignalsAndCrashes, serve } from "./serve.ts";
import { askWorking, stopDaemon } from "./stop.ts";
import { AlreadyRunningError, isListening, NotASocketError } from "./transport/server.ts";
import { VERSION } from "./version.ts";

const USAGE = `cycle <command> [options]

  serve   Run the daemon in the foreground.
  proxy   Join stdin and stdout to the daemon's socket, starting the daemon if needed.
          This is what a client runs over ssh.
  version Print this build's version ("dev" when run from source).
  status  Say whether the daemon is running (exit 0) or not (exit 1), and where its log is.
  logs    Print the end of the daemon's log (what it did and what went wrong; never
          prompts, agent output or credentials). --lines <n>: how many, default 100.
  stop    Stop the daemon if it is running. If sessions are working (a turn, a request
          waiting for an answer, background tasks) they are listed, and it asks whether
          to wait for them or stop now; without a terminal it does not stop (exit 4).
          --wait    wait until nothing is working, then stop
          --force   stop now: running turns end as interrupted, queued messages are kept
  login   Sign in to Claude for this daemon: "claude auth login" with the environment and
          config directory the daemon gives Claude. Run it on the machine the daemon is on.
  claude <args>   Run the Claude binary with that same environment (e.g. claude auth status).
          Everything after login or claude goes to Claude as typed, --help included.
  adapter claude   (internal) Run the Claude adapter on stdin and stdout.

Options:
  --data-dir <dir>   Where sessions and settings live. Default: $CYCLE_HOME or ~/.cycle
  --socket <path>    The unix socket. Default: <data-dir>/daemon.sock
`;

const { values, positionals, forwarded } = parseCli(Bun.argv.slice(2));
const command = positionals[0];
if (command === "adapter" && positionals[1] === "claude") {
  await runAdapter();
  process.exit(0);
}
if (command === "version") {
  console.log(VERSION);
  process.exit(0);
}
const commands = ["serve", "proxy", "status", "stop", "logs", "login", "claude"];
if (values.help || command === undefined || !commands.includes(command)) {
  console.error(USAGE);
  process.exit(command === undefined || values.help ? 0 : 2);
}
const paths = pathsFor(values["data-dir"] ?? defaultDataDir(), values.socket);

if (command === "serve") {
  try {
    // At a terminal what it logs is shown as well; started in the background, the log file is all there is.
    const running = await serve(
      paths,
      process.stderr.isTTY === true ? { echo: (line) => process.stderr.write(line) } : {},
    );
    onSignalsAndCrashes(running);
  } catch (error) {
    if (error instanceof AlreadyRunningError) {
      console.error(error.message);
      process.exit(3);
    }
    if (error instanceof NotASocketError) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  }
} else if (command === "login" || command === "claude") {
  // Claude's own sign-in, in the one place its login is kept: the same config directory and
  // environment the daemon gives the Claude it runs (config.json), and nothing else of this shell's.
  const config = await loadConfig(paths.config);
  const executable = claudeExecutable() ?? Bun.which("claude");
  if (executable === null || executable === undefined) {
    console.error("No Claude binary: it is meant to sit beside cycle, or be on PATH.");
    process.exit(1);
  }
  const rest = command === "login" ? ["auth", "login", ...(forwarded ?? [])] : (forwarded ?? []);
  const child = Bun.spawn([executable, ...rest], {
    env: claudeEnv(config.claude, paths.dataDir, process.env),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(await child.exited);
} else if (command === "status") {
  const up = await isListening(paths.socket);
  console.log(up ? `running, listening on ${paths.socket}` : `not running (${paths.socket})`);
  console.log(`log: ${paths.log}`);
  process.exit(up ? 0 : 1);
} else if (command === "logs") {
  // The end of the log, and where it is: what to look at when something went wrong on this machine.
  const lines = Number(values.lines ?? 100);
  console.error(
    `${paths.log}${existsSync(paths.output) ? ` (runtime output: ${paths.output})` : ""}`,
  );
  const text = await Bun.file(paths.log)
    .text()
    .catch(() => "");
  if (text === "") {
    console.error("The log is empty: the daemon has not run with this data directory.");
    process.exit(0);
  }
  process.stdout.write(tailLines(text, Number.isInteger(lines) && lines > 0 ? lines : 100));
  process.exit(0);
} else if (command === "stop") {
  const pidFile = join(paths.dataDir, "daemon.pid");
  const readPid = async () =>
    Number(
      (
        await Bun.file(pidFile)
          .text()
          .catch(() => "")
      ).trim(),
    );
  const known = (pid: number) => Number.isInteger(pid) && pid > 0;
  if (!(await isListening(paths.socket))) {
    console.log("not running");
    process.exit(0);
  }
  // The socket first, then its pid: a daemon writes it the moment it has bound (serve.ts), so one found listening has
  // it, or has it a moment later. A stopping one has already removed it.
  let pid = await readPid();
  for (const at = Date.now(); !known(pid) && Date.now() - at < 1_000; pid = await readPid())
    await Bun.sleep(50);
  if (!known(pid)) {
    if (!(await isListening(paths.socket))) {
      console.log("not running");
      process.exit(0);
    }
    console.log(
      `A daemon is listening on ${paths.socket}, but ${pidFile} has no pid: it may be stopping.`,
    );
    process.exit(1);
  }
  process.exit(
    await stopDaemon({
      force: values.force === true,
      wait: values.wait === true,
      interactive: process.stdin.isTTY === true,
      isRunning: () => isListening(paths.socket),
      working: () => askWorking(paths.socket),
      choose: async (question, unknown) => {
        process.stdout.write(question);
        for await (const line of console) {
          const answer = line.trim().toLowerCase();
          if (answer.startsWith("f")) return "force";
          if (answer.startsWith("w") && !unknown) return "wait";
          if (answer.startsWith("c") || answer === "") return "cancel";
          process.stdout.write(question);
        }
        return "cancel";
      },
      signal: () => process.kill(pid, "SIGTERM"),
      say: (line) => console.log(line),
    }),
  );
} else {
  // stdout is the protocol: nothing else may be written to it.
  await proxy(paths, {
    stdin: Bun.stdin.stream(),
    stdout: new WritableStream({
      write: (chunk) => {
        process.stdout.write(chunk);
      },
    }),
  });
  process.exit(0);
}
