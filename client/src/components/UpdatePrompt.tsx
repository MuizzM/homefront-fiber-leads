// ── Update prompt — graceful PWA deploy flow ──────────────────────────────────
// Listens for the service worker's "update ready" signal and offers a calm,
// one-tap reload. No nag: it appears only when a genuinely newer build is
// waiting, and dismiss hides it until the next deploy.

import { useEffect, useState } from "react";
import { applyUpdate } from "@/lib/pwa";

export function UpdatePrompt() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const on = () => setReady(true);
    window.addEventListener("hfs:update-ready", on);
    return () => window.removeEventListener("hfs:update-ready", on);
  }, []);

  if (!ready) return null;
  return (
    <div
      role="status"
      data-testid="pwa-update-prompt"
      className="fixed left-1/2 -translate-x-1/2 z-[60] flex items-center gap-3 rounded-full bg-card border border-border shadow-xl pl-4 pr-1.5 py-1.5"
      style={{ bottom: "calc(4.5rem + env(safe-area-inset-bottom))" }}
    >
      <span className="text-[13px] font-medium text-foreground">New version available</span>
      <button
        type="button"
        onClick={applyUpdate}
        className="h-8 px-3.5 rounded-full bg-primary text-white text-[12px] font-semibold active:scale-95 transition"
      >
        Update
      </button>
    </div>
  );
}

export default UpdatePrompt;
