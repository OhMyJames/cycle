import { expect, test } from "bun:test";
import type { RemoteServer, RemoteState } from "../src/client/host.ts";
import {
  UNREACHABLE,
  guard,
  remoteInput,
  serverStatus,
  serverTone,
  runTest,
  testLine,
  whereLabel,
  isRemote,
  remoteWarning,
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
  // A failed or pending connection leaves the window on this computer: no badge.
  expect(whereLabel(view({ status: "failed", id: "a", reason: "x" }))).toBeNull();
  expect(whereLabel(view({ status: "connecting", id: "a" }))).toBeNull();
  expect(whereLabel(view({ status: "reconnecting", id: "a", attempt: 1 }))).toBe(
    "Remote: Build (reconnecting)",
  );
  const state: RemoteState = { status: "reconnecting", id: "a", attempt: 2 };
  expect(serverStatus(state, "a")).toBe("Connection lost. Trying again (2)…");
  expect(serverStatus(state, "b")).toBe("");
  expect(serverTone(state, "a")).toBe("waiting");
  expect(serverTone({ status: "connected", id: "a" }, "a")).toBe("ok");
  expect(serverTone({ status: "idle" }, "a")).toBeNull();
});

test("a window on a server is remote, and its version warning shows only while connected", () => {
  expect(isRemote(null)).toBe(false);
  expect(isRemote(view({ status: "idle" }))).toBe(false);
  expect(isRemote(view({ status: "connecting", id: "a" }))).toBe(false);
  expect(isRemote(view({ status: "connected", id: "a" }))).toBe(true);
  expect(isRemote(view({ status: "reconnecting", id: "a", attempt: 1 }))).toBe(true);
  expect(remoteWarning(view({ status: "connected", id: "a", warning: "Older." }))).toBe("Older.");
  expect(remoteWarning(view({ status: "connected", id: "a" }))).toBeNull();
  expect(remoteWarning(view({ status: "reconnecting", id: "a", attempt: 1 }))).toBeNull();
  expect(remoteWarning(null)).toBeNull();
});

test("a test result is a line, and a rejected test is a failed one", async () => {
  expect(testLine({ ok: true, version: "1.0.0" })).toEqual({
    tone: "ok",
    text: "Reachable, daemon 1.0.0.",
  });
  expect(testLine({ ok: true, connected: true }).text).toBe("Connected now.");
  expect(testLine({ ok: true, version: "1", warning: "Differs." }).text).toBe(
    "Reachable, daemon 1. Differs.",
  );
  expect(testLine({ ok: false, reason: "No." })).toEqual({ tone: "error", text: "No." });
  expect(await runTest(() => Promise.reject(new Error("ipc")))).toEqual({
    ok: false,
    reason: UNREACHABLE,
  });
});
