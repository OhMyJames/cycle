import { expect, test } from "bun:test";
import {
  type ConnectionPorts,
  type Tunnel,
  createRemoteConnection,
} from "../src/remote/connection";
import type { RemoteState } from "../src/shared/remote-state";

const remote = { id: "r1", name: "Box", target: "me@box" };
const file = JSON.stringify({
  pageUrl: "http://127.0.0.1:4747/#token=t1",
  token: "t1",
  pid: 1,
  version: "0.1.0",
});

function world(over: { free?: boolean; health?: string; local?: string } = {}) {
  const w = {
    tunnels: [] as { killed: boolean }[],
    shown: [] as string[],
    states: [] as RemoteState[],
  };
  const ports: ConnectionPorts = {
    ssh: {
      run: async () => ({ code: 0, stdout: file, stderr: "" }),
      tunnel: () => {
        const t = { killed: false };
        w.tunnels.push(t);
        return {
          exited: () => false,
          stderr: () => "",
          onExit: () => {},
          kill: () => {
            t.killed = true;
          },
        } satisfies Tunnel;
      },
    },
    fetch: async () => ({ status: 200, text: over.health ?? '{"ok":true,"version":"0.1.0"}' }),
    delay: async () => {},
    portFree: async () => over.free ?? true,
    localVersion: async () => over.local ?? "0.1.0",
    show: (url) => w.shown.push(url),
    onState: (s) => w.states.push(s),
  };
  return { w, connection: createRemoteConnection(ports) };
}

test("a test opens the tunnel, closes it, and shows and changes nothing", async () => {
  const { w, connection } = world();
  expect(await connection.test(remote)).toEqual({ ok: true, version: "0.1.0" });
  expect(w.tunnels.map((t) => t.killed)).toEqual([true]);
  expect(w.shown).toEqual([]);
  expect(w.states).toEqual([]);
  expect(connection.state()).toEqual({ status: "idle" });
});

test("a test carries the version warning and the reasons of a connection", async () => {
  const warned = await world({ local: "0.2.0" }).connection.test(remote);
  expect(warned).toMatchObject({ ok: true, version: "0.1.0" });
  expect(warned.ok && warned.warning).toBeTruthy();
  const busy = world({ free: false });
  expect(await busy.connection.test(remote)).toEqual({
    ok: false,
    reason: "Port 4747 is already used on this machine.",
  });
  expect(busy.w.tunnels).toEqual([]);
  expect(JSON.stringify(await world({ health: "x" }).connection.test(remote))).not.toContain("t1");
});

test("a test of the server the window is connected to leaves its tunnel alone", async () => {
  const { w, connection } = world();
  await connection.connect(remote);
  expect(await connection.test(remote)).toEqual({ ok: true, connected: true });
  expect(w.tunnels).toHaveLength(1);
  expect(w.tunnels[0]?.killed).toBe(false);
});
