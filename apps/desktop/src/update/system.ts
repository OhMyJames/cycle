// What the updater does to the world: GitHub through Chromium's network stack, downloads under
// `CYCLE_HOME/updates`, and macOS's own tools on the bundles. macOS only.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { type IncomingMessage, net } from "electron";
import { type BuildInfo, MAC_BUNDLE } from "../shared/layout";
import {
  type BundleFacts,
  type Exec,
  type Headers,
  bundleOf,
  bundleProblem,
  findToken,
  swapPlan,
} from "./plan";
import type { UpdatePorts } from "./updater";

const ANSWER_TIMEOUT_MS = 30_000;
/** How long a download may go without a byte. */
const STALL_TIMEOUT_MS = 60_000;
const TOOL_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
/** What the swap helper said, the last time it ran. */
const SWAP_LOG = "install.log";

const run: Exec = (command, args, env) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { env: env as NodeJS.ProcessEnv, timeout: TOOL_TIMEOUT_MS },
      (error, stdout) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolve({ code: error ? Number(error.code) : 0, stdout });
      },
    );
  });

const succeeds = async (command: string, args: readonly string[]): Promise<boolean> =>
  run(command, args, process.env).then(
    ({ code }) => code === 0,
    () => false,
  );

const plistValue = async (bundle: string, key: string): Promise<string | undefined> =>
  run(
    "/usr/bin/plutil",
    ["-extract", key, "raw", path.join(bundle, "Contents", "Info.plist")],
    process.env,
  ).then(
    ({ code, stdout }) => (code === 0 ? stdout.trim() : undefined),
    () => undefined,
  );

const factsOf = async (bundle: string): Promise<BundleFacts> => ({
  identifier: await plistValue(bundle, "CFBundleIdentifier"),
  version: await plistValue(bundle, "CFBundleVersion"),
  signed: await succeeds("/usr/bin/codesign", ["--verify", "--deep", bundle]),
});

/**
 * Asks for a URL and follows where it is sent on, by hand: the headers, and so the token, go with a
 * redirect only while it stays on the host they were meant for. GitHub sends a download on to its
 * file storage, which must not see the token and refuses a request that carries one.
 */
