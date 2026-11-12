import { analyzeFile, checkPackage, checkPinnedVersions, checkTestFile } from "./lib/boundaries.ts";
import { checkTestPlacement, zoneOf } from "./lib/boundaries.ts";
import { checkDeferrals } from "./lib/deferrals.ts";
import {
  listPackageDirs,
  listTestFiles,
  readPackage,
  readRootManifest,
  readScripts,
} from "./lib/workspace.ts";

const dirs = await listPackageDirs();
const packages = await Promise.all(dirs.map(readPackage));
const scripts = await readScripts();
const codeFiles = [...packages.flatMap((pkg) => pkg.files), ...scripts];

const violations = [
  ...checkPinnedVersions("package.json", await readRootManifest()),
  ...checkTestPlacement(await listTestFiles()),
  ...packages.flatMap(checkPackage),
  ...codeFiles.flatMap(({ path, code }) =>
    checkDeferrals(code).map((message) => ({ where: path, message })),
  ),
  ...scripts.flatMap(({ path, code }) => {
    const zone = zoneOf(path.replace(/^scripts\//, ""));
    return zone === "source" ? [] : checkTestFile(path, zone, code, analyzeFile(path, code));
  }),
];

for (const { where, message } of violations) console.error(`${where}: ${message}`);

if (violations.length > 0) {
  console.error(`\n${violations.length} boundary violation(s)`);
  process.exit(1);
}

console.log(`boundaries ok (${packages.length} packages)`);
