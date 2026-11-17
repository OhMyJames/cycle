import { expect, test } from "bun:test";
import {
  backoffMs,
  checkInput,
  parseDaemonFile,
  parseHealth,
  parseRemotes,
  readArgs,
  sshReason,
  tunnelArgs,
  versionWarning,
} from "../src/remote/plan";

const remote = { id: "r1", name: "Box", target: "me@box.example" };

test("a target that ssh could take for an option or a second word is refused", () => {
  for (const target of ["-oProxyCommand=x", "a b", "a;b", "me@box\n", "", "$(id)", "a'b"]) {
    expect(checkInput({ name: "Box", target }).ok).toBe(false);
  }
  expect(checkInput({ name: "Box", target: "me@box.example" }).ok).toBe(true);
  expect(checkInput({ name: "Box", target: "prod-1" }).ok).toBe(true);
  expect(checkInput({ name: "Box", target: "me@[::1]" }).ok).toBe(true);
});

test("a name is required, and a folder is a plain path without parent steps", () => {
  expect(checkInput({ name: " ", target: "box" }).ok).toBe(false);
  expect(checkInput({ name: "a\x07b", target: "box" }).ok).toBe(false);
  for (const home of ["rel/path", "~/a b", "~/a;rm", "/x/../y", "~/", "/", "~/$HOME"]) {
    expect(checkInput({ name: "n", target: "box", home }).ok).toBe(false);
  }
  expect(checkInput({ name: " n ", target: "box", home: "~/.cycle/" })).toEqual({
    ok: true,
    value: { name: "n", target: "box", home: "~/.cycle" },
  });
  expect(checkInput({ name: "n", target: "box", home: "" })).toEqual({
    ok: true,
    value: { name: "n", target: "box" },
  });
});

test("the command lines never wait for a prompt, and put the target after the end of options", () => {
  const read = readArgs(remote);
  expect(read).toContain("BatchMode=yes");
  expect(read.slice(-3)).toEqual(["--", "me@box.example", "cat ~/.cycle-codex/daemon.json"]);
  expect(readArgs({ ...remote, home: "/srv/cycle" }).at(-1)).toBe("cat /srv/cycle/daemon.json");

  const tunnel = tunnelArgs(remote, 4747);
  expect(tunnel).toContain("BatchMode=yes");
  expect(tunnel).toContain("ExitOnForwardFailure=yes");
  expect(tunnel).toContain("ServerAliveInterval=15");
  expect(tunnel[tunnel.indexOf("-L") + 1]).toBe("127.0.0.1:4747:127.0.0.1:4747");
  expect(tunnel.slice(-2)).toEqual(["--", "me@box.example"]);
  expect(tunnel.join(" ")).not.toContain("StrictHostKeyChecking");
});

test("the daemon's file gives a port, a token and a version, or nothing", () => {
  const good = JSON.stringify({
    url: "ws://127.0.0.1:4747",
    pageUrl: "http://127.0.0.1:4747/#token=abc",
    token: "abc",
    pid: 12,
    version: "0.1.0",
  });
  expect(parseDaemonFile(good)).toEqual({ port: 4747, token: "abc", pid: 12, version: "0.1.0" });
  expect(parseDaemonFile("not json")).toBeUndefined();
  expect(parseDaemonFile(JSON.stringify({ pageUrl: "http://x/", token: "t" }))).toBeUndefined();
  expect(parseDaemonFile(good.replace("4747/#", "99999/#"))).toBeUndefined();
});

test("health is the daemon's own answer and a version warning needs two different versions", () => {
  expect(parseHealth('{"ok":true,"version":"0.1.0","harness":"codex"}')).toEqual({
    version: "0.1.0",
  });
  expect(parseHealth('{"ok":false,"version":"0.1.0"}')).toBeUndefined();
  expect(parseHealth("<html>")).toBeUndefined();
  expect(versionWarning(remote, "0.1.0", "0.1.0")).toBeUndefined();
  expect(versionWarning(remote, "0.1.0", undefined)).toBeUndefined();
  expect(versionWarning(remote, "0.1.0", "0.2.0")).toContain("0.1.0");
});

test("backoff doubles from one second and stops at thirty", () => {
  expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs)).toEqual([
    1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000,
  ]);
});

test("ssh's complaints become short reasons that tell the owner what to do", () => {
  expect(sshReason("Host key verification failed.", remote)).toContain("once in a terminal");
  expect(sshReason("me@box: Permission denied (publickey).", remote)).toContain("refused");
  expect(sshReason("bind [127.0.0.1]:4747: Address already in use", remote)).toContain("port");
  expect(sshReason("", remote)).toBe("ssh failed.");
  expect(sshReason(`\n${"x".repeat(500)}\nmore`, remote).length).toBeLessThan(140);
});

test("a stored list drops what would not be accepted now", () => {
  const text = JSON.stringify({
    remotes: [
      { id: "a", name: "A", target: "box" },
      { id: "b", name: "B", target: "-oEvil" },
      { name: "no id", target: "box" },
    ],
  });
  expect(parseRemotes(text)).toEqual([{ id: "a", name: "A", target: "box" }]);
  expect(parseRemotes("garbage")).toEqual([]);
});
