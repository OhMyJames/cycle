// Generates and installs the launchd plist (macOS) or systemd user unit (Linux) for `com.cycle.loop-supervisor` (CYC-484).

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";

export const LAUNCHD_LABEL = "com.cycle.loop-supervisor";
export const SYSTEMD_SERVICE = "cycle-loop-supervisor.service";

const DEFAULT_DARWIN_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

const xmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const renderLaunchdPlist = (input: {
  bunPath: string;
  entryPath: string;
  dataDir: string;
  logDir: string;
  pathEnv?: string;
  extraEnv?: Record<string, string>;
}): string => {
  const envEntries: [string, string][] = [
    ["PATH", input.pathEnv ?? DEFAULT_DARWIN_PATH],
    ...Object.entries(input.extraEnv ?? {}),
  ];
  const envXml = envEntries
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(input.bunPath)}</string>
    <string>${xmlEscape(input.entryPath)}</string>
    <string>--data-dir</string>
    <string>${xmlEscape(input.dataDir)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(input.logDir, "loop-supervisor.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(input.logDir, "loop-supervisor.err.log"))}</string>
</dict>
</plist>
`;
};

export const renderSystemdUnit = (input: {
  bunPath: string;
  entryPath: string;
  dataDir: string;
}): string => `[Unit]
Description=Cycle Loop Supervisor
After=network-online.target

[Service]
Type=simple
ExecStart=${input.bunPath} ${input.entryPath} --data-dir ${input.dataDir}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;

export const installServiceFiles = (input: {
  os: "darwin" | "linux";
  targetPath: string;
  bunPath: string;
  entryPath: string;
  dataDir: string;
  logDir: string;
  pathEnv?: string;
  extraEnv?: Record<string, string>;
}): { path: string; content: string } => {
  const content =
    input.os === "darwin"
      ? renderLaunchdPlist(input)
      : renderSystemdUnit({
          bunPath: input.bunPath,
          entryPath: input.entryPath,
          dataDir: input.dataDir,
        });
  mkdirSync(dirname(input.targetPath), { recursive: true, mode: 0o700 });
  mkdirSync(input.logDir, { recursive: true, mode: 0o700 });
  writeFileSync(input.targetPath, content, { mode: 0o600 });
  return { path: input.targetPath, content };
};

if (import.meta.main) {
  const arg = (name: string) => {
    const at = process.argv.indexOf(name);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const os = platform();
  if (os !== "darwin" && os !== "linux") {
    console.error(`supervisor install: unsupported OS ${os}`);
    process.exit(1);
  }
  const dataDir = arg("--data-dir") ?? process.env.CYCLE_HOME ?? join(homedir(), ".cycle");
  const entryPath = resolve(import.meta.dir, "main.ts");
  const targetPath =
    arg("--output") ??
    (os === "darwin"
      ? join(homedir(), "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`)
      : join(homedir(), ".config/systemd/user", SYSTEMD_SERVICE));
  const written = installServiceFiles({
    os,
    targetPath,
    bunPath: process.execPath,
    entryPath,
    dataDir,
    logDir: join(dataDir, "logs"),
  });
  console.log(`wrote ${written.path}`);
  if (os === "darwin") {
    console.log(`run: launchctl load -w ${written.path}`);
  } else {
    console.log(
      `run: systemctl --user daemon-reload && systemctl --user enable --now ${SYSTEMD_SERVICE}`,
    );
  }
}
