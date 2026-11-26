import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopProjectsListResultSchema } from "@cycle/protocol";
import { ConfigError, loadConfig } from "../src/config.ts";
import { repoDisplayName } from "../src/projects.ts";
import { listen } from "../src/server.ts";

const dir = mkdtempSync(join(tmpdir(), "loop-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TOKENS = ["ghp_SECRETTOKEN_ONE_123", "glpat-SECRETTOKEN_TWO_456"];
const file = join(dir, "loop.json");
const write = (mode: number) => {
  writeFileSync(
    file,
    JSON.stringify({
      projects: [
        {
          name: "Cycle",
          projectKey: "CYC",
          repo: { url: "https://x-access-token:abc@github.com/clawdot/cycle.git", forge: "github" },
          token: TOKENS[0],
        },
        {
          name: "Docs",
          projectKey: "DOC",
          repo: { url: "git@gitlab.example.com:team/docs.git", forge: "gitlab" },
          token: TOKENS[1],
        },
      ],
    }),
  );
  chmodSync(file, mode);
};

const call = (socketPath: string, method: string): Promise<string> =>
  new Promise((resolve) => {
    const socket = connect(socketPath);
    socket.once("data", (data) => {
      socket.end();
      resolve(data.toString());
    });
    socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method })}\n`);
  });

describe("projects/list", () => {
  test("answers name, projectKey, repo display name and forge, and no token anywhere", async () => {
    write(0o600);
    const server = await listen(await loadConfig(file), join(dir, "loop.sock"));
    try {
      const raw = await call(join(dir, "loop.sock"), "projects/list");
      for (const token of TOKENS) expect(raw).not.toContain(token);
      expect(raw).not.toContain("x-access-token");
      expect(raw).not.toContain("github.com");
      const result = LoopProjectsListResultSchema.parse(JSON.parse(raw).result);
      expect(result.projects).toEqual([
        {
          name: "Cycle",
          projectKey: "CYC",
          repo: { displayName: "clawdot/cycle", forge: "github" },
        },
        { name: "Docs", projectKey: "DOC", repo: { displayName: "team/docs", forge: "gitlab" } },
      ]);
    } finally {
      server.close();
    }
  });

  test("an unknown method is -32601", async () => {
    write(0o600);
    const server = await listen(await loadConfig(file), join(dir, "loop2.sock"));
    try {
      expect(JSON.parse(await call(join(dir, "loop2.sock"), "nope")).error.code).toBe(-32601);
    } finally {
      server.close();
    }
  });
});

describe("config", () => {
  test("a file others can read is refused, and the reason names nothing", async () => {
    write(0o644);
    const error = await loadConfig(file).catch((e) => e);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.reason).toBe("config_mode");
    expect(String(error.message)).not.toContain(dir);
  });

  test("a missing file and a malformed one have their own reasons", async () => {
    expect((await loadConfig(join(dir, "none.json")).catch((e) => e)).reason).toBe(
      "config_missing",
    );
    writeFileSync(file, "{not json");
    chmodSync(file, 0o600);
    expect((await loadConfig(file).catch((e) => e)).reason).toBe("config_invalid");
  });
});

test("stateDir must be absolute and unique, /a and /a/ being the same", async () => {
  const project = (key: string, stateDir: string) => ({
    name: key,
    projectKey: key,
    repo: { url: "https://github.com/a/b", forge: "github" },
    token: "t",
    stateDir,
  });
  const check = async (projects: unknown[]) => {
    writeFileSync(file, JSON.stringify({ projects }));
    chmodSync(file, 0o600);
    return (await loadConfig(file).catch((e) => e)).reason;
  };
  expect(await check([project("A", "relative/dir")])).toBe("config_invalid");
  expect(await check([project("A", "/s/a"), project("B", "/s/a/")])).toBe("config_invalid");
  expect(await check([project("A", "/s/a"), project("B", "/s/b")])).toBeUndefined();
});

test("repoDisplayName takes owner/name from https, ssh and scp forms", () => {
  expect(repoDisplayName("https://u:p@github.com/a/b.git")).toBe("a/b");
  expect(repoDisplayName("ssh://git@host.example/a/b")).toBe("a/b");
  expect(repoDisplayName("git@host.example:a/b.git")).toBe("a/b");
});

test("an address that is not owner/name is never echoed, credentials included", () => {
  expect(repoDisplayName("https://ghp_secret@github.com")).toBe("repository");
  expect(repoDisplayName("https://ghp_secret@github.com/")).toBe("repository");
  expect(repoDisplayName("github.com")).toBe("repository");
});

test("a second server on a live socket is refused, and the first keeps it", async () => {
  write(0o600);
  const config = await loadConfig(file);
  const first = await listen(config, join(dir, "twice.sock"));
  try {
    await expect(listen(config, join(dir, "twice.sock"))).rejects.toThrow("already_running");
    expect(await call(join(dir, "twice.sock"), "projects/list")).toContain("CYC");
  } finally {
    first.close();
  }
});