function open(url: string, headers: Headers, hops = 0): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: "manual" });
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
    const timer = setTimeout(() => {
      request.abort();
      reject(new Error("GitHub did not answer in time."));
    }, ANSWER_TIMEOUT_MS);
    request.on("redirect", (_status, _method, redirectUrl) => {
      clearTimeout(timer);
      request.abort();
      const to = new URL(redirectUrl);
      if (hops >= MAX_REDIRECTS || to.protocol !== "https:") {
        reject(new Error("GitHub sent the request somewhere it is not followed."));
        return;
      }
      const { Authorization: _token, ...withoutToken } = headers;
      const sameHost = to.origin === new URL(url).origin;
      resolve(open(redirectUrl, sameHost ? headers : withoutToken, hops + 1));
    });
    request.on("response", (response) => {
      clearTimeout(timer);
      resolve(response);
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not reach GitHub: ${error.message}`));
    });
    request.end();
  });
}

/** Rejects when `response` goes quiet for too long, and with it whatever reads it. */
function stopWhenStalled(response: IncomingMessage): () => void {
  let timer: NodeJS.Timeout;
  const stall = (): void => {
    (response as unknown as NodeJS.ReadableStream & { destroy(error: Error): void }).destroy(
      new Error("The download stopped arriving."),
    );
  };
  const reset = (): void => {
    clearTimeout(timer);
    timer = setTimeout(stall, STALL_TIMEOUT_MS);
  };
  reset();
  response.on("data", reset);
  return () => clearTimeout(timer);
}

async function get(url: string, headers: Headers): Promise<{ status: number; text: string }> {
  const response = await open(url, headers);
  const done = stopWhenStalled(response);
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of response as unknown as AsyncIterable<Buffer>) chunks.push(chunk);
    return { status: response.statusCode, text: Buffer.concat(chunks).toString("utf8") };
  } finally {
    done();
  }
}

const bundleIn = (folder: string): string => path.join(folder, MAC_BUNDLE);

export type SystemOptions = {
  /** `CYCLE_HOME/updates`. */
  readonly updates: string;
  readonly info: BuildInfo;
  /** Electron's app path, inside the running bundle. */
  readonly appPath: string;
  /** The owner's login shell environment, where their token and `gh` are found. */
  readonly env: Readonly<Record<string, string | undefined>>;
  quit(): void;
  onState: UpdatePorts["onState"];
};

export function systemPorts(options: SystemOptions): UpdatePorts {
  const { updates, info, appPath, env } = options;
  const archiveOf = (version: string): string => path.join(updates, `${version}.zip`);
  const folderOf = (version: string): string => path.join(updates, version);
  const running = bundleOf(appPath);

  return {
    current: info.version,
    platform: info.platform,
    arch: info.arch,
    now: Date.now,
    token: () => findToken(env, run),
    get,

    async download(version, url, headers, onProgress) {
      const response = await open(url, headers);
      const status = response.statusCode;
      const body = response as unknown as NodeJS.ReadableStream;
      if (status !== 200) {
        body.resume();
        return { status, size: 0, sha256: "" };
      }
      mkdirSync(updates, { recursive: true, mode: 0o700 });
      const hash = createHash("sha256");
      let size = 0;
      const done = stopWhenStalled(response);
      response.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        size += chunk.length;
        onProgress(size);
      });
      try {
        await pipeline(body, createWriteStream(archiveOf(version), { mode: 0o600 }));
      } finally {
        done();
      }
      return { status, size, sha256: hash.digest("hex") };
    },

    async unpack(version) {
      // Under another name until it is whole, so a half-unpacked bundle is never taken for one.
      const unpacking = path.join(updates, `${version}.unpacking`);
      rmSync(unpacking, { recursive: true, force: true });
      rmSync(folderOf(version), { recursive: true, force: true });
      mkdirSync(unpacking, { recursive: true, mode: 0o700 });
      if (!(await succeeds("/usr/bin/ditto", ["-x", "-k", archiveOf(version), unpacking]))) {
        throw new Error("The download could not be unpacked.");
      }
      if (!existsSync(bundleIn(unpacking))) throw new Error(`The download holds no ${MAC_BUNDLE}.`);
      renameSync(unpacking, folderOf(version));
      return factsOf(bundleIn(folderOf(version)));
    },

    async inspect(version) {
      const bundle = bundleIn(folderOf(version));
      return existsSync(bundle) ? factsOf(bundle) : undefined;
    },

    async clean(keep) {
      if (!existsSync(updates)) return;
      for (const name of readdirSync(updates)) {
        if (name === SWAP_LOG || keep.includes(name)) continue;
        rmSync(path.join(updates, name), { recursive: true, force: true });
      }
    },

    async running() {
      let folderWritable = false;
      if (running) {
        try {
          accessSync(path.dirname(running), constants.W_OK);
          folderWritable = true;
        } catch {
          // A read-only volume, or a folder that is someone else's.
        }
      }
      return {
        bundle: running,
        identifier: running ? await plistValue(running, "CFBundleIdentifier") : undefined,
        folderWritable,
      };
    },

    async swap(version) {
      if (!running) throw new Error("This app is not running from a bundle.");
      const plan = swapPlan(running, process.pid);
      const staged = bundleIn(folderOf(version));
      rmSync(plan.next, { recursive: true, force: true });
      try {
        renameSync(staged, plan.next);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EXDEV")) throw error;
        // The app is on another volume than Cycle's home, so the bundle is copied there instead.
        const copied = await succeeds("/usr/bin/ditto", [staged, plan.next]);
        const problem = copied
          ? bundleProblem(await factsOf(plan.next), version)
          : "The update could not be copied beside the app.";
        if (problem) {
          rmSync(plan.next, { recursive: true, force: true });
          throw new Error(problem, { cause: error });
        }
      }
      const log = openSync(path.join(updates, SWAP_LOG), "w", 0o600);
      // Its own session, so it outlives the app it waits for.
      spawn(plan.command, [...plan.args], {
        detached: true,
        stdio: ["ignore", log, log],
        cwd: "/",
      }).unref();
      options.quit();
    },

    onState: options.onState,
  };
}
