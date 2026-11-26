import type { CycleBridge } from "@cycle/ui";
import { App, StoreProvider } from "@cycle/ui/react";
import { AppStore } from "@cycle/ui/store";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";

declare global {
  interface Window {
    cycle: CycleBridge;
  }
}

// The page cannot ask Node for the platform; the user agent says it (the style of the title bar depends on it).
document.documentElement.dataset.platform = /Mac/.test(navigator.userAgent) ? "darwin" : "other";

/**
 * Tells main the page has drawn itself. A page that never says so (it did not load, or it fell over while drawing) is not
 * used again: main shows the one before, and in the end the page the app came with.
 */
function Booted() {
  useEffect(() => {
    void window.cycle.interfaceBooted().catch(() => undefined);
  }, []);
  return null;
}

const store = new AppStore(window.cycle);
const root = document.getElementById("root");
if (root === null) throw new Error("no #root");
createRoot(root).render(
  <StoreProvider store={store}>
    <App />
    <Booted />
  </StoreProvider>,
);
void store.start();
