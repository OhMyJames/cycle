// `bun run desktop:release-sign`: gives the packaged app the Developer ID identity the release
// workflow imported, has Apple notarize it, and lets the notarizer staple the ticket. CI only.
import { notarize } from "@electron/notarize";
import { sign } from "@electron/osx-sign";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MAC_BUNDLE, packagedLayout } from "../shared/layout";
import { BUILD_DIR } from "./package-app";

if (process.platform !== "darwin" || !packagedLayout(process.platform, process.arch)) {
  throw new Error("Signing is for a macOS build.");
}

const app = join(BUILD_DIR, MAC_BUNDLE);
if (!existsSync(app)) throw new Error(`${app} is not built. Run \`bun run desktop:package\`.`);

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};

const key = required("APPLE_API_KEY_PATH");

await sign({
  app,
  platform: "darwin",
  ...(process.env["CYCLE_KEYCHAIN"] ? { keychain: process.env["CYCLE_KEYCHAIN"] } : {}),
});
await notarize({
  appPath: app,
  appleApiKey: key,
  appleApiKeyId: required("APPLE_API_KEY_ID"),
  appleApiIssuer: required("APPLE_API_ISSUER"),
});
console.log(JSON.stringify({ signed: app }));
