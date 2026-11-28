/**
 * Which checks a change must pass, from the files it touches. Decided here, in code, not by a model (CYC-318):
 *  - always `bun run check`;
 *  - the interface (`packages/ui`, the desktop renderer): `bun run test:browser`;
 *  - the protocol, the daemon, the harnesses, the client, the desktop core: `bun run test:integration`.
 */
export const testLayers = (changedFiles: string[]): string[][] => {
  const touches = (test: (file: string) => boolean) => changedFiles.some(test);
  const layers: string[][] = [["bun", "run", "check"]];
  const rendererOrUi = (file: string) =>
    file.startsWith("packages/ui/") || file.startsWith("apps/desktop/src/renderer/");
  if (touches(rendererOrUi)) layers.push(["bun", "run", "test:browser"]);
  const core = (file: string) =>
    file === "docs/protocol.md" ||
    file.startsWith("packages/protocol/") ||
    file.startsWith("packages/client/") ||
    file.startsWith("packages/line-rpc/") ||
    file.startsWith("packages/command-permissions/") ||
    file.startsWith("apps/daemon/") ||
    file.startsWith("harness/") ||
    (file.startsWith("apps/desktop/") && !file.startsWith("apps/desktop/src/renderer/"));
  if (touches(core)) layers.push(["bun", "run", "test:integration"]);
  return layers;
};
