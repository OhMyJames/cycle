import { afterEach, beforeEach, expect, test } from "bun:test";
import { realpath, rm } from "node:fs/promises";
import { methods } from "@agentclientprotocol/sdk/experimental/v2";
import { CycleErrorCode } from "@cycle/protocol";
import { Daemon } from "../src/index.ts";
import { terminalEnv } from "../src/terminals.ts";
import { connectClient, until } from "./client.ts";
import { fakeAgent } from "./fake-agent.ts";
import { tempDir } from "./support.ts";

// Real shells on real pseudo-terminals: `/bin/sh`, so what it prints does not depend on the machine's own shell.
// A marker is printed as arithmetic (`$((40+2))`) so the shell's echo of the command does not match it.

let dir: string;
let work: string;
let disposers: (() => Promise<void>)[] = [];
let open: Daemon[] = [];
beforeEach(async () => {
  const data = await tempDir();
  const folder = await tempDir();
  dir = data.dir;
  work = await realpath(folder.dir);
  disposers = [data.dispose, folder.dispose];
});
afterEach(async () => {
  for (const daemon of open) await daemon.close();
  open = [];
  for (const dispose of disposers) await dispose();
});

type Info = {
  terminalId: string;
  status: string;
  exitCode?: number | null;
  cols: number;
  title: string;
};
type Attached = { terminal: Info; screen: string; seq: number };

const start = async (limits: { maxPerSession?: number; max?: number } = {}) => {
  const daemon = await Daemon.start({
    dataDir: dir,
    agents: [fakeAgent().definition],
    terminals: {
      env: terminalEnv(["PATH", "HOME", "LC_*"], {
        PATH: "/usr/bin:/bin",
        HOME: work,
        LC_PROBE: "kept",
        ANTHROPIC_API_KEY: "sk-must-not-pass",
        CYCLE_POSTHOG_KEY: "phc-must-not-pass",
      }),
      shell: "/bin/sh",
      maxPerSession: limits.maxPerSession ?? 8,
      max: limits.max ?? 32,
      scrollback: 1000,
      killGraceMs: 500,
    },
  });
  open.push(daemon);
  return daemon;
};

/** Whether a process with this command line is running. */
const running = (command: string) =>
  Bun.spawnSync(["pgrep", "-f", command]).stdout.toString().trim().length > 0;

const call = <T>(c: Awaited<ReturnType<typeof connectClient>>, method: string, params: object) =>
  c.agent.request(method as never, params as never) as Promise<T>;

test("a terminal runs a shell in the session's folder, with only the allowed environment, and resizes", async () => {
  const daemon = await start();
  const c = await connectClient(daemon);
  expect(
    (c.init._meta as Record<string, { terminal?: boolean }>)["cycle/capabilities"]?.terminal,
  ).toBe(true);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: work });
  const made = await call<Attached>(c, "_cycle/terminal/create", {
    sessionId,
    cols: 100,
    rows: 30,
  });
  const id = made.terminal.terminalId;
  expect(made.terminal).toMatchObject({ status: "running", cols: 100, rows: 30, title: "sh" });

  await call(c, "_cycle/terminal/input", {
    terminalId: id,
    data: "pwd; stty size; env | sort; echo done-$((40+2))\n",
  });
  await until(() => c.terminalText(id).includes("done-42"), "the shell's answer", 5_000);
  const text = c.terminalText(id);
  expect(text).toContain(work);
  expect(text).toContain("30 100");
  expect(text).toContain("TERM=xterm-256color");
  expect(text).toContain("COLORTERM=truecolor");
  expect(text).toContain("LC_PROBE=kept");
  expect(text).not.toContain("must-not-pass");
  const seqs = c.terminal.filter((t) => t.kind === "output").map((t) => t.params.seq as number);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

  await call(c, "_cycle/terminal/resize", { terminalId: id, cols: 120, rows: 40 });
  await call(c, "_cycle/terminal/input", { terminalId: id, data: "stty size\n" });
  await until(() => c.terminalText(id).includes("40 120"), "the new size", 5_000);
  const listed = await call<{ terminals: Info[] }>(c, "_cycle/terminal/list", { sessionId });
  expect(listed.terminals.map((t) => [t.terminalId, t.cols])).toEqual([[id, 120]]);
  expect(c.terminal.some((t) => t.kind === "changed" && t.params.sessionId === sessionId)).toBe(
    true,
  );
});

