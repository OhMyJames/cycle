import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Channel, connectUnix, sshChannel } from "@cycle/client";
import {
  AlreadyRunningError,
  bridgeStdio,
  isListening,
  listenUnix,
  NotASocketError,
} from "../src/transport/server.ts";
import { fakeSsh, tempDir } from "./fake-ssh.ts";

let dir: string;
let dispose: () => Promise<void>;
let stops: (() => void)[] = [];
beforeEach(async () => {
  ({ dir, dispose } = await tempDir());
});
afterEach(async () => {
  for (const stop of stops) stop();
  stops = [];
  await dispose();
});

/** A server that sends back every message it gets. */
const echo = async (path: string) => {
  const server = await listenUnix({
    path,
    onConnection: ({ stream }) => {
      const writer = stream.writable.getWriter();
      void (async () => {
        const reader = stream.readable.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          await writer.write(value);
        }
      })().catch(() => undefined);
    },
  });
  stops.push(server.close);
  return server;
};

const roundTrip = async (channel: Channel, message: object) => {
  const writer = channel.stream.writable.getWriter();
  const reader = channel.stream.readable.getReader();
  await writer.write(message as never);
  const { value } = await reader.read();
  writer.releaseLock();
  reader.releaseLock();
  return value;
};

test("carries messages both ways over a unix socket", async () => {
  const path = join(dir, "d.sock");
  await echo(path);
  const channel = await connectUnix(path);
  stops.push(channel.close);
  const message = { jsonrpc: "2.0", method: "_test/ping", params: { n: 1 } };
  expect(await roundTrip(channel, message)).toEqual(message as never);
});

test("carries a message much larger than a socket buffer", async () => {
  const path = join(dir, "d.sock");
  await echo(path);
  const channel = await connectUnix(path);
  stops.push(channel.close);
  const big = { jsonrpc: "2.0", method: "_test/big", params: { text: "x".repeat(8_000_000) } };
  const back = (await roundTrip(channel, big)) as { params: { text: string } };
  expect(back.params.text.length).toBe(8_000_000);
});

test("keeps the order of many messages sent at once", async () => {
  const path = join(dir, "d.sock");
  await echo(path);
  const channel = await connectUnix(path);
  stops.push(channel.close);
  const writer = channel.stream.writable.getWriter();
  const reader = channel.stream.readable.getReader();
  const sent = Array.from({ length: 500 }, (_, n) => ({
    jsonrpc: "2.0",
    method: "_test/n",
    params: { n },
  }));
  void (async () => {
    for (const message of sent) await writer.write(message as never);
  })();
  const got: number[] = [];
  while (got.length < sent.length) {
    const { value } = await reader.read();
    got.push((value as { params: { n: number } }).params.n);
  }
  expect(got).toEqual(sent.map((m) => m.params.n));
});

test("only its owner can reach the socket", async () => {
  const path = join(dir, "sub", "d.sock");
  await echo(path);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(dir, "sub"))).mode & 0o777).toBe(0o700);
});

test("refuses to start where something is already listening", async () => {
  const path = join(dir, "d.sock");
  await echo(path);
  expect(await isListening(path)).toBe(true);
  await expect(listenUnix({ path, onConnection: () => {} })).rejects.toBeInstanceOf(
    AlreadyRunningError,
  );
});

test("of two started at once, only the one that binds runs onListening; the other is refused", async () => {
  const path = join(dir, "d.sock");
  const said: string[] = [];
  const start = (who: string) =>
    listenUnix({ path, onListening: () => said.push(who), onConnection: () => {} });
  const results = await Promise.allSettled([start("a"), start("b")]);
  const bound = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  for (const server of bound) stops.push(server.close);
  const refused = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
  expect(bound).toHaveLength(1);
  expect(refused).toHaveLength(1);
  expect(refused[0]).toBeInstanceOf(AlreadyRunningError);
  expect(said).toHaveLength(1);
  expect(await isListening(path)).toBe(true);
});

test("a socket whose onListening fails is let go", async () => {
  const path = join(dir, "d.sock");
  await expect(
    listenUnix({
      path,
      onListening: () => {
        throw new Error("no room for the pid");
      },
      onConnection: () => {},
    }),
  ).rejects.toThrow("no room for the pid");
  expect(existsSync(path)).toBe(false);
  expect(await isListening(path)).toBe(false);
});

