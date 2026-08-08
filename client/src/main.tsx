import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { registerServiceWorker } from "./lib/pwa";
import { installStaleChunkRecovery } from "./lib/staleChunk";

if (!window.location.hash) {
  window.location.hash = "#/";
}

// A deploy invalidates the running build's hashed chunk URLs; a failed route
// import reloads once into the new build instead of stranding the tab.
installStaleChunkRecovery();

createRoot(document.getElementById("root")!).render(<App />);

// PWA: installable, offline-shell, graceful update (prod only).
registerServiceWorker();
