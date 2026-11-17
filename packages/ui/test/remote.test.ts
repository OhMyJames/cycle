import { expect, test } from "bun:test";
import type { RemoteServer, RemoteState } from "../src/client/host.ts";
import {
  UNREACHABLE,
  guard,
  remoteInput,
  serverStatus,
  serverTone,
  whereLabel,
} from "../src/lib/remote.ts";

const server: RemoteServer = { id: "a", name: "Build", target: "me@build" };
const view = (state: RemoteState) => ({ servers: [server], state, problem: null });

test("a rejected call is a short message, not the rejection", async () => {
  const done = await guard(() => Promise.reject(new Error("Error invoking remote method 'x'")));
  expect(done).toEqual({ ok: false, error: UNREACHABLE });
  expect(await guard(() => Promise.resolve(3))).toEqual({ ok: true, value: 3 });
  const refused = { ok: false as const, error: "No." };
  expect(await guard(() => Promise.resolve(refused))).toEqual(refused);
});

test("a form is trimmed, and an empty folder is left out", () => {
  expect(remoteInput({ id: null, name: " Build ", target: " me@build ", home: " " })).toEqual({
    name: "Build",
    target: "me@build",
  });
  expect(remoteInput({ id: null, name: "", target: "x", home: "" })).toBe(
    "Give the server a name.",
  );
  expect(typeof remoteInput({ id: null, name: "n", target: " ", home: "" })).toBe("string");
});

test("the window says where it is, and a server only its own state", () => {
  expect(whereLabel(null)).toBeNull();
  expect(whereLabel(view({ status: "idle" }))).toBeNull();
  expect(whereLabel(view({ status: "connected", id: "a" }))).toBe("Remote: Build");
  expect(whereLabel(view({ status: "failed", id: "a", reason: "x" }))).toBe(
    "Remote: Build (not connected)",
  );
  expect(whereLabel(view({ status: "connecting", id: "a" }))).toBe("Remote: Build (connecting)");
  const state: RemoteState = { status: "reconnecting", id: "a", attempt: 2 };
  expect(serverStatus(state, "a")).toBe("Connection lost. Trying again (2)…");
  expect(serverStatus(state, "b")).toBe("");
  expect(serverTone(state, "a")).toBe("waiting");
  expect(serverTone({ status: "connected", id: "a" }, "a")).toBe("ok");
  expect(serverTone({ status: "idle" }, "a")).toBeNull();
});
