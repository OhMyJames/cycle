import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCli as parse } from "../src/args.ts";

const parseCli = (argv: string[]) => parse(argv, ["login", "claude"]);

test("Cycle's options are read before the command, and the line after claude is left alone", () => {
  const line = [
    "--data-dir",
    "/d",
    "claude",
    "--version",
    "-p",
    "x",
    "--socket",
    "y",
    "--",
    "--help",
  ];
  const parsed = parseCli(line);
  expect(parsed.values["data-dir"]).toBe("/d");
  expect(parsed.values.socket).toBeUndefined();
  expect(parsed.values.help).toBeUndefined();
  expect(parsed.positionals).toEqual(["claude"]);
  expect(parsed.forwarded).toEqual(["--version", "-p", "x", "--socket", "y", "--", "--help"]);
});

test("login hands on what follows it, and the other commands are read whole as before", () => {
  expect(parseCli(["login", "--console"]).forwarded).toEqual(["--console"]);
  const status = parseCli(["status", "--socket", "/s"]);
  expect(status.forwarded).toBeUndefined();
  expect(status.values.socket).toBe("/s");
  expect(parseCli(["--help"]).values.help).toBe(true);
  expect(parseCli(["serve", "--data-dir=/x"]).values["data-dir"]).toBe("/x");
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cv1-cli-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Runs `cycle` from source with a stub `claude` on PATH that writes down its arguments; gives them back. */
const withStubClaude = async (main: string, ...args: string[]) => {
  const seen = join(dir, "argv");
  const stub = join(dir, "bin", "claude");
  await rm(seen, { force: true });
  await Bun.write(stub, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > ${seen}\n`);
  await chmod(stub, 0o755);
  const child = Bun.spawn([process.execPath, main, "--data-dir", join(dir, "data"), ...args], {
    env: { ...process.env, HOME: dir, PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}` },
    stdout: "ignore",
    stderr: "pipe",
  });
  const code = await child.exited;
  const stderr = await new Response(child.stderr).text();
  const argv = (await readFile(seen, "utf8").catch(() => "")).split("\n").slice(0, -1);
  return { code, stderr, argv };
};
const MAIN = new URL("./fixtures/stub-cli-main.ts", import.meta.url).pathname;

test("cycle claude gives the Claude binary every argument as typed", async () => {
  const ran = await withStubClaude(MAIN, "claude", "--version", "-p", "hi", "--", "--help");
  expect(ran.stderr).toBe("");
  expect(ran.code).toBe(0);
  expect(ran.argv).toEqual(["--version", "-p", "hi", "--", "--help"]);
}, 15_000);

test("login signs in to the agent that is named, and to Claude when none is", async () => {
  expect((await withStubClaude(MAIN, "login")).argv).toEqual(["auth", "login"]);
  expect((await withStubClaude(MAIN, "login", "--console")).argv).toEqual([
    "auth",
    "login",
    "--console",
  ]);
  // One this build does not have is refused, not handed to Claude's sign-in as an argument.
  const unknown = await withStubClaude(MAIN, "login", "nosuch");
  expect(unknown.code).toBe(2);
  expect(unknown.argv).toEqual([]);
  expect(unknown.stderr).toContain(
    "No agent named nosuch to sign in to: this build has claude, codex, agy.",
  );
  // The agent's name is Cycle's word, not the agent's: it is not handed on.
  expect((await withStubClaude(MAIN, "login", "claude", "--console")).argv).toEqual([
    "auth",
    "login",
    "--console",
  ]);
}, 30_000);

test("a build's commands are its agents': one with no command line has no login, and an adapter nobody has is refused", async () => {
  // The fixture is a `cycle` whose only agent ships no binary and has nothing to sign in to.
  const echo = new URL("./fixtures/echo-harness.ts", import.meta.url).pathname;
  const login = await withStubClaude(echo, "login");
  expect(login.code).toBe(2);
  expect(login.argv).toEqual([]);
  expect(login.stderr).not.toContain("login");
  const claude = await withStubClaude(echo, "claude");
  expect(claude.code).toBe(2);
  expect(claude.argv).toEqual([]);
  const adapter = await withStubClaude(echo, "adapter", "claude");
  expect(adapter.code).toBe(2);
  expect(adapter.stderr).toContain("No adapter for claude: this build has echo.");
}, 30_000);

test("runCli runs cli.prepare after creating cli.directories and before spawning the CLI binary (CYC-401)", async () => {
  const orderLog = join(dir, "order.log");
  const stub = join(dir, "bin", "prep-agent");
  await Bun.write(stub, `#!/bin/sh\necho "spawned:$HOME" >> ${JSON.stringify(orderLog)}\n`);
  await chmod(stub, 0o755);
  const fixture = join(dir, "prep-main.ts");
  await Bun.write(
    fixture,
    `import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runCli } from ${JSON.stringify(new URL("../src/cli.ts", import.meta.url).pathname)};
const harness = {
  id: "prep",
  name: "Prep",
  runAdapter: async () => {},
  definition: () => { throw new Error("unused"); },
  cli: {
    executable: () => ${JSON.stringify(stub)},
    env: ({ dataDir }: { dataDir: string }) => ({ HOME: join(dataDir, "prep-home") }),
    login: ["login"],
    directories: ["HOME"],
    prepare: async (_ctx: unknown, env: Record<string, string>) => {
      appendFileSync(${JSON.stringify(orderLog)}, \`prepared:\${existsSync(env.HOME ?? "")}:\${env.HOME}\\n\`);
    },
  },
};
await runCli(Bun.argv.slice(2), [harness as never]);
`,
  );
  const child = Bun.spawn(
    [process.execPath, fixture, "--data-dir", join(dir, "data"), "login", "prep"],
    {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const code = await child.exited;
  expect(code).toBe(0);
  const lines = (await readFile(orderLog, "utf8")).trim().split("\n");
  expect(lines).toEqual([
    `prepared:true:${join(dir, "data", "prep-home")}`,
    `spawned:${join(dir, "data", "prep-home")}`,
  ]);
}, 15_000);
