// `bun run sign` (macOS, CI): gives the packaged app the Developer ID identity the release workflow
// imported, has Apple notarize it, and lets the notarizer staple the ticket.
//
// The identity is found by codesign in the keychain the workflow put in the search list. The App Store
// Connect API key is a file whose path is APPLE_API_KEY_PATH; its id and issuer are in the environment.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { notarize } from "@electron/notarize";
import { sign } from "@electron/osx-sign";
import { MAC_BUNDLE } from "../src/main/layout.ts";
import { BUILD_DIR } from "./package.ts";

if (process.platform !== "darwin") throw new Error("Signing is for a macOS build.");

const app = join(BUILD_DIR, MAC_BUNDLE);
if (!existsSync(app)) throw new Error(`${app} is not built. Run \`bun run package\`.`);

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};

// Inside out, hardened runtime, a secure timestamp, and osx-sign's default entitlements (which let
// the compiled daemon and Claude, both Bun executables, run under the hardened runtime).
await sign({ app, platform: "darwin" });
await notarize({
  appPath: app,
  appleApiKey: required("APPLE_API_KEY_PATH"),
  appleApiKeyId: required("APPLE_API_KEY_ID"),
  appleApiIssuer: required("APPLE_API_ISSUER"),
});
console.log(JSON.stringify({ signed: app }));
