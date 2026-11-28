import { expect, test } from "bun:test";
import { userInfo } from "node:os";
import type { TerminalInfo } from "@cycle/protocol";
import { defaultTerminals } from "../src/daemon.ts";
import {
  type Pty,
  type PtySpawnOptions,
  type Screen,
  type TerminalSink,
  Terminals,
  terminalEnv,
  terminalShell,
  xtermScreen,
} from "../src/terminals.ts";
import { until } from "./client.ts";

test("the shell's environment is only what is allowed, a `*` is a prefix, and TERM is always set", () => {
  const env = terminalEnv(["PATH", "LC_*", "HOME"], {
    PATH: "/bin",
    LC_ALL: "C",
    LC_CTYPE: "UTF-8",
    LCX: "no",
    ANTHROPIC_API_KEY: "sk",
    CLAUDE_CODE_OAUTH_TOKEN: "t",
    SSH_AUTH_SOCK: "/tmp/agent",
    TERM: "dumb",
  });
  expect(env).toMatchObject({
    PATH: "/bin",
    LC_ALL: "C",
    LC_CTYPE: "UTF-8",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    CLICOLOR: "1",
  });
  expect(typeof env.HOME).toBe("string");
  for (const name of ["LCX", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "SSH_AUTH_SOCK"])
    expect(name in env).toBe(false);
});

test("on a Mac a shell from a daemon with no locale still gets UTF-8, and a locale it has is kept", () => {
  const allow = ["PATH", "LANG", "LC_*", "CLICOLOR"];
  // As a Finder-started app's daemon has it: no locale.
  const bare = terminalEnv(allow, { PATH: "/bin", HOME: "/home/x" }, "darwin");
  expect(bare.LANG).toBe("en_US.UTF-8");
  expect("LC_CTYPE" in bare).toBe(false);
  expect("LANG" in terminalEnv(allow, { PATH: "/bin" }, "linux")).toBe(false);
  const chosen = terminalEnv(allow, { LANG: "zh_CN.UTF-8" }, "darwin");
  expect(chosen.LANG).toBe("zh_CN.UTF-8");
  expect(terminalEnv(allow, { LC_CTYPE: "UTF-8" }, "darwin").LANG).toBeUndefined();
  // Colour can still be turned off through the allowlist.
  expect(terminalEnv(allow, { CLICOLOR: "0" }).CLICOLOR).toBe("0");
});

test("the shell is SHELL when it can be run, else the account's login shell, else /bin/sh", () => {
  const runnable = process.execPath;
  let looked = 0;
  const account = (shell: string | undefined) => () => {
    looked++;
    return shell;
  };
  expect(terminalShell("/bin/sh", account(runnable))).toBe("/bin/sh");
  expect(looked).toBe(0);
  // A daemon with no SHELL: the account's shell, not /bin/sh, so the person's prompt and rc files are there.
  expect(terminalShell(undefined, account(runnable))).toBe(runnable);
  expect(terminalShell("/no/such/shell", account(runnable))).toBe(runnable);
  expect(terminalShell(undefined, account(undefined))).toBe("/bin/sh");
  expect(terminalShell("zsh", account("zsh"))).toBe("/bin/sh");
  expect(terminalShell("/no/such/shell", account("/no/such/either"))).toBe("/bin/sh");
});

test("the daemon the app starts (PATH, HOME, CYCLE_HOME and nothing else) runs the account's shell", () => {
  const settings = defaultTerminals({ PATH: "/bin", HOME: "/home/x", CYCLE_HOME: "/data" });
  const account = userInfo().shell;
  const runnable = account?.startsWith("/") === true && Bun.which(account) !== null;
  expect(settings.shell).toBe(runnable ? (account as string) : "/bin/sh");
  expect("CYCLE_HOME" in settings.env).toBe(false);
});

/** A pseudo-terminal whose output the test makes. */
const fakePty = () => {
  let options: PtySpawnOptions | undefined;
  let exit: (code: number | null) => void = () => {};
  const written: string[] = [];
  const pty: Pty = {
    pid: 2 ** 22 + Math.floor(Math.random() * 1000),
    write: (data) => written.push(data),
    resize: () => {},
    processes: async () => [],
    hangup: () => exit(null),
    exited: new Promise((resolve) => {
      exit = resolve;
    }),
  };
  return {
    spawn: (o: PtySpawnOptions) => {
      options = o;
      return pty;
    },
    print: (text: string) => options?.onData(new TextEncoder().encode(text)),
    printBytes: (bytes: Uint8Array) => options?.onData(bytes),
    exit: (code: number | null) => exit(code),
    written,
  };
};

