import { expect, test } from "bun:test";
import {
  type ConnectionPorts,
  type Tunnel,
  createRemoteConnection,
} from "../src/remote/connection";
import type { RemoteState } from "../src/shared/remote-state";

const remote = { id: "r1", name: "Box", target: "me@box" };
const OK = { status: 200, text: '{"ok":true,"version":"0.1.0"}' };
const daemonFile = (token: string, port = 4747) =>
  JSON.stringify({
    url: `ws://127.0.0.1:${port}`,
    pageUrl: `http://127.0.0.1:${port}/#token=${token}`,
    token,
    pid: 1,
    version: "0.1.0",
  });

class FakeTunnel implements Tunnel {
  dead = false;
  killed = false;
  said = "";
  #listeners: (() => void)[] = [];
  exited = () => this.dead;
  stderr = () => this.said;
  onExit(listener: () => void) {
    this.#listeners.push(listener);
  }
  kill() {
    this.killed = true;
  }
  die(said = "") {
    this.dead = true;
    this.said = said;
    for (const l of this.#listeners) l();
  }
}

/** Lets every promise that can run, run. Nothing here waits on a clock. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 500; i++) await Promise.resolve();
};

function world() {
  const w = {
    token: "t1",
    readFails: undefined as string | undefined,
    health: OK as { status: number; text: string } | undefined,
    free: true,
    local: "0.1.0" as string | undefined,
    states: [] as RemoteState[],
    shown: [] as string[],
    tunnels: [] as FakeTunnel[],
    delays: [] as number[],
    healthCalls: 0,
    afterDelay: undefined as (() => void) | undefined,
  };
  const ports: ConnectionPorts = {
    ssh: {
      run: async () =>
        w.readFails !== undefined
          ? { code: 1, stdout: "", stderr: w.readFails }
          : { code: 0, stdout: daemonFile(w.token), stderr: "" },
      tunnel: () => {
        const tunnel = new FakeTunnel();
        w.tunnels.push(tunnel);
        return tunnel;
      },
    },
    fetch: async () => {
      w.healthCalls++;
      if (!w.health) throw new Error("refused");
      return w.health;
    },
    delay: async (ms) => {
      w.delays.push(ms);
      w.afterDelay?.();
    },
    portFree: async () => w.free,
    localVersion: async () => w.local,
    show: (url) => w.shown.push(url),
    onState: (state) => w.states.push(state),
  };
  return { w, connection: createRemoteConnection(ports) };
}

test("a daemon that answers is shown at its own port, with the token in the address only", async () => {
  const { w, connection } = world();
  await connection.connect(remote);
  expect(w.states.map((s) => s.status)).toEqual(["connecting", "connected"]);
  expect(w.shown).toEqual(["http://127.0.0.1:4747/#token=t1"]);
  expect(JSON.stringify(w.states)).not.toContain("t1");
});

test("a server with no daemon file, or no daemon behind the tunnel, is not running", async () => {
  const none = world();
  none.w.readFails = "cat: /home/me/.cycle-codex/daemon.json: No such file or directory";
  await none.connection.connect(remote);
  expect(none.connection.state()).toEqual({
    status: "failed",
    id: "r1",
    reason: "The daemon is not running on Box.",
  });

  const dead = world();
  dead.w.health = undefined;
  await dead.connection.connect(remote);
  expect(dead.connection.state()).toMatchObject({ status: "failed" });
  expect(dead.w.healthCalls).toBe(20);
  expect(dead.w.tunnels[0]?.killed).toBe(true);
  expect(dead.w.shown).toEqual([]);
});

test("a busy port is told before ssh is started", async () => {
  const { w, connection } = world();
  w.free = false;
  await connection.connect(remote);
  expect(connection.state()).toMatchObject({
    status: "failed",
    reason: "Port 4747 is already used on this machine.",
  });
  expect(w.tunnels).toHaveLength(0);
});

test("a tunnel that ssh ends before it answers gives ssh's reason", async () => {
  const { w, connection } = world();
  w.health = undefined;
  w.afterDelay = () => w.tunnels[0]?.die("Host key verification failed.");
  await connection.connect(remote);
  expect(JSON.stringify(connection.state())).toContain("once in a terminal");
  expect(w.tunnels[0]?.killed).toBe(true);
});

test("an answer that is not a daemon's is refused", async () => {
  const { w, connection } = world();
  w.health = { status: 200, text: "<html>" };
  await connection.connect(remote);
  expect(connection.state()).toMatchObject({ status: "failed" });
});

test("a different version is shown as a warning, and the connection stays", async () => {
  const { w, connection } = world();
  w.local = "0.2.0";
  await connection.connect(remote);
  const state = connection.state();
  expect(state.status).toBe("connected");
  expect(JSON.stringify(state)).toContain("0.2.0");
});

test("a tunnel that dies is made again with growing waits, and a new token reloads the page", async () => {
  const { w, connection } = world();
  await connection.connect(remote);
  w.health = undefined;
  w.afterDelay = () => {
    // After the third wait the daemon is back, started again with another token.
    if (w.delays.filter((ms) => ms >= 1000).length === 3) {
      w.health = OK;
      w.token = "t2";
    }
  };
  w.tunnels[0]?.die();
  await flush();
  expect(connection.state().status).toBe("connected");
  expect(w.delays.filter((ms) => ms >= 1000)).toEqual([1000, 2000, 4000]);
  expect(w.states.some((s) => s.status === "reconnecting" && s.attempt === 2)).toBe(true);
  expect(w.shown).toEqual(["http://127.0.0.1:4747/#token=t1", "http://127.0.0.1:4747/#token=t2"]);
});

test("a reconnect with the same token leaves the page where it is", async () => {
  const { w, connection } = world();
  await connection.connect(remote);
  w.tunnels[0]?.die();
  await flush();
  expect(connection.state().status).toBe("connected");
  expect(w.tunnels).toHaveLength(2);
  expect(w.shown).toHaveLength(1);
});

test("disconnecting closes the tunnel and ends any reconnecting", async () => {
  const { w, connection } = world();
  await connection.connect(remote);
  connection.disconnect();
  expect(w.tunnels[0]?.killed).toBe(true);
  expect(connection.state()).toEqual({ status: "idle" });
  w.tunnels[0]?.die();
  await flush();
  expect(w.tunnels).toHaveLength(1);
  expect(connection.state()).toEqual({ status: "idle" });
});
