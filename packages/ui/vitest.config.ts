// The interface's tests run in a real browser (Chromium, headless, through Playwright): real layout, focus, selection and
// key events, which happy-dom only imitated. `bun run test:browser`, and CI's browser job: not the pre-commit gate (see
// .agents/notes/2026-11-21-interface-tests-in-a-real-browser.md).
import { availableParallelism } from "node:os";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";
import { shard } from "./test/shard.ts";

export default defineConfig({
  test: {
    // BROWSER_SHARD=n/N: one part of them, for a CI job (test/shard.ts).
    include: shard(process.env.BROWSER_SHARD),
    // Most of a test's time is the browser answering (a real click is about 60 ms, a retried wait 50), and a run is
    // CPU-bound: on a 2-core machine two workers are all it can use, which is what CI plans for (the 2-core, 4 GB
    // target: 111 s for all of it in a container of that size on 2026-11-27, so CI splits it in three, see ci.yml).
    // A bigger machine uses its cores: half of them, up to six (35 s at six on 15 cores).
    maxWorkers:
      process.env.CI !== undefined ? 2 : Math.max(2, Math.min(6, availableParallelism() >> 1)),
    setupFiles: ["test/browser/setup.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      // The app's own window size (BrowserWindow in apps/desktop), not a phone's, which is Vitest's default.
      viewport: { width: 1200, height: 800 },
      instances: [{ browser: "chromium" }],
      // A failure leaves a picture of the page next to the report.
      screenshotFailures: true,
    },
  },
});
