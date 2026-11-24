import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgyProcess } from "../src/server.ts";

// agy has no way to take variables for its commands alone, so `agy acp` is started with the session's
// (docs/protocol.md §6 "环境"); its own settings win over them.
test("agy is started with the session's variables, and its own settings win over them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cycle-agy-env-"));
  try {
    const seen = join(dir, "env.txt");
    const executable = join(dir, "agy");
    await writeFile(executable, `#!/bin/sh\nenv > ${JSON.stringify(seen)}\n`, { mode: 0o700 });
    const exited = new Promise<void>((resolve) => {
      new AgyProcess(
        {
          env: { HOME: dir, PATH: "/usr/bin:/bin", SHARED: "agent" },
          sessionEnv: { DATABASE_URL: "postgres://db", SHARED: "session", HOME: "/elsewhere" },
          agyExecutable: executable,
        },
        { onNotification: () => {}, onRequest: async () => ({}), onExit: () => resolve() },
      );
    });
    await exited;
    const env = Object.fromEntries(
      (await readFile(seen, "utf8"))
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    expect(env.DATABASE_URL).toBe("postgres://db");
    expect(env.SHARED).toBe("agent");
    expect(env.HOME).toBe(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
