/**
 * Proxy settings for the agent processes (CYC-296). A proxy address is not a secret, so the variables are in every
 * agent's default `allowEnv`. A daemon started from the GUI has no shell environment, and agy (Go) and the others do
 * not read macOS's system proxy, so when the daemon has none the system's is read once and handed on as variables.
 * What `config.json` names (`env`) wins, and so does a variable the daemon was started with.
 */

/** The variables a proxy is set with, both spellings: tools differ in which they read. */
export const PROXY_ENV_NAMES = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
  "no_proxy",
];

type Env = Record<string, string | undefined>;

const entry = (text: string, key: string): string | undefined =>
  new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "m").exec(text)?.[1];

/**
 * The proxy variables `scutil --proxy`'s output stands for. Only enabled proxies count. A SOCKS proxy becomes
 * `ALL_PROXY` (`socks5://`), the rest `http://`. The exceptions list becomes `NO_PROXY`; the `*.local` form macOS
 * writes is `.local` to the tools that read the variable.
 */
export const parseScutilProxy = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const url = (scheme: string, kind: string): string | undefined => {
    if (entry(text, `${kind}Enable`) !== "1") return undefined;
    const host = entry(text, `${kind}Proxy`);
    const port = entry(text, `${kind}Port`);
    if (host === undefined || host === "") return undefined;
    return `${scheme}://${host}${port === undefined ? "" : `:${port}`}`;
  };
  const https = url("http", "HTTPS");
  const http = url("http", "HTTP");
  const socks = url("socks5", "SOCKS");
  if (https) out.HTTPS_PROXY = https;
  if (http) out.HTTP_PROXY = http;
  if (socks) out.ALL_PROXY = socks;
  // Where a proxy is set only for one scheme, the other still goes through it: the same as a browser does.
  if (!out.HTTPS_PROXY && out.HTTP_PROXY) out.HTTPS_PROXY = out.HTTP_PROXY;
  if (!out.HTTP_PROXY && out.HTTPS_PROXY) out.HTTP_PROXY = out.HTTPS_PROXY;
  if (Object.keys(out).length === 0) return out;
  const list = /ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/.exec(text)?.[1];
  const hosts = [...(list ?? "").matchAll(/^\s*\d+\s*:\s*(.+?)\s*$/gm)].map((m) =>
    (m[1] ?? "").replace(/^\*\./, "."),
  );
  if (hosts.length > 0) out.NO_PROXY = hosts.join(",");
  return out;
};

let cached: { at: number; env: Record<string, string> } | undefined;
const CACHE_MS = 60_000;

/** The system proxy as variables; empty off macOS or when `scutil` fails. Read at most once a minute. */
export const systemProxyEnv = (): Record<string, string> => {
  if (process.platform !== "darwin") return {};
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.env;
  let env: Record<string, string> = {};
  try {
    const result = Bun.spawnSync(["/usr/sbin/scutil", "--proxy"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 2000,
    });
    if (result.exitCode === 0) env = parseScutilProxy(result.stdout.toString());
  } catch {
    // No scutil: no system proxy to hand on.
  }
  cached = { at: now, env };
  return env;
};

const spellings = (name: string): string[] => [name.toUpperCase(), name.toLowerCase()];

/**
 * The proxy variables to add to an agent's environment: the system's, for each one the agent's `allowEnv` lets
 * through and that neither the daemon's environment (`inherited`) nor `config.env` already sets in either spelling.
 * `system` is a parameter for tests.
 */
export const systemProxyFill = (
  allowEnv: readonly string[],
  inherited: Env,
  explicit: Record<string, string>,
  system: () => Record<string, string> = systemProxyEnv,
): Record<string, string> => {
  const allowed = new Set(allowEnv);
  const missing = ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"].filter(
    (name) =>
      spellings(name).some((s) => allowed.has(s)) &&
      !spellings(name).some((s) => inherited[s] !== undefined || explicit[s] !== undefined),
  );
  if (missing.length === 0) return {};
  const found = system();
  const out: Record<string, string> = {};
  for (const name of missing) {
    const value = found[name];
    if (value === undefined) continue;
    out[name] = value;
    out[name.toLowerCase()] = value;
  }
  return out;
};
