// `bun run desktop:package`: builds the packaged app for this machine and says where it is.
import { packageApp } from "./package-app";

try {
  const { app, executable, info } = packageApp();
  console.log(JSON.stringify({ app, executable, ...info }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
