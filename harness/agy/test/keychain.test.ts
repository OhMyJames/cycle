import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgyDefinition } from "../../../apps/daemon/src/agy-agent.ts";
import { ConfigSchema } from "../../../apps/daemon/src/config.ts";
import {
  ensureKeychain,
  type KeychainCommandRunner,
  type KeychainLogger,
  keychainPathFor,
} from "../src/keychain.ts";

const tempDirs: string[] = [];
const makeTemp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

type RecordedCall = {
  command: readonly string[];
  env: Record<string, string>;
};

type LogEntry = {
  event: string;
  fields: Record<string, string | number | boolean | undefined | null> | undefined;
};

const makeLog = () => {
  const warnings: LogEntry[] = [];
  const log: KeychainLogger = {
    warn: (event, fields) => warnings.push({ event, fields }),
  };
  return { log, warnings };
};

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("ensureKeychain (CYC-327)", () => {
  test("does not run any command or touch the filesystem on non-darwin platforms", async () => {
    const root = makeTemp("cycle-agy-keychain-nondarwin-");
    const home = join(root, "agy-home");
    const calls: RecordedCall[] = [];
    const run: KeychainCommandRunner = async (command, { env }) => {
      calls.push({ command, env });
      return { code: 0, stdout: "", stderr: "" };
    };

    for (const platform of ["linux", "win32", "freebsd"] as const) {
      await ensureKeychain(home, { platform, run });
    }

    expect(calls).toEqual([]);
    expect(existsSync(join(home, "Library", "Keychains"))).toBe(false);
  });

  test("on darwin, does not recreate when login.keychain-db already exists and is the default keychain", async () => {
    const root = makeTemp("cycle-agy-keychain-existing-");
    const home = join(root, "agy-home");
    const keychainPath = keychainPathFor(home);
    mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
    writeFileSync(keychainPath, "placeholder-db");

    const calls: RecordedCall[] = [];
    const run: KeychainCommandRunner = async (command, { env }) => {
      calls.push({ command, env });
      if (command[1] === "default-keychain" && command.length === 2) {
        return { code: 0, stdout: `    "${keychainPath}"\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const { log, warnings } = makeLog();
    await ensureKeychain(home, { platform: "darwin", run, log });

    expect(warnings).toEqual([]);
    expect(calls.map((c) => c.command)).toEqual([
      ["/usr/bin/security", "default-keychain"],
      ["/usr/bin/security", "unlock-keychain", "-p", "", keychainPath],
    ]);
    expect(calls.some((c) => c.command.includes("create-keychain"))).toBe(false);
    expect(calls.some((c) => c.command.includes("-s"))).toBe(false);
    for (const call of calls) {
      expect(call.env.HOME).toBe(home);
      expect(call.env.HOME).not.toBe(process.env.HOME);
    }
  });

  test("on darwin, sets default and unlocks without recreating when the file exists but is not default", async () => {
    const root = makeTemp("cycle-agy-keychain-notdefault-");
    const home = join(root, "agy-home");
    const keychainPath = keychainPathFor(home);
    mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
    writeFileSync(keychainPath, "placeholder-db");

    const calls: RecordedCall[] = [];
    const run: KeychainCommandRunner = async (command, { env }) => {
      calls.push({ command, env });
      if (command[1] === "default-keychain" && command.length === 2) {
        return {
          code: 50,
          stdout: "",
          stderr: "security: SecKeychainCopyDefault: A default keychain could not be found.\n",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const { log, warnings } = makeLog();
    await ensureKeychain(home, { platform: "darwin", run, log });

    expect(warnings).toEqual([]);
    expect(calls.map((c) => c.command)).toEqual([
      ["/usr/bin/security", "default-keychain"],
      ["/usr/bin/security", "default-keychain", "-s", keychainPath],
      ["/usr/bin/security", "unlock-keychain", "-p", "", keychainPath],
    ]);
    expect(calls.some((c) => c.command.includes("create-keychain"))).toBe(false);
    for (const call of calls) {
      expect(call.env.HOME).toBe(home);
    }
  });

  test("on darwin, creates Library/Keychains and runs create, default-keychain -s, and unlock in order when missing", async () => {
    const root = makeTemp("cycle-agy-keychain-missing-");
    const home = join(root, "agy-home");
    const keychainPath = keychainPathFor(home);

    const calls: RecordedCall[] = [];
    const run: KeychainCommandRunner = async (command, { env }) => {
      calls.push({ command, env });
      return { code: 0, stdout: "", stderr: "" };
    };

    const { log, warnings } = makeLog();
    await ensureKeychain(home, { platform: "darwin", run, log });

    expect(warnings).toEqual([]);
    expect(existsSync(join(home, "Library", "Keychains"))).toBe(true);
    expect(statSync(join(home, "Library", "Keychains")).mode & 0o777).toBe(0o700);
    expect(calls.map((c) => c.command)).toEqual([
      ["/usr/bin/security", "create-keychain", "-p", "", keychainPath],
      ["/usr/bin/security", "default-keychain", "-s", keychainPath],
      ["/usr/bin/security", "unlock-keychain", "-p", "", keychainPath],
    ]);
    for (const call of calls) {
      expect(call.env.HOME).toBe(home);
      expect(call.env.HOME).not.toBe(process.env.HOME);
    }
  });

  test("never throws when any step returns a non-zero exit code or rejects, and logs without leaking output", async () => {
    // 1. Non-zero exit code at each step of the create -> default -> unlock sequence.
    for (const failAt of [0, 1, 2]) {
      const root = makeTemp(`cycle-agy-keychain-fail-code-${failAt}-`);
      const home = join(root, "agy-home");
      const { log, warnings } = makeLog();
      let step = 0;
      const run: KeychainCommandRunner = async () => {
        const current = step++;
        if (current === failAt) {
          return {
            code: 48,
            stdout: "sensitive-stdout-should-not-be-logged",
            stderr: "sensitive-stderr-should-not-be-logged",
          };
        }
        return { code: 0, stdout: "", stderr: "" };
      };

      await expect(ensureKeychain(home, { platform: "darwin", run, log })).resolves.toBeUndefined();
      expect(step).toBe(failAt + 1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.event).toBe("agy_keychain_failed");
      expect(JSON.stringify(warnings)).not.toContain("sensitive-stdout");
      expect(JSON.stringify(warnings)).not.toContain("sensitive-stderr");
    }

    // 2. Runner throws at each step of the create -> default -> unlock sequence.
    for (const failAt of [0, 1, 2]) {
      const root = makeTemp(`cycle-agy-keychain-fail-throw-${failAt}-`);
      const home = join(root, "agy-home");
      const { log, warnings } = makeLog();
      let step = 0;
      const run: KeychainCommandRunner = async () => {
        const current = step++;
        if (current === failAt) {
          throw new Error(`boom at ${current}`);
        }
        return { code: 0, stdout: "", stderr: "" };
      };

      await expect(ensureKeychain(home, { platform: "darwin", run, log })).resolves.toBeUndefined();
      expect(step).toBe(failAt + 1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.event).toBe("agy_keychain_failed");
    }

    // 3. Runner throws when reading default-keychain for an existing file.
    {
      const root = makeTemp("cycle-agy-keychain-existing-throw-");
      const home = join(root, "agy-home");
      mkdirSync(join(home, "Library", "Keychains"), { recursive: true });
      writeFileSync(keychainPathFor(home), "placeholder-db");
      const { log, warnings } = makeLog();
      await expect(
        ensureKeychain(home, {
          platform: "darwin",
          log,
          run: async () => {
            throw new Error("security ENOENT");
          },
        }),
      ).resolves.toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.fields?.step).toBe("default_keychain_read");
    }

    // 4. mkdir fails (regular file blocks Library directory).
    {
      const root = makeTemp("cycle-agy-keychain-mkdir-fail-");
      const home = join(root, "agy-home");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "Library"), "not-a-directory");
      const { log, warnings } = makeLog();
      let called = false;
      await expect(
        ensureKeychain(home, {
          platform: "darwin",
          log,
          run: async () => {
            called = true;
            return { code: 0, stdout: "", stderr: "" };
          },
        }),
      ).resolves.toBeUndefined();
      expect(called).toBe(false);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.fields?.step).toBe("mkdir");
    }
  });
});

describe("agy-agent launch integrates ensureKeychain (CYC-327)", () => {
  test("calls ensureKeychain with agy's isolated HOME before launching agy on darwin", async () => {
    const dataDir = makeTemp("cycle-agy-launch-keychain-");
    const hostHome = "/Users/real-host-user-must-not-be-used";
    const expectedHome = join(dataDir, "agy");
    const markerFile = join(dataDir, "adapter-started");

    const keychainHomes: string[] = [];
    const securityCalls: RecordedCall[] = [];
    let adapterAlreadyStartedDuringKeychain = false;

    const fakeRunner: KeychainCommandRunner = async (command, { env }) => {
      securityCalls.push({ command, env });
      return { code: 0, stdout: "", stderr: "" };
    };

    const def = createAgyDefinition(
      {
        config: ConfigSchema.parse({}),
        dataDir,
        inherited: { PATH: "/usr/bin:/bin", HOME: hostHome },
        self: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, "started")`,
        ],
      },
      {
        ensureKeychain: async (home, opts) => {
          adapterAlreadyStartedDuringKeychain = existsSync(markerFile);
          keychainHomes.push(home);
          await ensureKeychain(home, { ...opts, platform: "darwin", run: fakeRunner });
        },
      },
    );

    const launched = await def.launch({ sessionId: "test-session", sessionEnv: {} });
    try {
      expect(adapterAlreadyStartedDuringKeychain).toBe(false);
      expect(keychainHomes).toEqual([expectedHome]);
      expect(securityCalls.map((c) => c.command)).toEqual([
        ["/usr/bin/security", "create-keychain", "-p", "", keychainPathFor(expectedHome)],
        ["/usr/bin/security", "default-keychain", "-s", keychainPathFor(expectedHome)],
        ["/usr/bin/security", "unlock-keychain", "-p", "", keychainPathFor(expectedHome)],
      ]);
      for (const call of securityCalls) {
        expect(call.env.HOME).toBe(expectedHome);
        expect(call.env.HOME).not.toBe(hostHome);
      }
    } finally {
      launched.kill?.();
    }
  });

  test("passes custom config.agy.home to ensureKeychain and still launches when keychain setup fails", async () => {
    const dataDir = makeTemp("cycle-agy-launch-custom-");
    const customHome = join(dataDir, "custom-agy-home");
    const hostHome = "/Users/real-host-user-must-not-be-used";
    const seenHomes: string[] = [];

    const def = createAgyDefinition(
      {
        config: ConfigSchema.parse({ agy: { home: customHome } }),
        dataDir,
        inherited: { PATH: "/usr/bin:/bin", HOME: hostHome },
        self: [process.execPath, "-e", ""],
      },
      {
        ensureKeychain: async (home, opts) => {
          seenHomes.push(home);
          await ensureKeychain(home, {
            ...opts,
            platform: "darwin",
            run: async () => {
              throw new Error("security unavailable");
            },
          });
        },
      },
    );

    const launched = await def.launch({ sessionId: "test-session-2", sessionEnv: {} });
    try {
      expect(seenHomes).toEqual([customHome]);
      expect(launched.target).toBeDefined();
    } finally {
      launched.kill?.();
    }
  });
});
