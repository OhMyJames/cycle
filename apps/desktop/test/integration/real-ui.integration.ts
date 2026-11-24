// The app against a real model, in a browser: its built page in headless Chromium, driven with the browser's own mouse
// and keys; the daemon as the built executable, the Claude it ships, and a real answer (test/web/web-app.ts). Not in
// `bun run test:integration`: it spends a little of an account's quota. Run it with:
//
//   bun run build            (at the root: the daemon's executable and the desktop page)
//   CYCLE_REAL_MODEL_TOKEN=<oauth token> bun run test:real      (in apps/desktop)
//
// The token goes to the daemon's config.json in a temporary directory, which is where a user puts it; from there only
// the Claude process gets it. Not the app, not the page. The model is CYCLE_REAL_MODEL, else haiku.
// To look at what the page showed at the end: SHOT_TO=/some/where.png
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { built, startWebApp, until } from "../web/web-app.ts";

const token = process.env.CYCLE_REAL_MODEL_TOKEN;
const bin = new URL(
  `../../../daemon/dist/cycle-${process.platform}-${process.arch}/cycle`,
  import.meta.url,
).pathname;
const enabled = built && token !== undefined && token !== "" && existsSync(bin);

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cv1-realui-"));
});
afterAll(() => rm(root, { recursive: true, force: true }));

test.skipIf(!enabled)(
  "a person uses the app with a real model: a streamed answer, a permission, a plan, and history after a reload",
  async () => {
    const data = join(root, "data");
    const home = join(root, "home");
    const cwd = join(root, "work");
    await Bun.write(join(cwd, ".keep"), "");
    await Bun.write(
      join(data, "config.json"),
      JSON.stringify({ claude: { env: { CLAUDE_CODE_OAUTH_TOKEN: token as string } } }),
    );
    const app = await startWebApp({
      root,
      daemon: [bin],
      data,
      socket: join(root, "d.sock"),
      env: { PATH: process.env.PATH ?? "", HOME: home },
      folder: cwd,
    });
    const { page } = app;
    const box = page.locator('[data-slot="composer"] [data-slot="composer-input"]');
    const composerButton = (name: string) =>
      page.locator('[data-slot="composer"]').getByRole("button", { name, exact: true });
    // What the agent said, not what the person typed: the prompt itself may contain the word. Without regard to case.
    const agentSaid = () =>
      page
        .locator('[data-slot="message"][data-role="agent"]')
        .allTextContents()
        .then((t) => t.join(" ").toLowerCase());
    /** Sends a message and waits for its turn to start and to end. */
    const ask = async (words: string, ms = 90_000) => {
      await box.click();
      await page.keyboard.type(words);
      await page.keyboard.press("Enter");
      await composerButton("Stop").waitFor({ timeout: 30_000 });
      await composerButton("Send").waitFor({ timeout: ms });
    };
    try {
      const newSession = page.getByRole("button", { name: "New session" }).first();
      await until(
        () => newSession.isEnabled(),
        (v) => v === true,
        30_000,
      );
      // The mode that asks first (what follows answers a permission), and the cheapest model.
      const defaults = { mode: "default", model: process.env.CYCLE_REAL_MODEL ?? "haiku" };
      await page.evaluate(
        (d) =>
          (
            window as unknown as {
              cycle: { setAgentDefaults: (e: string, a: string, d: object) => Promise<void> };
            }
          ).cycle.setAgentDefaults("local", "claude", d),
        defaults,
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

      // A streamed answer. The first message asks about the folder first.
      await box.click();
      await page.keyboard.type("Reply with exactly one word: pong");
      await page.keyboard.press("Enter");
      await page.getByRole("dialog").getByRole("button", { name: "Trust and start" }).click();
      await until(agentSaid, (v) => v.includes("pong"), 60_000);
      await composerButton("Send").waitFor({ timeout: 60_000 });

      // A tool that needs asking: the card, a click, and the tool really ran.
      await box.click();
      await page.keyboard.type(
        "Use the Bash tool to run exactly: touch made-by-the-agent.txt  Then say: finished",
      );
      await page.keyboard.press("Enter");
      const card = page.locator('[data-slot="permission"]');
      await card.waitFor({ timeout: 60_000 });
      expect(await card.textContent()).toContain("touch made-by-the-agent.txt");
      await card.getByRole("button", { name: "Allow", exact: true }).click();
      await until(agentSaid, (v) => v.includes("finished"), 60_000);
      await composerButton("Send").waitFor({ timeout: 60_000 });
      expect(existsSync(join(cwd, "made-by-the-agent.txt"))).toBe(true);

      // What a real model writes when asked for structure. Reported, not asserted: the model decides its shape.
      await ask(
        "Without using any tools, reply in markdown with: a level-2 heading, a bullet list of 3 items, a table of 2 columns and 2 rows, and a fenced python code block of about 12 lines defining a function with a docstring.",
      );
      const last = page.locator('[data-slot="message"][data-role="agent"]').last();
      console.log(
        "markdown",
        JSON.stringify({
          heading: await last.locator("h2").count(),
          list: await last.locator("li").count(),
          table: await last.locator("table").count(),
          pre: await last.locator("pre").count(),
        }),
      );

      // The ring under the input says how full the context is; a plan appears when Claude keeps a todo list.
      const usage = page.locator('[data-kind="context-meter"]:not([data-empty])');
      await usage.waitFor({ timeout: 10_000 });
      expect(await usage.locator('[data-slot="context-percent"]').textContent()).toMatch(/\d+%/);
      await ask(
        "Use your task tools (TaskCreate and TaskUpdate; load them with ToolSearch if needed) to create exactly two tasks, named first and second, then mark first completed. Then say: listed",
      );
      // The plan sits above the input while some of it is left to do; opened, it lists every task.
      const strip = page.locator('[data-kind="plan-strip"]');
      await strip.waitFor({ timeout: 10_000 });
      await strip.getByRole("button").first().click();
      const plan = (await strip.locator('[data-slot="plan"]').textContent()) ?? "";
      expect(plan).toContain("first");
      expect(plan).toContain("second");

      // The page reloads: it is given the session whole.
      await page.reload();
      await until(
        () => newSession.isEnabled(),
        (v) => v === true,
        30_000,
      );
      await page.getByRole("option").first().click();
      await until(agentSaid, (v) => v.includes("pong") && v.includes("finished"));
    } finally {
      const shot = join(root, "shot.png");
      await page.screenshot({ path: shot }).catch(() => {});
      if (process.env.SHOT_TO && existsSync(shot))
        await Bun.write(process.env.SHOT_TO, Bun.file(shot));
      await app.close();
      const pid = Number((await readFile(join(data, "daemon.pid"), "utf8").catch(() => "")).trim());
      if (pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    }
  },
  240_000,
);
