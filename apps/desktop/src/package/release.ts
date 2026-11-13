// `bun run desktop:release-assets`: turns the app `bun run desktop:package` built into what a GitHub
// release carries for this platform, an archive and the manifest the updater reads. macOS only.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_FILE, type BuildInfo, packagedLayout } from "../shared/layout";
import { archiveName, manifestFor, manifestName } from "../shared/release";
import { BUILD_DIR } from "./package-app";

/** Where the two files go: `apps/desktop/build/release`. */
const OUT_DIR = join(BUILD_DIR, "release");

function releaseAssets(): { archive: string; manifest: string } {
  const layout = packagedLayout(process.platform, process.arch);
  if (process.platform !== "darwin" || !layout) {
    throw new Error("Release assets are made on macOS, where the updater runs.");
  }
  const app = join(BUILD_DIR, layout.root);
  const buildFile = join(app, layout.appPath, BUILD_FILE);
  if (!existsSync(buildFile))
    throw new Error(`${app} is not built. Run \`bun run desktop:package\`.`);
  const info = JSON.parse(readFileSync(buildFile, "utf8")) as BuildInfo;

  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const archive = join(OUT_DIR, archiveName(info.version, info.platform, info.arch));
  // As Finder compresses: the bundle itself at the top, with what its signature needs kept.
  const zipped = Bun.spawnSync(
    ["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", app, archive],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (!zipped.success) throw new Error(`Could not archive ${app}.`);

  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  const manifest = join(OUT_DIR, manifestName(info.platform, info.arch));
  const content = manifestFor(info, { sha256, size: statSync(archive).size });
  writeFileSync(manifest, `${JSON.stringify(content, null, 2)}\n`);
  return { archive, manifest };
}

try {
  console.log(JSON.stringify(releaseAssets()));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
