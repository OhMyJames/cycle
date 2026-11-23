import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseCli } from "./args.ts";
import { defaultDataDir, loadConfig, pathsFor } from "./config.ts";
import type { Harness } from "./harness.ts";
import { tailLines } from "./logger.ts";
import { proxy } from "./proxy.ts";
import { onSignalsAndCrashes, serve } from "./serve.ts";
import { askWorking, stopDaemon } from "./stop.ts";
import { AlreadyRunningError, isListening, NotASocketError } from "./transport/server.ts";
import { VERSION } from "./version.ts";

const usage = (harnesses: readonly Harness[]): string => {
  const withCli = harnesses.filter((h) => h.cli !== undefined);
  const ids = withCli.map((h) => h.id).join(" | ");
  const first = withCli[0];
  return `cycle <command> [options]

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
${
  first === undefined
    ? ""
    : `  login [${ids}]   Sign in to an agent for this daemon (${first.name} when none is named): the
          agent's own sign-in, with the environment and config directory the daemon gives
          it. Run it on the machine the daemon is on.
  ${ids} <args>   Run that agent's binary with that same environment (e.g. ${first.id} ${first.cli?.login.join(" ")}).
          Everything after the agent's name goes to it as typed, --help included.
`
}  adapter <agent>   (internal) Run an agent's adapter on stdin and stdout.

Options:
  --data-dir <dir>   Where sessions and settings live. Default: $CYCLE_HOME or ~/.cycle
  --socket <path>    The unix socket. Default: <data-dir>/daemon.sock
`;
};

/** The `cycle` command line, for the agents this build has (harnesses.ts). Exits the process when it is done. */
export const runCli = async (argv: string[], harnesses: readonly Harness[]): Promise<void> => {
  const USAGE = usage(harnesses);
  const withCli = harnesses.filter((h) => h.cli !== undefined);
  const { values, positionals, forwarded } = parseCli(argv, ["login", ...withCli.map((h) => h.id)]);
  const command = positionals[0];
  if (command === "adapter") {
    const harness = harnesses.find((h) => h.id === positionals[1]);
    if (harness === undefined) {
      console.error(
        `No adapter for ${positionals[1] ?? "(no agent named)"}: this build has ${harnesses.map((h) => h.id).join(", ")}.`,
      );
      process.exit(2);
    }
    await harness.runAdapter();
    process.exit(0);
  }
  if (command === "version") {
    console.log(VERSION);
    process.exit(0);
  }
  const ownCommand = withCli.find((h) => h.id === command);
  const commands = [
    "serve",
    "proxy",
    "status",
    "stop",
    "logs",
    ...(withCli.length > 0 ? ["login"] : []),
  ];
  if (values.help || command === undefined || !(commands.includes(command) || ownCommand)) {
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
  } else if (command === "login" || ownCommand !== undefined) {
    // The agent's own command line, in the one place its login is kept: the same config directory and environment the
    // daemon gives the agent it runs (config.json), and nothing else of this shell's.
    // `login <agent>` names one; `login` alone is the first, as it was when there was one.
    const word = command === "login" ? forwarded?.[0] : undefined;
    const named = withCli.find((h) => h.id === word);
    // A word after `login` is an agent's name (an option, `--console`, is the agent's own): one this build does not
    // have is said, not handed to another agent's sign-in.
    if (word !== undefined && !word.startsWith("-") && named === undefined) {
      console.error(
        `No agent named ${word} to sign in to: this build has ${withCli.map((h) => h.id).join(", ")}.`,
      );
      process.exit(2);
    }
    const harness = ownCommand ?? named ?? withCli[0];
    const cli = harness?.cli;
    if (harness === undefined || cli === undefined) {
      console.error(USAGE);
      process.exit(2);
    }
    const typed = (named !== undefined ? forwarded?.slice(1) : forwarded) ?? [];
    const config = await loadConfig(paths.config);
    const executable = cli.executable();
    if (executable === undefined) {
      console.error(`No ${harness.name} binary: it is meant to sit beside cycle, or be on PATH.`);
      process.exit(1);
    }
    const env = cli.env({ config, dataDir: paths.dataDir, inherited: process.env });
    // A fresh data directory has none of the agent's yet: Codex will not sign in to a CODEX_HOME that is not there.
    for (const key of cli.directories ?? [])
      if (env[key]) await mkdir(env[key], { recursive: true, mode: 0o700 });
    const child = Bun.spawn(
      [executable, ...(cli.args ?? []), ...(command === "login" ? cli.login : []), ...typed],
      {
        env,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      },
    );
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
};
