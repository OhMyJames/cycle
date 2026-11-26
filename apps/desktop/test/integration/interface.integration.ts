// An interface update, for real, with the Electron app run from the build in this folder (macOS): a bundle signed by a key
// of the test's own, served from this machine in place of the repository's `ui-latest` release, is taken, shown when
// asked, kept across a restart; and a bundle that does not draw itself, or was changed on disk, is not shown.
// Run from source, the app takes a key and an address from the environment (main.ts); an installed one cannot.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeUiBundle } from "../../scripts/ui-package.ts";
import { shellHash } from "../../src/main/ui-crypto.ts";
import { evaluate } from "./cdp.ts";
import { signedIn } from "./signed-in.ts";

const ready = process.platform === "darwin";
const DESKTOP = new URL("../..", import.meta.url).pathname;
const key = generateKeyPairSync("ed25519");
const spki = key.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const MARK = "interface-marker";

let root: string;
let released: Map<string, Uint8Array | string>;
let server: ReturnType<typeof Bun.serve>;
let shell = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cv1-interface-"));
  released = new Map();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const body = released.get(new URL(request.url).pathname.slice(1));
      return body === undefined
        ? new Response("no", { status: 404 })
        : new Response(body as BodyInit);
    },
  });
});
afterAll(async () => {
  await server?.stop(true);
  await rm(root, { recursive: true, force: true });
});

/** Publishes a bundle whose page carries `marker` (and, when `draws` is false, never draws). */
const publish = async (uiVersion: number, options: { draws: boolean }) => {
  const page = join(root, `page-${uiVersion}`);
  await cp(join(DESKTOP, "dist/renderer"), page, { recursive: true });
  const html = await readFile(join(page, "index.html"), "utf8");
  await writeFile(
    join(page, "index.html"),
    html.replace("</head>", `<meta name="${MARK}" content="${uiVersion}" /></head>`),
  );
  if (!options.draws) await writeFile(join(page, "renderer.js"), "// draws nothing\n");
  const made = await makeUiBundle({
    rendererDir: page,
    shell,
    uiVersion,
    keyId: "k1",
    outDir: join(root, `out-${uiVersion}`),
    zip: async (from, archive) => {
      const r = Bun.spawnSync([
        "/usr/bin/ditto",
        "-c",
        "-k",
        "--norsrc",
        "--noextattr",
        from,
        archive,
      ]);
      if (!r.success) throw new Error(r.stderr.toString());
    },
    signingKey: key.privateKey,
  });
  released.set(`ui-${shell}.json`, await readFile(made.manifestFile));
  released.set(`ui-${shell}.json.sig`, await readFile(made.signatureFile as string, "utf8"));
  released.set(made.manifest.file, await readFile(made.archive));
};

const until = async <T>(what: string, ms: number, probe: () => Promise<T | undefined>) => {
  const started = Date.now();
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
};

/** Starts the app on the data of this test, and runs `body` with a way to ask its page; the app is stopped after. */
const withApp = async (body: (ask: (expression: string) => Promise<unknown>) => Promise<void>) => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const sso = await signedIn(join(root, "electron"));
  const electron = (await import("electron")).default as unknown as string;
  const proc = Bun.spawn([electron, DESKTOP, "--disable-gpu", `--remote-debugging-port=${port}`], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: root,
      CYCLE_HOME: join(root, "data"),
      CYCLE_USER_DATA: join(root, "electron"),
      CYCLE_ANALYTICS: "off",
      CYCLE_TEST_HIDDEN_WINDOW: "1",
      CYCLE_UI_KEYS: JSON.stringify({ k1: spki }),
      CYCLE_UI_URL: `http://127.0.0.1:${server.port}/`,
      CYCLE_UI_BOOT_MS: "2500",
      ...sso.env,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const ask = (expression: string) => evaluate(port, expression);
  try {
    // The page is up when it can say which interface it is.
    await until("the page", 60_000, async () =>
      (await ask("typeof window.cycle?.interfaceState")) === "function" ? true : undefined,
    );
    await body(ask);
  } finally {
    proc.kill();
    await proc.exited;
    await sso.idp.close();
  }
};
const state = (ask: (e: string) => Promise<unknown>) =>
  ask("window.cycle.interfaceState()") as Promise<{
    bundled: number;
    running: number;
    ready?: number;
  }>;
const marker = (ask: (e: string) => Promise<unknown>) =>
  ask(`document.querySelector('meta[name="${MARK}"]')?.content ?? null`);

test.skipIf(!ready)(
  "a signed bundle is taken, shown on request and after a restart; one that does not draw, or was changed, is not shown",
  async () => {
    const build = Bun.spawnSync([process.execPath, "scripts/build.ts"], { cwd: DESKTOP });
    if (!build.success) throw new Error(build.stderr.toString());
    shell = shellHash(
      await readFile(join(DESKTOP, "dist/main.mjs")),
      await readFile(join(DESKTOP, "dist/preload.cjs")),
    );
    await publish(100_000, { draws: true });

    // 1. Taken in the background; the page showing does not change; Reload shows it, and what the person had stays.
    await withApp(async (ask) => {
      expect(await marker(ask)).toBeNull();
      await ask("localStorage.setItem('draft', 'half a sentence')");
      const seen = await until("the bundle to be taken", 60_000, async () => {
        const s = await state(ask);
        return s.ready === 100_000 ? s : undefined;
      });
      expect(seen.running).toBe(seen.bundled);
      expect(await marker(ask)).toBeNull();
      await ask("window.cycle.applyInterfaceUpdate()");
      await until("the new page", 30_000, async () =>
        (await marker(ask)) === "100000" ? true : undefined,
      );
      await until("the new page to draw", 30_000, async () =>
        (await ask("document.querySelector('#root')?.children.length")) ? true : undefined,
      );
      expect(await state(ask)).toMatchObject({ running: 100_000 });
      expect((await state(ask)).ready).toBeUndefined();
      expect(await ask("localStorage.getItem('draft')")).toBe("half a sentence");
    });

    // 2. Kept across a restart: the page of the bundle is the first one.
    await withApp(async (ask) => {
      expect(await marker(ask)).toBe("100000");
      expect((await state(ask)).running).toBe(100_000);
    });

    // 3. A newer bundle that draws nothing: shown on request, then given up after the time it had, and not shown again.
    await publish(100_001, { draws: false });
    await withApp(async (ask) => {
      await until("the second bundle", 60_000, async () =>
        (await state(ask)).ready === 100_001 ? true : undefined,
      );
      await ask("window.cycle.applyInterfaceUpdate()");
      await until("the fall back", 60_000, async () =>
        (await marker(ask)) === "100000" && (await state(ask)).running === 100_000
          ? true
          : undefined,
      );
      expect((await state(ask)).ready).toBeUndefined();
    });
    await withApp(async (ask) => {
      expect(await marker(ask)).toBe("100000");
    });

    // 4. A bundle changed on disk is not shown: the page the app came with is.
    await writeFile(join(root, "electron", "ui", "100000", "renderer.js"), "// changed\n");
    await withApp(async (ask) => {
      expect(await marker(ask)).toBeNull();
      expect(await state(ask)).toMatchObject({ running: 0, bundled: 0 });
    });
  },
  300_000,
);
