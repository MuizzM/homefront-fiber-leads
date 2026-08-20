// ── "Get the Homefront app" - the pre-auth install banner ───────────────────
//
// PushSetupCard already teaches the install, but it lives on Today, which a rep
// only reaches AFTER signing in. That is the wrong side of the door: the rep
// who most needs the install is the one standing in Safari on their first
// morning, and by the time they are past the OTP they are already looking for
// their next knock, not for a setup card.
//
// So the ask also sits on the login screen, where every unauthenticated load
// lands. Same reason, same walkthrough, different moment.
//
// ── WHAT IT OFFERS DEPENDS ON WHAT THE DEVICE CAN DO ───────────────────────
//
//   iPhone in a Safari tab  -> the Share-sheet walkthrough. Safari has no
//                              install API; instructions are the only path,
//                              and web push does not exist until it is done.
//   Chrome with a captured  -> a real Install button that opens the browser's
//   beforeinstallprompt        own dialog. One tap, no instructions.
//   anything else           -> nothing at all. Already installed, or there is
//                              no install path to offer, and a banner that
//                              cannot be acted on is just an obstacle over the
//                              sign-in form.
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { X } from "lucide-react";
import { AddToHomeScreen } from "@/components/AddToHomeScreen";
import { isIOS, isStandalone } from "@/lib/pushNotifications";
import { canPromptInstall, promptInstall, subscribeInstallPrompt } from "@/lib/installPrompt";

const DISMISS_KEY = "hfs:install-banner-dismissed-until";

// A dismissal EXPIRES, for the same reason PushSetupCard's does: this is the
// only route to notifications on iPhone, and a rep who taps "Not now" on their
// first morning - before they have ever seen a bonus go live - must not be
// opted out forever by a tap they made with no context.
//
// Seven days rather than PushSetupCard's three, because this one is unavoidable
// on the way in: it is seen on every signed-out load, so it earns a longer
// silence per dismissal.
const DISMISS_DAYS = 7;

function dismissedUntil(): number {
  try { return Number(localStorage.getItem(DISMISS_KEY) ?? 0) || 0; } catch { return 0; }
}

type Mode = "ios" | "prompt" | "none";

export function InstallAppBanner({ className }: { className?: string }) {
  const [dismissed, setDismissed] = useState(() => Date.now() < dismissedUntil());
  const [showSteps, setShowSteps] = useState(false);
  const [busy, setBusy] = useState(false);
  // null until the first effect runs: nothing renders during SSR/first paint,
  // so the banner can never flash in over the form and then vanish.
  const [mode, setMode] = useState<Mode | null>(null);

  useEffect(() => {
    const read = () => {
      if (isStandalone()) { setMode("none"); return; }   // already installed
      if (isIOS()) { setMode("ios"); return; }
      setMode(canPromptInstall() ? "prompt" : "none");
    };
    read();
    // Chrome can fire beforeinstallprompt after this component mounts, and a
    // rep who follows the iOS steps comes back STANDALONE - both have to move
    // the banner, so re-read on capture and on every foreground.
    const unsub = subscribeInstallPrompt(read);
    document.addEventListener("visibilitychange", read);
    return () => { unsub(); document.removeEventListener("visibilitychange", read); };
  }, []);

  if (mode === null || mode === "none" || dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_DAYS * 86_400_000));
    } catch { /* private mode - it reappears next load, which is fine */ }
  };

  const install = async () => {
    setBusy(true);
    const outcome = await promptInstall();
    setBusy(false);
    // Accepted: the appinstalled listener clears the banner on its own.
    // Dismissed: leave it up. Chrome will not re-fire immediately, so the
    // button now does nothing, which is why mode falls back to "none" on the
    // next read - the rep is not left tapping a dead control.
    if (outcome === "dismissed") dismiss();
  };

  return (
    <div
      className={cn(
        // pointer-events-none on the frame so the banner only intercepts taps
        // where the card actually is - the sign-in form stays fully reachable
        // in the gap beside it.
        "pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-3",
        className,
      )}
      style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
      data-testid="install-app-banner"
    >
      <div
        role="region"
        aria-label="Install the Homefront app"
        className="pointer-events-auto relative w-full max-w-sm rounded-2xl border border-border bg-card p-4 shadow-lg"
      >
        <button
          type="button" onClick={dismiss} aria-label="Dismiss"
          data-testid="install-banner-dismiss"
          className={cn(
            "absolute right-1 top-1 grid size-11 place-items-center rounded-lg text-muted-foreground hover:text-foreground",
            FOCUS,
          )}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>

        <div className="pr-8">
          <p className="text-[15px] font-bold text-foreground">Get the Homefront app</p>
          {/* The reason, in the rep's terms, before any instruction. On iPhone
              it is not a preference - notifications do not exist without it. */}
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {mode === "ios"
              ? "Required for iPhone to alert you when a bonus or a $50 challenge goes live."
              : "Opens full-screen like a real app, and lets us alert you when a bonus goes live."}
          </p>
        </div>

        {showSteps && <AddToHomeScreen className="mt-3.5" />}

        <div className="mt-3.5 flex gap-2">
          <button
            type="button" onClick={dismiss}
            data-testid="install-banner-not-now"
            className={cn(
              "min-h-[44px] flex-1 rounded-xl border border-border bg-background px-3 text-sm font-semibold text-foreground",
              FOCUS,
            )}
          >
            Not now
          </button>

          {mode === "ios" ? (
            <button
              type="button" onClick={() => setShowSteps(s => !s)}
              aria-expanded={showSteps}
              data-testid="install-banner-how"
              className={cn(
                "min-h-[44px] flex-1 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground",
                FOCUS,
              )}
            >
              {showSteps ? "Hide steps" : "How to install"}
            </button>
          ) : (
            <button
              type="button" onClick={install} disabled={busy}
              data-testid="install-banner-install"
              className={cn(
                "min-h-[44px] flex-1 rounded-xl bg-primary px-3 text-sm font-semibold text-primary-foreground disabled:opacity-60",
                FOCUS,
              )}
            >
              Install
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
