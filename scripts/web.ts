/**
 * Builds the page and runs the daemon serving it, for use from a browser.
 * The link it prints carries the connection token.
 */
const root = new URL("..", import.meta.url).pathname;
const build = Bun.spawnSync(["bun", "run", "build.ts"], {
  cwd: `${root}apps/desktop`,
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) process.exit(build.exitCode);

const daemon = Bun.spawn(["bun", "src/main.ts"], {
  cwd: `${root}apps/daemon`,
  env: { ...process.env, CYCLE_UI_DIR: `${root}apps/desktop/dist/renderer` },
  stdout: "pipe",
  stderr: "inherit",
});
const stop = () => daemon.kill();
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

const decoder = new TextDecoder();
for await (const chunk of daemon.stdout) {
  for (const line of decoder.decode(chunk).split("\n")) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line) as { type?: string; pageUrl?: string };
      if (message.type === "listening") console.log(`\nCycle is at ${message.pageUrl}\n`);
    } catch {
      console.log(line);
    }
  }
}
process.exit(await daemon.exited);
