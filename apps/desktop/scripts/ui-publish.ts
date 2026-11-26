// `bun run ui-publish` (the ui-release workflow): puts the bundle `ui-package` made on the repository's `ui-latest` release,
// and removes the bundles that are no longer needed. Written so that it is safe to run twice, and out of order:
//
//  - the archive goes up first, then the signature, then the manifest: the manifest is what an app reads to find the rest,
//    so it is the last thing to change;
//  - a bundle that is not newer than the one published for the same shell is not published (a run that waited its turn
//    for a newer commit's run must not put its older page over it);
//  - what is removed is the older archives of a shell (three are kept), and the bundles of a shell no recent release was
//    built with and that nobody has published for a week.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { RELEASE_REPO } from "../src/shared/release.ts";
import {
  parseManifest,
  UI_RELEASE_TAG,
  uiManifestName,
  uiSignatureName,
} from "../src/shared/ui-bundle.ts";
import { UI_OUT_DIR } from "./ui-package.ts";

export const KEEP_ARCHIVES = 3;
export const KEEP_UNUSED_SHELL_MS = 7 * 24 * 3600 * 1000;

export type Asset = { name: string; updatedAt: string };

const NAME = /^ui-([0-9a-f]{32})(?:\.json|\.json\.sig|-(\d+)\.zip)$/;

/** The names of the assets to remove: see the top of this file. */
export const assetsToDelete = (
  assets: readonly Asset[],
  options: { keepShells: ReadonlySet<string>; now: number },
): string[] => {
  const byShell = new Map<
    string,
    { name: string; updatedAt: number; version?: number; manifest: boolean }[]
  >();
  for (const asset of assets) {
    const match = NAME.exec(asset.name);
    if (match === null) continue;
    const shell = match[1] as string;
    const list = byShell.get(shell) ?? [];
    list.push({
      name: asset.name,
      updatedAt: Date.parse(asset.updatedAt),
      manifest: asset.name.endsWith(".json"),
      ...(match[2] !== undefined ? { version: Number(match[2]) } : {}),
    });
    byShell.set(shell, list);
  }
  const doomed: string[] = [];
  for (const [shell, list] of byShell) {
    const manifest = list.find((a) => a.manifest);
    const unused =
      !options.keepShells.has(shell) &&
      (manifest === undefined || options.now - manifest.updatedAt > KEEP_UNUSED_SHELL_MS);
    if (unused) {
      doomed.push(...list.map((a) => a.name));
      continue;
    }
    const archives = list
      .filter((a) => a.version !== undefined)
      .sort((a, b) => (b.version as number) - (a.version as number));
    doomed.push(...archives.slice(KEEP_ARCHIVES).map((a) => a.name));
  }
  return doomed;
};

export type Gh = (args: string[]) => Promise<string>;

export const publish = async (options: {
  gh: Gh;
  repo: string;
  outDir: string;
  /** The commit the release's tag is made at, the first time. */
  sha: string;
  now: number;
  log?: (message: string) => void;
}): Promise<{ published: boolean; deleted: string[] }> => {
  const { gh, repo, outDir } = options;
  const log = options.log ?? console.log;
  const tag = UI_RELEASE_TAG;
  const made = parseManifest(
    await readFile(join(outDir, (await findManifestName(outDir)) as string)),
  );
  if (made === undefined) throw new Error("The manifest to publish is not valid.");
  const { shell, uiVersion } = made;

  // A pre-release, and not the latest: it is not an app, and must not be what the repository shows as one.
  await gh(["release", "view", tag, "--repo", repo]).catch(() =>
    gh([
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--target",
      options.sha,
      "--prerelease",
      "--latest=false",
      "--title",
      "Interface bundles",
      "--notes",
      "Rolling: the pages the installed app can take without a new version (docs/desktop.md, Interface updates). Not an app.",
    ]),
  );

  const published = await gh([
    "release",
    "download",
    tag,
    "--repo",
    repo,
    "-p",
    uiManifestName(shell),
    "-O",
    "-",
  ])
    .then((text) => parseManifest(text)?.uiVersion ?? -1)
    .catch(() => -1);
  if (published >= uiVersion) {
    log(
      `Interface ${published} is already published for shell ${shell}; not publishing ${uiVersion}.`,
    );
    return { published: false, deleted: [] };
  }
  for (const file of [made.file, uiSignatureName(shell), uiManifestName(shell)])
    await gh(["release", "upload", tag, join(outDir, file), "--repo", repo, "--clobber"]);
  log(`Published interface ${uiVersion} for shell ${shell}.`);

  // The shells of the last three releases are in use by someone.
  const keep = new Set([shell]);
  const releases = JSON.parse(
    await gh([
      "release",
      "list",
      "--repo",
      repo,
      "--exclude-pre-releases",
      "--exclude-drafts",
      "--limit",
      "3",
      "--json",
      "tagName",
    ]),
  ) as { tagName: string }[];
  for (const { tagName } of releases) {
    const text = await gh([
      "release",
      "download",
      tagName,
      "--repo",
      repo,
      "-p",
      "latest-darwin-arm64.json",
      "-O",
      "-",
    ]).catch(() => "");
    try {
      const value = (JSON.parse(text) as { shell?: unknown }).shell;
      if (typeof value === "string") keep.add(value);
    } catch {}
  }
  const assets = (
    JSON.parse(await gh(["release", "view", tag, "--repo", repo, "--json", "assets"])) as {
      assets: Asset[];
    }
  ).assets;
  const deleted = assetsToDelete(assets, { keepShells: keep, now: options.now });
  for (const name of deleted)
    await gh(["release", "delete-asset", tag, name, "--repo", repo, "--yes"]);
  if (deleted.length > 0) log(`Removed ${deleted.join(", ")}.`);
  return { published: true, deleted };
};

const findManifestName = async (outDir: string): Promise<string | undefined> => {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(outDir)).find((n) => /^ui-[0-9a-f]{32}\.json$/.test(n));
};

if (import.meta.main) {
  const gh: Gh = async (args) => {
    const result = Bun.spawnSync(["gh", ...args], { stderr: "pipe" });
    if (!result.success)
      throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr.toString()}`);
    return result.stdout.toString();
  };
  const result = await publish({
    gh,
    repo: process.env.GITHUB_REPOSITORY || RELEASE_REPO,
    outDir: UI_OUT_DIR,
    sha: process.env.GITHUB_SHA ?? "main",
    now: Date.now(),
  });
  console.log(JSON.stringify(result));
}