test("another connection attaches to the screen so far, then gets what follows; a connection that left gets nothing", async () => {
  const daemon = await start();
  const a = await connectClient(daemon);
  const { sessionId } = await a.agent.request(methods.agent.session.new, { cwd: work });
  const id = (await call<Attached>(a, "_cycle/terminal/create", { sessionId, cols: 80, rows: 24 }))
    .terminal.terminalId;
  await call(a, "_cycle/terminal/input", { terminalId: id, data: "echo before-$((1+1))\n" });
  await until(() => a.terminalText(id).includes("before-2"), "the first output", 5_000);

  const b = await connectClient(daemon);
  const attached = await call<Attached>(b, "_cycle/terminal/attach", { terminalId: id });
  expect(attached.screen).toContain("before-2");
  expect(attached.seq).toBeGreaterThan(0);

  await a.close();
  await call(b, "_cycle/terminal/input", { terminalId: id, data: "echo after-$((2+1))\n" });
  await until(() => b.terminalText(id).includes("after-3"), "output after attaching", 5_000);
  const fresh = b.terminal.filter((t) => t.kind === "output").map((t) => t.params.seq as number);
  expect(Math.min(...fresh)).toBeGreaterThan(attached.seq);
  expect(a.terminalText(id)).not.toContain("after-3");

  await call(b, "_cycle/terminal/detach", { terminalId: id });
  const before = b.terminal.length;
  await call(b, "_cycle/terminal/input", { terminalId: id, data: "echo gone-$((3+1))\n" });
  await Bun.sleep(300);
  expect(b.terminal.slice(before).some((t) => t.kind === "output")).toBe(false);
});

test("a shell that exits stays listed with its code until closed; input to it is refused", async () => {
  const daemon = await start();
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: work });
  const id = (await call<Attached>(c, "_cycle/terminal/create", { sessionId, cols: 80, rows: 24 }))
    .terminal.terminalId;
  await call(c, "_cycle/terminal/input", { terminalId: id, data: "exit 3\n" });
  const exited = async () =>
    (await call<{ terminals: Info[] }>(c, "_cycle/terminal/list", { sessionId })).terminals[0];
  let info: Info | undefined;
  const started = Date.now();
  while (info?.status !== "exited" && Date.now() - started < 5_000) {
    info = await exited();
    await Bun.sleep(20);
  }
  expect(info).toMatchObject({ status: "exited", exitCode: 3 });
  await expect(
    call(c, "_cycle/terminal/input", { terminalId: id, data: "x" }),
  ).rejects.toMatchObject({
    code: -32602,
    data: { reason: "exited" },
  });
  await call(c, "_cycle/terminal/close", { terminalId: id });
  expect(
    (await call<{ terminals: Info[] }>(c, "_cycle/terminal/list", { sessionId })).terminals,
  ).toEqual([]);
  await expect(call(c, "_cycle/terminal/attach", { terminalId: id })).rejects.toMatchObject({
    code: -32002,
  });
});

test("closing a terminal ends the job in front of its shell and the jobs behind it", async () => {
  const daemon = await start();
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: work });
  const id = (await call<Attached>(c, "_cycle/terminal/create", { sessionId, cols: 80, rows: 24 }))
    .terminal.terminalId;
  const marker = 41_000 + Math.floor(Math.random() * 999);
  const behind = `sleep ${marker}`;
  const front = `sleep ${marker + 1}`;
  await call(c, "_cycle/terminal/input", { terminalId: id, data: `${behind} &\n${front}\n` });
  await until(() => running(behind) && running(front), "both jobs to start", 5_000);
  await call(c, "_cycle/terminal/close", { terminalId: id });
  await until(() => !running(front) && !running(behind), "both jobs to end", 5_000);
});

