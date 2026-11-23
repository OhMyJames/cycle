import { dirname, join } from "node:path";

/** Resolve the locked native package only in the source checkout. Compiled callers pass their sibling executable. */
export function vendorDirectory(): string {
  const pkg = Bun.resolveSync("@openai/codex/package.json", import.meta.dir);
  const platform = Bun.resolveSync(
    `@openai/codex-${process.platform}-${process.arch}/package.json`,
    dirname(pkg),
  );
  const cpu = process.arch === "arm64" ? "aarch64" : "x86_64";
  const os = process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl";
  return join(dirname(platform), "vendor", `${cpu}-${os}`);
}
export const nativeBinary = () => join(vendorDirectory(), "bin", "codex");
