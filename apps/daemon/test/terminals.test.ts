import { expect, test } from "bun:test";
import type { TerminalInfo } from "@cycle/protocol";
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
  });
  expect(typeof env.HOME).toBe("string");
  for (const name of ["LCX", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "SSH_AUTH_SOCK"])
    expect(name in env).toBe(false);
});

test("the shell is the person's when it can be run, else /bin/sh", () => {
  expect(terminalShell("/bin/sh")).toBe("/bin/sh");
  expect(terminalShell(undefined)).toBe("/bin/sh");
  expect(terminalShell("zsh")).toBe("/bin/sh");
  expect(terminalShell("/no/such/shell")).toBe("/bin/sh");
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