test("what a shell prints as it exits reaches the client", async () => {
  const daemon = await start();
  const c = await connectClient(daemon);
  const { sessionId } = await c.agent.request(methods.agent.session.new, { cwd: work });
  const id = (await call<Attached>(c, "_cycle/terminal/create", { sessionId, cols: 80, rows: 24 }))
    .terminal.terminalId;
  await call(c, "_cycle/terminal/input", {
    terminalId: id,
    data: "seq 1 2000 | tail -1; echo last-$((5+5)); exit 4\n",
  });
  const exited = () =>
    c.terminal.some(
      (t) =>
        t.kind === "changed" &&
        (t.params.terminals as Info[]).some((x) => x.terminalId === id && x.exitCode === 4),
    );
  await until(exited, "the exit", 5_000);
  await until(() => c.terminalText(id).includes("last-10"), "the last words", 5_000);
  expect(c.terminalText(id)).toContain("2000");
});

test("terminals are limited per session and per daemon, and need the session's folder", async () => {
  const daemon = await start({ maxPerSession: 2, max: 3 });
  const c = await connectClient(daemon);
  const one = (await c.agent.request(methods.agent.session.new, { cwd: work })).sessionId;
  const two = (await c.agent.request(methods.agent.session.new, { cwd: work })).sessionId;
  const create = (sessionId: string) =>
    call<Attached>(c, "_cycle/terminal/create", { sessionId, cols: 80, rows: 24 });
  await create(one);
  await create(one);
  await expect(create(one)).rejects.toMatchObject({ code: CycleErrorCode.TerminalLimit });
  await create(two);
  await expect(create(two)).rejects.toMatchObject({ code: CycleErrorCode.TerminalLimit });
  await expect(create("nope")).rejects.toMatchObject({ code: -32002 });
  await expect(
    call(c, "_cycle/terminal/create", { sessionId: one, cols: 1, rows: 24 }),
  ).rejects.toMatchObject({ code: -32602 });

  const gone = await tempDir();
  const elsewhere = await realpath(gone.dir);
  const three = (await c.agent.request(methods.agent.session.new, { cwd: elsewhere })).sessionId;
  await gone.dispose();
  await rm(elsewhere, { recursive: true, force: true });
  await daemon.close();
  open = [];
  const again = await start({ maxPerSession: 2, max: 3 });
  const d = await connectClient(again);
  await expect(
    call(d, "_cycle/terminal/create", { sessionId: three, cols: 80, rows: 24 }),
  ).rejects.toMatchObject({ code: -32602, data: { reason: "cwd_missing" } });
});

test("archiving or deleting a session closes its terminals, and so does the daemon stopping", async () => {
  const daemon = await start();
  const c = await connectClient(daemon);
  const session = async () =>
    (await c.agent.request(methods.agent.session.new, { cwd: work })).sessionId;
  const create = async (sessionId: string) =>
    (await call<Attached>(c, "_cycle/terminal/create", { sessionId, cols: 80, rows: 24 })).terminal
      .terminalId;
  const archived = await session();
  const deleted = await session();
  const kept = await session();
  await create(archived);
  await create(deleted);
  const last = await create(kept);

  await call(c, "_cycle/session/archive", { sessionId: archived });
  await expect(
    call(c, "_cycle/terminal/create", { sessionId: archived, cols: 80, rows: 24 }),
  ).rejects.toMatchObject({ code: -32602, data: { reason: "archived" } });
  expect(
    (await call<{ terminals: Info[] }>(c, "_cycle/terminal/list", { sessionId: archived }))
      .terminals,
  ).toEqual([]);
  await c.agent.request(methods.agent.session.delete, { sessionId: deleted } as never);
  await expect(call(c, "_cycle/terminal/list", { sessionId: deleted })).rejects.toMatchObject({
    code: -32002,
  });

  await call(c, "_cycle/terminal/input", { terminalId: last, data: "echo pid-$$\n" });
  await until(() => /pid-\d+/.test(c.terminalText(last)), "the shell's pid", 5_000);
  const pid = Number(/pid-(\d+)/.exec(c.terminalText(last))?.[1]);
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  expect(alive()).toBe(true);
  await daemon.close();
  open = [];
  await until(() => !alive(), "the shell to end with the daemon", 5_000);
});
