import { expect, test } from "bun:test";
import { type ConnectionPorts, createRemoteConnection } from "../src/remote/connection";

const remote = { id: "r1", name: "Box", target: "me@box" };
const daemonFile = (token: string) =>
  JSON.stringify({
    pageUrl: `http://127.0.0.1:4747/#token=${token}`,
    token,
    pid: 1,
    version: "0.1.0",
  });

/** Lets what is waiting on a resolved promise run. */
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

function world() {
  const w = {
    token: "t1",
    reads: 0,
    shown: [] as string[],
    tunnels: [] as { killed: boolean; leave(): void }[],
    pauses: [] as (() => void)[],
  };
  const ports: ConnectionPorts = {
    ssh: {
      run: async () => {
        w.reads++;
        return { code: 0, stdout: daemonFile(w.token), stderr: "" };
      },
      tunnel: () => {
        const listeners: (() => void)[] = [];
        const t = {
          killed: false,
          leave: () => {
            for (const listener of listeners) listener();
          },
        };
        w.tunnels.push(t);
        return {
          exited: () => false,
          stderr: () => "",
          onExit: (listener) => listeners.push(listener),
          kill: () => {
            t.killed = true;
            t.leave();
          },
        };
      },
    },
    fetch: async () => ({ status: 200, text: '{"ok":true,"version":"0.1.0"}' }),
    delay: async () => {},
    pause: () => new Promise<void>((resolve) => w.pauses.push(resolve)),
    portFree: async () => true,
    localVersion: async () => "0.1.0",
    show: (url) => w.shown.push(url),
    onState: () => {},
  };
  const wake = async () => {
    w.pauses.shift()?.();
    await settle();
  };
  return { w, wake, connection: createRemoteConnection(ports) };
}

test("a daemon that started again shows its page again with the new token", async () => {
  const { w, wake, connection } = world();
  await connection.connect(remote);
  expect(w.shown).toHaveLength(1);
  w.token = "t2";
  await wake();
  expect(w.tunnels[0]?.killed).toBe(true);
  expect(w.tunnels).toHaveLength(2);
  expect(w.shown).toHaveLength(2);
  expect(w.shown[1]).toContain("t2");
  expect(connection.state().status).toBe("connected");
});

test("a daemon file with the same token leaves the tunnel and the page alone", async () => {
  const { w, wake, connection } = world();
  await connection.connect(remote);
  await wake();
  await wake();
  expect(w.tunnels.map((t) => t.killed)).toEqual([false]);
  expect(w.shown).toHaveLength(1);
  expect(w.reads).toBe(3);
});

test("a connection that was let go is not looked at any more", async () => {
  const { w, wake, connection } = world();
  await connection.connect(remote);
  connection.disconnect();
  w.token = "t2";
  await wake();
  expect(w.reads).toBe(1);
  expect(w.shown).toHaveLength(1);
});
