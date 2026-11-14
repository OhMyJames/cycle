import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ClaudeHarness, sbxSandboxes } from "@cycle/harness-claude";
import { CodexHarness } from "@cycle/harness-codex";
import { DEFAULT_DAEMON_PORT } from "@cycle/protocol";
import { newToken } from "./auth.ts";
import { DAEMON_VERSION, startDaemon } from "./daemon.ts";
import { openProviders } from "./gateway.ts";
import { Harnesses } from "./harnesses.ts";
import { TOOLS_KEY_ENV, TOOLS_SERVER, startTools } from "./tools.ts";
import { diskFile } from "./store.ts";

interface DaemonFile {
  url: string;
  pageUrl: string;
  token: string;
  pid: number;
  version: string;
}

const env = process.env;
const home = env["CYCLE_HOME"] ?? join(homedir(), ".cycle-codex");
if (!isAbsolute(home)) {
  console.error("CYCLE_HOME must be an absolute path.");
  process.exit(2);
}
await mkdir(home, { recursive: true, mode: 0o700 });
const daemonFile = join(home, "daemon.json");

/** The first line of output: where this daemon, or the one already running, is. */
function ready(file: DaemonFile): void {
  console.log(JSON.stringify({ type: "listening", ...file }));
}

async function running(): Promise<DaemonFile | null> {
  try {
    const file = JSON.parse(await readFile(daemonFile, "utf8")) as DaemonFile;
    process.kill(file.pid, 0);
    const health = await fetch(new URL("/health", file.pageUrl), {
      signal: AbortSignal.timeout(1500),
    });
    return health.ok ? file : null;
  } catch {
    return null;
  }
}

// One daemon per home: a second start points at the first and leaves.
const existing = await running();
if (existing) {
  ready(existing);
  process.exit(0);
}

const bundledUi = resolve(import.meta.dir, "../../desktop/dist/renderer");
const uiDir = env["CYCLE_UI_DIR"] ?? (existsSync(join(bundledUi, "index.html")) ? bundledUi : null);
const config = env["CYCLE_CODEX_CONFIG"]
  ? (JSON.parse(env["CYCLE_CODEX_CONFIG"]) as Record<string, string | number | boolean>)
  : undefined;

const providers = await openProviders(
  diskFile(join(home, "providers.json")),
  newToken(),
  join(home, "provider-models.json"),
);

const tools = startTools(newToken());

const debug = env["CYCLE_DEBUG"];
const codex = new CodexHarness({
  tools: { name: TOOLS_SERVER, url: tools.url, keyEnv: TOOLS_KEY_ENV, key: tools.key },
  ...(config ? { config } : {}),
  ...(debug ? { onLog: (line: string) => console.error(`[codex] ${line}`) } : {}),
  provider: providers.provider,
});
// Claude Code runs beside codex when it is installed and starts; codex is the machine.
const claude = new ClaudeHarness({
  sandboxes: sbxSandboxes(),
  tools: { name: TOOLS_SERVER, url: tools.url, key: tools.key },
  ...(debug ? { onLog: (line: string) => console.error(`[claude] ${line}`) } : {}),
});

const daemon = await startDaemon({
  tools,
  harness: new Harnesses(codex, [claude], (line) => console.error(line)),
  providers: providers.store,
  home,
  port: Number(env["CYCLE_DAEMON_PORT"] ?? DEFAULT_DAEMON_PORT),
  ...(uiDir ? { uiDir } : {}),
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

const file: DaemonFile = {
  url: daemon.url,
  pageUrl: daemon.pageUrl,
  token: daemon.token,
  pid: process.pid,
  version: DAEMON_VERSION,
};
await writeFile(daemonFile, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
await chmod(daemonFile, 0o600);
ready(file);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await rm(daemonFile, { force: true });
  await daemon.stop();
  providers.stop();
  tools.stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
