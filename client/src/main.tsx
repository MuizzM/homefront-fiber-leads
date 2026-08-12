import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { registerServiceWorker } from "./lib/pwa";
import { installStaleChunkRecovery } from "./lib/staleChunk";
import { captureInstallPrompt } from "./lib/installPrompt";
import { installMapLibraryLoader } from "./lib/mapLibrary";

if (!window.location.hash) {
  window.location.hash = "#/";
}

// Before React renders: Chrome fires beforeinstallprompt once and early, and a
// listener added from inside a component reliably misses it.
captureInstallPrompt();

// Publishes window.__onMapboxReady/__loadMapbox before any map screen mounts.
// Installing the globals is free; the library itself is a lazy chunk that is
// only fetched on the first call, so non-map sessions still never pay for it.
installMapLibraryLoader();

// A deploy invalidates the running build's hashed chunk URLs; a failed route
// import reloads once into the new build instead of stranding the tab.
installStaleChunkRecovery();

createRoot(document.getElementById("root")!).render(<App />);

// PWA: installable, offline-shell, graceful update (prod only).
registerServiceWorker();