/** A socket file as a process that was killed leaves it: there, and nobody behind it. */
const staleSocket = async (path: string): Promise<void> => {
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      "Bun.listen({unix: process.argv[1], socket:{data(){}}}); setInterval(()=>{},1000)",
      path,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  for (let waited = 0; !existsSync(path); waited += 10) {
    if (waited > 5_000) throw new Error("the socket was never made");
    await Bun.sleep(10);
  }
  child.kill("SIGKILL");
  await child.exited;
};

test("takes over a socket file left behind by a process that died", async () => {
  const path = join(dir, "d.sock");
  await staleSocket(path);
  expect(existsSync(path)).toBe(true);
  expect(await isListening(path)).toBe(false);
  await echo(path);
  const channel = await connectUnix(path);
  stops.push(channel.close);
  expect(await roundTrip(channel, { jsonrpc: "2.0", method: "_test/ping" })).toBeDefined();
});

test("a file that is not a socket is left as it is, and so are the permissions of a folder that was already there", async () => {
  const shared = join(dir, "shared");
  await mkdir(shared, { mode: 0o755 });
  await chmod(shared, 0o755);
  const path = join(shared, "notes.txt");
  await writeFile(path, "mine");
  await expect(listenUnix({ path, onConnection: () => {} })).rejects.toBeInstanceOf(
    NotASocketError,
  );
  expect(await readFile(path, "utf8")).toBe("mine");
  expect((await stat(shared)).mode & 0o777).toBe(0o755);
  // A socket made in that folder is still its owner's alone.
  const socket = join(shared, "d.sock");
  await echo(socket);
  expect((await stat(socket)).mode & 0o777).toBe(0o600);
  expect((await stat(shared)).mode & 0o777).toBe(0o755);
});

test("the server's end of a hung-up connection ends", async () => {
  const path = join(dir, "d.sock");
  const ended: Promise<void>[] = [];
  const server = await listenUnix({
    path,
    onConnection: ({ stream }) => {
      ended.push(
        (async () => {
          const reader = stream.readable.getReader();
          while (!(await reader.read()).done);
        })(),
      );
    },
  });
  stops.push(server.close);
  const channel = await connectUnix(path);
  await Bun.sleep(20);
  channel.close();
  await Promise.race([
    ended[0],
    Bun.sleep(2_000).then(() => Promise.reject(new Error("never ended"))),
  ]);
});

test("the stdio bridge copies bytes to the daemon and back", async () => {
  const path = join(dir, "d.sock");
  await echo(path);
  const line = (n: number) => `{"jsonrpc":"2.0","method":"_test/n","params":{"n":${n}}}\n`;
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const output: string[] = [];
  const done = bridgeStdio(path, {
    stdin: input.readable,
    stdout: new WritableStream({
      write: (chunk) => void output.push(new TextDecoder().decode(chunk)),
    }),
  });
  const writer = input.writable.getWriter();
  await writer.write(new TextEncoder().encode(line(1) + line(2)));
  const started = Date.now();
  while (!output.join("").includes('"n":2') && Date.now() - started < 2_000) await Bun.sleep(10);
  expect(output.join("")).toBe(line(1) + line(2));
  await writer.close();
  await done;
});

test("ssh reaches a command on the far side with ssh's own arguments", async () => {
  const path = join(dir, "d.sock");
  await echo(path);
  const ssh = await fakeSsh(dir);
  const bridge = new URL("./transport-bridge.ts", import.meta.url).pathname;
  const channel = sshChannel({
    host: "me@example",
    ssh: ssh.path,
    command: ["bun", bridge, path],
  });
  stops.push(channel.close);
  const message = { jsonrpc: "2.0", method: "_test/ping", params: { over: "ssh" } };
  expect(await roundTrip(channel, message)).toEqual(message as never);
  const [call] = (await Bun.file(ssh.calls).text()).trim().split("\n");
  expect(JSON.parse(call as string)).toEqual([
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=15",
    "--",
    "me@example",
    "bun",
    bridge,
    path,
  ]);
});
