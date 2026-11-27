// The app's contract with its page, as a hash (shared/ui-bundle.ts, `contractText`): taken from the source when the app is
// built, and kept in dist/contract.txt, where the app, run from source or installed, reads it from.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex } from "../src/main/ui-crypto.ts";
import { contractText } from "../src/shared/ui-bundle.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

export const CONTRACT_FILE = "contract.txt";

export const contractDigest = (root = ROOT): string => {
  const catalog = (
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      workspaces?: { catalog?: Record<string, string> };
    }
  ).workspaces?.catalog;
  // The version of the protocol SDK the API's types come from, whatever the package is called in the catalog.
  const sdk = Object.entries(catalog ?? {}).find(([name]) =>
    name.includes("agentclientprotocol"),
  )?.[1];
  if (sdk === undefined)
    throw new Error("The protocol SDK's version is not in the root package.json catalog.");
  return sha256Hex(
    new TextEncoder().encode(
      contractText(readFileSync(join(root, "packages/ui/src/api.ts"), "utf8"), sdk),
    ),
  );
};
