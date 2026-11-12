import { createRoot } from "react-dom/client";
import { DEFAULT_DAEMON_PORT, WS_PATH } from "@cycle/protocol";
import { App } from "@cycle/ui";
import "@cycle/ui/styles.css";

// The main process passes the daemon endpoint in the URL; the fallback lets
// the same bundle run in a plain browser against a manually started daemon.
const daemonUrl =
  new URLSearchParams(location.search).get("daemon") ?? `ws://127.0.0.1:${DEFAULT_DAEMON_PORT}${WS_PATH}`;

createRoot(document.getElementById("root")!).render(<App daemonUrl={daemonUrl} />);
