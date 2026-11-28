// `bun scripts/sign-mac.ts <folder>` (macOS, the daemon-release workflow): signs every program of a built daemon folder
// the way the app's signing does (`@electron/osx-sign` in apps/desktop/scripts/sign.ts): Developer ID, hardened runtime,
// a secure timestamp, and the same entitlements. Each program keeps the identifier it has in the app: the one its
// vendor gave it (Claude, Codex), else its file name. The keychain knows a program by identifier and team, so a daemon
// signed like this reads the logins the app's daemon stored without asking again (docs/daemon.md "自动更新", CYC-538).
//
// The identity is looked for in the keychain the workflow made (CYCLE_KEYCHAIN), as the app's signing does.
import { open, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/** What osx-sign gives a helper program by default; the daemon and the agents are Bun or Rust programs that need JIT. */
const ENTITLEMENTS = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.device.audio-input</key><true/>
  <key>com.apple.security.device.bluetooth</key><true/>
  <key>com.apple.security.device.camera</key><true/>
  <key>com.apple.security.device.print</key><true/>
  <key>com.apple.security.device.usb</key><true/>
  <key>com.apple.security.personal-information.location</key><true/>
  <key>com.apple.security.personal-information.photos-library</key><true/>
</dict>
</plist>
`;

const MACH_O = new Set([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xfeedface, 0xcefaedfe]);

const isMachO = async (path: string): Promise<boolean> => {
  const file = await open(path, "r");
  try {
    const { bytesRead, buffer } = await file.read(Buffer.alloc(4), 0, 4, 0);
    return bytesRead === 4 && MACH_O.has(buffer.readUInt32BE(0));
  } finally {
    await file.close();
  }
};

const machOsIn = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await machOsIn(path)));
    else if (entry.isFile() && (await isMachO(path))) out.push(path);
  }
  return out;
};

const codesign = (args: string[]): { code: number; err: string } => {
  const result = Bun.spawnSync(["/usr/bin/codesign", ...args], { stderr: "pipe", stdout: "pipe" });
  return { code: result.exitCode ?? 1, err: result.stderr.toString() };
};

/** The identifier a program keeps: its vendor's, when a vendor signed it, else its file name. */
export const identifierFor = (path: string, signature: string): string => {
  const team = /^TeamIdentifier=(.+)$/m.exec(signature)?.[1]?.trim();
  const identifier = /^Identifier=(.+)$/m.exec(signature)?.[1]?.trim();
  return team !== undefined && team !== "not set" && identifier !== undefined
    ? identifier
    : basename(path);
};

if (import.meta.main) {
  if (process.platform !== "darwin") throw new Error("Signing is for a macOS build.");
  const dir = Bun.argv[2];
  if (dir === undefined) throw new Error("bun scripts/sign-mac.ts <folder>");
  const keychain = process.env.CYCLE_KEYCHAIN?.trim();
  const entitlements = join(tmpdir(), `cycle-entitlements-${process.pid}.plist`);
  await writeFile(entitlements, ENTITLEMENTS);
  for (const program of await machOsIn(dir)) {
    const identifier = identifierFor(program, codesign(["-dv", program]).err);
    const signed = codesign([
      "--force",
      "--sign",
      "Developer ID Application",
      ...(keychain ? ["--keychain", keychain] : []),
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      entitlements,
      "--identifier",
      identifier,
      program,
    ]);
    if (signed.code !== 0) throw new Error(`codesign failed on ${program}: ${signed.err}`);
    const verified = codesign(["--verify", "--strict", program]);
    if (verified.code !== 0) throw new Error(`${program} does not verify: ${verified.err}`);
    console.log(`signed ${basename(program)} as ${identifier}`);
  }
}