/** A connection whose writes finish only when the test lets them. */
const slowSink = (id: string) => {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const waiting: (() => void)[] = [];
  const sink: TerminalSink = {
    id,
    send: (method, params) => {
      sent.push({ method, params: params as Record<string, unknown> });
      return new Promise<void>((resolve) => waiting.push(resolve));
    },
  };
  return {
    sink,
    sent,
    release: () => {
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
};

const terminals = (spawn: (o: PtySpawnOptions) => Pty, changed: TerminalInfo[][] = []) =>
  new Terminals({
    env: {},
    shell: "/bin/sh",
    maxPerSession: 8,
    max: 32,
    scrollback: 100,
    spawn,
    screen: xtermScreen,
    batchMs: 1,
    behindBytes: 1000,
    killGraceMs: 50,
    onChanged: (_sessionId, list) => changed.push(list),
  });

test("output is cut into pieces in order, and a character split across reads is not broken", async () => {
  const pty = fakePty();
  const t = terminals(pty.spawn);
  const c = slowSink("c1");
  const made = await t.create("s1", "/tmp", 80, 24, c.sink);
  expect(made.seq).toBe(0);
  const bytes = new TextEncoder().encode("é-ok");
  pty.printBytes(bytes.slice(0, 1));
  pty.printBytes(bytes.slice(1));
  await until(() => c.sent.length > 0, "the output");
  c.release();
  const pieces = c.sent.filter((s) => s.method === "_cycle/terminal/output");
  expect(pieces.map((p) => p.params.data).join("")).toBe("é-ok");
  expect(pieces.map((p) => p.params.seq)).toEqual(pieces.map((_, i) => i + 1));
  await t.closeAll();
});

test("a connection that stops taking output gets none until it catches up, then the screen and what follows", async () => {
  const pty = fakePty();
  const t = terminals(pty.spawn);
  const c = slowSink("c1");
  const made = await t.create("s1", "/tmp", 80, 24, c.sink);
  const id = made.terminal.terminalId;
  // More than `behindBytes` sent and not written out: the next pieces are not sent.
  for (let i = 0; i < 6; i++) {
    pty.print(`line-${i}-${"x".repeat(300)}\r\n`);
    await Bun.sleep(5);
  }
  const sentWhileStuck = c.sent.length;
  expect(sentWhileStuck).toBeLessThan(6);
  pty.print("while-behind\r\n");
  await Bun.sleep(10);
  expect(c.sent.length).toBe(sentWhileStuck);

  c.release();
  await until(() => c.sent.some((s) => s.method === "_cycle/terminal/reset"), "the reset");
  const reset = c.sent.find((s) => s.method === "_cycle/terminal/reset")?.params;
  expect(reset?.terminalId).toBe(id);
  expect(reset?.screen as string).toContain("while-behind");
  c.release();
  pty.print("after-reset\r\n");
  await until(
    () => c.sent.some((s) => String(s.params.data ?? "").includes("after-reset")),
    "output after the reset",
  );
  const after = c.sent.filter(
    (s, i) =>
      s.method === "_cycle/terminal/output" && i > c.sent.findIndex((x) => x.params === reset),
  );
  for (const piece of after)
    expect(piece.params.seq as number).toBeGreaterThan(reset?.seq as number);
  c.release();
  await t.closeAll();
});

test("a title the shell sets, an exit, and a close are told as changes", async () => {
  const pty = fakePty();
  const changed: TerminalInfo[][] = [];
  const t = terminals(pty.spawn, changed);
  const c = slowSink("c1");
  const id = (await t.create("s1", "/tmp", 80, 24, c.sink)).terminal.terminalId;
  pty.print("\x1b]0;my build\x07");
  await until(() => changed.at(-1)?.[0]?.title === "my build", "the title");
  pty.exit(7);
  await until(() => changed.at(-1)?.[0]?.status === "exited", "the exit");
  expect(changed.at(-1)?.[0]?.exitCode).toBe(7);
  await t.close(id);
  expect(changed.at(-1)).toEqual([]);
  expect(t.size).toBe(0);
});

test("the screen's snapshot holds everything written before it", async () => {
  const screen: Screen = xtermScreen({ cols: 20, rows: 5, scrollback: 10 });
  for (let i = 0; i < 30; i++) screen.write(`row ${i}\r\n`, () => {});
  const shot = await screen.snapshot();
  expect(shot).toContain("row 29");
  expect(shot).not.toContain("row 5\r");
  screen.dispose();
});

test("the screen's snapshot keeps the colours a program drew in, so a client attaching later sees them", async () => {
  const screen: Screen = xtermScreen({ cols: 40, rows: 5, scrollback: 10 });
  screen.write("\x1b[31mred\x1b[0m \x1b[1;34mblue\x1b[0m \x1b[38;5;208m256\x1b[0m", () => {});
  const shot = await screen.snapshot();
  /** The attributes the last SGR before a word set, as numbers (`34;1` and `1;34` are the same). */
  const drawnIn = (word: string) => {
    const before = shot.slice(0, shot.indexOf(word));
    const sgr = before.slice(before.lastIndexOf("\x1b[") + 2, -1);
    return sgr.split(";").map(Number);
  };
  expect(drawnIn("red")).toContain(31);
  expect(drawnIn("blue")).toEqual(expect.arrayContaining([1, 34]));
  expect(drawnIn("256")).toEqual([38, 5, 208]);
  screen.dispose();
});

test("a reset larger than the limit for falling behind does not put the connection behind again", async () => {
  const pty = fakePty();
  const t = terminals(pty.spawn);
  const c = slowSink("c1");
  await t.create("s1", "/tmp", 200, 50, c.sink);
  // Enough on screen that its snapshot alone is past `behindBytes` (1000 here).
  for (let i = 0; i < 40; i++) {
    pty.print(`${i}-${"y".repeat(150)}\r\n`);
    await Bun.sleep(2);
  }
  await until(() => c.sent.length > 0, "the first output");
  c.release();
  await until(() => c.sent.some((s) => s.method === "_cycle/terminal/reset"), "the reset");
  const reset = c.sent.find((s) => s.method === "_cycle/terminal/reset");
  expect(String(reset?.params.screen ?? "").length).toBeGreaterThan(1000);
  // Output after the reset goes out while the reset itself is still being written.
  pty.print("small\r\n");
  await until(
    () => c.sent.some((s) => String(s.params.data ?? "").includes("small")),
    "output after a large reset",
  );
  c.release();
  await Bun.sleep(30);
  expect(c.sent.filter((s) => s.method === "_cycle/terminal/reset").length).toBe(1);
  c.release();
  await t.closeAll();
});

test("a stopped set of terminals opens no new one", async () => {
  const pty = fakePty();
  const t = terminals(pty.spawn);
  await t.closeAll();
  await expect(t.create("s1", "/tmp", 80, 24, slowSink("c").sink)).rejects.toMatchObject({
    code: -32602,
    data: { reason: "daemon_stopping" },
  });
});

test("a terminal holds a switch of version only while it runs a command (CYC-538)", async () => {
  const shell = fakePty();
  let running: number[] = [];
  let shellPid = 0;
  const spawn = (o: PtySpawnOptions) => {
    const pty = shell.spawn(o);
    shellPid = pty.pid;
    return { ...pty, processes: async () => running };
  };
  const t = terminals(spawn);
  expect(await t.busy()).toBe(false);
  await t.create("s1", "/tmp", 80, 24, slowSink("c1").sink);
  // A shell at its prompt: only its own process.
  running = [shellPid];
  expect(await t.busy()).toBe(false);
  // A command in front of it.
  running = [shellPid, 123456];
  expect(await t.busy()).toBe(true);
  await t.closeAll();

  // An environment's action holds it for as long as it runs, whatever its processes.
  const action = terminals(fakePty().spawn);
  await action.create("s1", "/tmp", 80, 24, slowSink("c2").sink, {
    command: { title: "dev", script: "sleep 100" },
  });
  expect(await action.busy()).toBe(true);
  await action.closeAll();
  expect(await action.busy()).toBe(false);
});
