import { App, CycleApp, daemonUrlFromPage } from "@cycle/ui";
import { createRoot } from "react-dom/client";
import "@cycle/ui/styles.css";

const root = document.querySelector("#root");
const url = daemonUrlFromPage();
if (root && url) {
  const app = new CycleApp(url);
  app.start();
  createRoot(root).render(<App app={app} />);
} else if (root) {
  root.textContent =
    "This page needs the link the Cycle daemon prints when it starts: it carries the connection token.";
}
