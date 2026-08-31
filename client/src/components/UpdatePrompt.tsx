// ── Update prompt — graceful PWA deploy flow ──────────────────────────────────
// Listens for the service worker's "update ready" signal and offers a calm,
// one-tap reload. No nag: it appears only when a genuinely newer build is
// waiting, and dismiss hides it until the next deploy.

import { useEffect, useState } from "react";
import { applyUpdate } from "@/lib/pwa";
import { X } from "lucide-react";

export function UpdatePrompt() {
  const [ready, setReady] = useState(false);
  // Announced text is injected AFTER the live region exists in the DOM - a
  // region that appears already containing its message is silent on most
  // screen readers, which made the deploy notice invisible to them.
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    const on = () => setReady(true);
    window.addEventListener("hfs:update-ready", on);
    return () => window.removeEventListener("hfs:update-ready", on);
  }, []);
  useEffect(() => {
    if (!ready) { setAnnounced(""); return; }
    const t = setTimeout(() => setAnnounced("Update ready. Reload for the latest improvements."), 80);
    return () => clearTimeout(t);
  }, [ready]);

  if (!ready) return <span className="sr-only" aria-live="polite" />;
  return (
    <div
      role="region"
      aria-label="Software update available"
      data-testid="pwa-update-prompt"
      className="fixed inset-x-4 bottom-[calc(5.75rem+env(safe-area-inset-bottom))] z-raised flex items-center gap-2 rounded-2xl border border-border bg-card p-2 pl-3 shadow-xl md:inset-x-auto md:bottom-5 md:right-5 md:max-w-sm"
    >
      <span className="sr-only" aria-live="polite">{announced}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm-minus font-semibold text-foreground">Update ready</span>
        <span className="block text-2xs text-muted-foreground">Reload for the latest improvements.</span>
      </span>
      <button
        type="button"
        onClick={applyUpdate}
        className="inline-flex min-h-11 shrink-0 items-center rounded-xl bg-primary px-3.5 text-xs font-semibold text-primary-foreground transition-transform active:scale-95 md:min-h-9 md:rounded-lg"
      >
        Update
      </button>
      <button
        type="button"
        onClick={() => setReady(false)}
        aria-label="Dismiss update notification"
        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:h-9 md:w-9 md:rounded-lg"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export default UpdatePrompt;
