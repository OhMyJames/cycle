// The app, for real, in a browser: its built page in headless Chromium, driven with the browser's own mouse and keys,
// and behind it the real ConnectionManager, the real daemon (started by `proxy`), the Claude adapter, the real Agent
// SDK and a mock API (test/web/web-app.ts). No window is opened, on any system, so it takes nobody's focus.
// Run with `bun run build` and then this file in apps/desktop, or `bun run test:integration web` at the root.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startMock,
  textReply,
  toolReply,
} from "../../../../harness/claude/test/integration/mock-anthropic.ts";
import { ensureHomeKeychain } from "../../../daemon/src/home-keychain.ts";
import { built, startWebApp, until } from "../web/web-app.ts";

const daemonMain = join(new URL("../..", import.meta.url).pathname, "../daemon/src/main.ts");

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cv1-web-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

/** The newest thing the user said, in a request to the model. */
const latestUserText = (body: unknown): string => {
  const messages = (
    (body as { messages?: { role: string; content: unknown }[] }).messages ?? []
  ).filter((m) => m.role === "user");
  const last = messages.at(-1)?.content;
  return typeof last === "string" ? last : JSON.stringify(last);
};

test.skipIf(!built)(
  "a person can use the app: connect, start a session, type and paste, chat, answer a permission, use a terminal, and reload",
  async () => {
    const mock = startMock((requests) => {
      const body = requests.at(-1)?.body;
      const text = latestUserText(body);
      if (JSON.stringify(body).includes("tool_result")) return textReply("All done.");
      if (text.includes("touch a file"))
        return toolReply("Bash", { command: "touch made-by-the-agent.txt" });
      return textReply("Hello from the mock.");
    });
    const data = join(root, "data");
    const home = join(root, "home");
    // Claude runs in this HOME and keeps its key with `security`: without a keychain, a window on the screen.
    ensureHomeKeychain(home);
    const cwd = join(root, "work");
    await Bun.write(join(cwd, ".keep"), "");
    await Bun.write(
      join(data, "config.json"),
      JSON.stringify({
        claude: {
          configDir: join(root, "claude"),
          env: { ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: "mock-key-not-real" },
        },
      }),
    );
    const app = await startWebApp({
      root,
      daemon: ["bun", daemonMain],
      data,
      socket: join(root, "d.sock"),
      env: { PATH: process.env.PATH ?? "", HOME: home },
      folder: cwd,
    });
    const { page } = app;
    const box = page.locator('[data-slot="composer"] [data-slot="composer-input"]');
    const agentSaid = () =>
      page
        .locator('[data-slot="message"][data-role="agent"]')
        .allTextContents()
        .then((t) => t.join(" "));
    const sendShown = () =>
      page.locator('[data-slot="composer"]').getByRole("button", { name: "Send" }).waitFor();
    try {
      // Connected: the button that starts a session is usable.
      const newSession = page.getByRole("button", { name: "New session" }).first();
      await until(
        () => newSession.isEnabled(),
        (v) => v === true,
        30_000,
      );
      // The mode that asks first, set the way Settings' session defaults set it: what follows answers a permission.
      await page.evaluate(() =>
        (
          window as unknown as {
            cycle: { setAgentDefaults: (e: string, a: string, d: object) => Promise<void> };
          }
        ).cycle.setAgentDefaults("local", "claude", { mode: "default" }),
      );

      // A blank conversation, whose folder is typed through its folder menu's "Enter a path…" (CYCL-55). Its session is
      // made by the first message.
      await newSession.click();
      await page.locator('[data-kind="blank-folder"]').click();
      await page.getByRole("menuitem", { name: "Enter a path…" }).click();
      const pathField = page.getByRole("dialog").locator("input");
      await until(
        () => pathField.evaluate((el) => el === document.activeElement),
        (v) => v,
      );
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.type(cwd);
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").waitFor({ state: "detached" });
      await page.locator('[data-kind="blank-folder"]:not([data-unset])').waitFor();
      await until(
        () => box.getAttribute("contenteditable"),
        (v) => v === "true",
      );

      // The box shows Markdown as it is typed, and leaves the characters of a file name alone.
      await box.click();
      await page.keyboard.type("a **bold** word, my_file.py and `code`");
      await box.locator("strong", { hasText: "bold" }).waitFor();
      await box.locator("code", { hasText: "code" }).waitFor();
      expect(await box.textContent()).toBe("a bold word, my_file.py and code");

      // Pasted text goes in as it was copied: its asterisks are the person's, not formatting nobody typed.
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.evaluate(() => navigator.clipboard.writeText("pasted **x** my_file.py"));
      await page.keyboard.press("ControlOrMeta+V");
      await until(
        () => box.textContent(),
        (v) => String(v).includes("pasted **x** my_file.py"),
      );
      // And is emptied again, from the keyboard.
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      await until(
        () => box.textContent(),
        (v) => v === "",
      );

      // A message; the folder nobody has decided on is asked about first (docs/protocol.md §8 "信任文件夹").
      await page.keyboard.type("Say hello.");
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").getByRole("button", { name: "Trust and start" }).click();
      await until(
        () => box.textContent(),
        (v) => v === "",
      );
      await until(agentSaid, (v) => String(v).includes("Hello from the mock"), 60_000);
      await sendShown();

      // A tool that needs asking: a card appears, a click answers it, and the tool really runs.
      await box.click();
      await page.keyboard.type("Now touch a file.");
      await page.keyboard.press("Enter");
      const card = page.locator('[data-slot="permission"]');
      await card.waitFor({ timeout: 60_000 });
      expect(await card.textContent()).toContain("touch made-by-the-agent.txt");
      await card.getByRole("button", { name: "Allow", exact: true }).click();
      await until(agentSaid, (v) => String(v).includes("All done"), 60_000);
      await card.waitFor({ state: "detached" });
      await sendShown();
      expect(existsSync(join(cwd, "made-by-the-agent.txt"))).toBe(true);

      // A terminal beside the session (CYCL-98): a real shell on the daemon's side, in the session's folder, that takes
      // what is typed and shows what it prints.
      const terminalText = () =>
        page
          .locator('[data-slot="terminal-screen"] .xterm-rows')
          .textContent()
          .catch(() => "");
      await page.getByRole("button", { name: "Show terminal" }).click();
      await page.getByRole("tab", { selected: true, name: /sh$/ }).waitFor();
      await until(
        () =>
          page.evaluate(
            () => document.activeElement?.closest('[data-slot="terminal-screen"]') != null,
          ),
        (v) => v,
      );
      await page.keyboard.type("echo cycle-$((6*7)); ls");
      await page.keyboard.press("Enter");
      await until(terminalText, (v) => String(v).includes("cycle-42"), 15_000);
      await until(terminalText, (v) => String(v).includes("made-by-the-agent.txt"));

      // The page reloads: it is given the session whole, not an empty one.
      await page.reload();
      await until(
        () => newSession.isEnabled(),
        (v) => v === true,
        30_000,
      );
      await page.getByRole("option").first().click();
      await until(agentSaid, (v) => String(v).includes("Hello from the mock"));
      await until(agentSaid, (v) => String(v).includes("All done"));
      // The terminal outlived the page: its tab is back, drawn from the daemon's screen. Delete on its tab ends it.
      await until(terminalText, (v) => String(v).includes("cycle-42"), 15_000);
      await page.getByRole("tab", { selected: true, name: /sh$/ }).focus();
      await page.keyboard.press("Delete");
      await page.locator('[data-slot="terminal"]').waitFor({ state: "detached" });

      // The look, chosen in Settings as a person does: the page's own media query says light, then dark. The language,
      // kept outside the page: after a reload the page's words are in it, without a restart.
      const dark = () => page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
      await page.locator('[data-slot="menu-trigger"][data-kind="account-menu"]').click();
      await page.getByRole("menuitem", { name: "Settings" }).click();
      await page.getByRole("tab", { name: "Appearance" }).click();
      await page.getByRole("radio", { name: "Light" }).click();
      await until(dark, (v) => v === false);
      await page.getByRole("radio", { name: "Dark" }).click();
      await until(dark, (v) => v === true);
      await page.getByRole("tab", { name: "General" }).click();
      await page.getByRole("combobox", { name: "Language" }).click();
      await page.getByRole("option", { name: "简体中文" }).click();
      await page.getByRole("heading", { name: "通用", level: 2 }).waitFor();
      await page.reload();
      await page.getByRole("button", { name: "搜索会话" }).waitFor();
      expect(await page.evaluate(() => document.documentElement.lang)).toBe("zh-CN");

      // The folder was trusted in the dialog: on record in the daemon, and where Claude looks for it.
      const trusted = JSON.parse(await readFile(join(data, "trust.json"), "utf8"));
      expect(Object.values(trusted.folders)).toEqual([true]);
      const claudeJson = JSON.parse(await readFile(join(root, "claude", ".claude.json"), "utf8"));
      expect(claudeJson.projects[cwd]?.hasTrustDialogAccepted).toBe(true);
    } finally {
      await page.screenshot({ path: join(root, "shot.png") }).catch(() => {});
      await app.close();
      const pid = Number((await readFile(join(data, "daemon.pid"), "utf8").catch(() => "")).trim());
      // It may be gone already, and a failure above must not be hidden behind this.
      if (pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
      mock.stop();
    }
  },
  120_000,
);

test.skipIf(!built)(
  "signed out, the app is the sign-in page and starts nothing; signed in, it connects; signed out, it is the page again",
  async () => {
    const base = join(root, "sign-in");
    const data = join(base, "data");
    const socket = join(base, "d.sock");
    ensureHomeKeychain(join(base, "home"));
    const app = await startWebApp({
      root: base,
      daemon: ["bun", daemonMain],
      data,
      socket,
      env: { PATH: process.env.PATH ?? "", HOME: join(base, "home") },
      signedOut: true,
    });
    const { page, idp } = app;
    try {
      const signIn = page.getByRole("button", { name: "Sign in with browser" });
      await signIn.waitFor({ timeout: 10_000 });
      // Nothing was connected: no daemon was started for this data directory.
      expect(existsSync(socket)).toBe(false);
      expect(await page.getByRole("button", { name: "New session" }).count()).toBe(0);
      // And main refuses what the app does while nobody is signed in, whatever the page asks.
      const refused = await page.evaluate(() =>
        (window as unknown as { cycle: { sessions: (id: string) => Promise<unknown> } }).cycle
          .sessions("local")
          .then(
            () => "answered",
            (error: Error) => error.message,
          ),
      );
      expect(refused).toContain("sign in");

      // The stand-in's browser goes through the sign-in and back to the callback.
      await signIn.click();
      const newSession = page.getByRole("button", { name: "New session" }).first();
      await until(
        () => newSession.isEnabled(),
        (v) => v === true,
        30_000,
      );
      expect(idp.stats.exchanged).toBe(1);
      expect(existsSync(socket)).toBe(true);
      // The page was never given a token: nothing of what the provider issued is in it.
      const html = await page.content();
      for (const { form } of idp.requests)
        for (const value of Object.values(form))
          if (value.length > 20) expect(html).not.toContain(value);

      // Settings → Sign out, confirmed: the sign-in page again, and the provider was told.
      await page.getByRole("button", { name: /account and settings$/ }).click();
      await page.getByRole("menuitem", { name: "Settings" }).click();
      await page.getByRole("button", { name: "Sign out" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Sign out" }).click();
      await page.getByRole("button", { name: "Sign in with browser" }).waitFor({ timeout: 10_000 });
      expect(idp.stats.revoked).toBe(1);
      // The daemon and what it has are as they were.
      expect(existsSync(socket)).toBe(true);
    } finally {
      await app.close();
      const pid = Number((await readFile(join(data, "daemon.pid"), "utf8").catch(() => "")).trim());
      if (pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    }
  },
  90_000,
);
