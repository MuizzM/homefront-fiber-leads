// ── "Put it on your home screen, turn on alerts" ────────────────────────────
//
// One card, three states, driven by what the device can actually do right now.
//
// On iPhone the two asks are ORDERED, not optional-and-parallel: web push only
// works from a home-screen install, and asking for permission in a Safari tab
// burns the single prompt iOS will ever show — permanently, until the app is
// deleted and reinstalled. So in a tab, this card teaches the install and does
// not offer a button that would poison the well.
//
// It also states WHY, in the rep's terms, because "enable notifications" with no
// reason gets declined by everyone who has ever been spammed: the whole value is
// hearing about a $50 challenge while it is still winnable.
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { useToast } from "@/hooks/use-toast";
import { Bell, BellRing, Loader2, Share, SquarePlus, X } from "lucide-react";
import { enablePush, pushReadiness, type PushReadiness } from "@/lib/pushNotifications";

const DISMISS_KEY = "hfs:push-card-dismissed";

export function PushSetupCard({ className }: { className?: string }) {
  const { toast } = useToast();
  const [readiness, setReadiness] = useState<PushReadiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
  });

  // Read on mount and again when the app is brought back to the foreground: a
  // rep who follows the install instructions returns as a STANDALONE app, and
  // the card has to notice and switch to the permission ask rather than still
  // telling them to install something they just installed.
  useEffect(() => {
    const read = () => setReadiness(pushReadiness());
    read();
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, []);

  if (!readiness || dismissed) return null;
  // Nothing to offer: already on, or the browser genuinely cannot do it.
  if (readiness.state === "granted" || readiness.state === "unsupported") return null;

  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* private mode */ }
  };

  const turnOn = async () => {
    setBusy(true);
    const ok = await enablePush();
    setBusy(false);
    if (ok) {
      toast({ title: "Alerts on", description: "You'll hear about SPIFFs and challenges while they're live." });
      setReadiness(pushReadiness());
    } else {
      toast({
        title: "Alerts stayed off",
        description: "You can turn them on later in your phone's settings for this app.",
      });
      setReadiness(pushReadiness());
    }
  };

  return (
    <div
      className={cn("relative overflow-hidden rounded-2xl border border-primary/30 bg-primary/[0.06] p-4", className)}
      data-testid="push-setup-card"
    >
      <button
        type="button" onClick={dismiss} aria-label="Dismiss"
        data-testid="push-setup-dismiss"
        className={cn("absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-lg text-muted-foreground hover:text-foreground", FOCUS)}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>

      <div className="flex items-start gap-3 pr-8">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary">
          {readiness.state === "needs_install"
            ? <SquarePlus className="h-5 w-5" aria-hidden="true" />
            : <BellRing className="h-5 w-5" aria-hidden="true" />}
        </div>

        <div className="min-w-0 flex-1">
          {readiness.state === "needs_install" ? (
            <>
              <p className="text-[13px] font-bold text-foreground">Add Homefront to your Home Screen</p>
              {/* The reason first. "So you don't miss a $50 challenge" is worth
                  more than any number of instructions. */}
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                It opens full-screen like a real app — and it's the only way iPhone will let us
                alert you when a SPIFF or a $50 challenge goes live.
              </p>
              <ol className="mt-2.5 flex flex-col gap-1.5 text-[13px] text-foreground" data-testid="push-ios-steps">
                <li className="flex items-center gap-2">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">1</span>
                  <span className="flex items-center gap-1">
                    Tap <Share className="h-3.5 w-3.5" aria-hidden="true" /> <strong>Share</strong> at the bottom
                  </span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">2</span>
                  <span>Scroll and tap <strong>Add to Home Screen</strong></span>
                </li>
                <li className="flex items-center gap-2">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">3</span>
                  <span>Open it from the new icon, then turn on alerts</span>
                </li>
              </ol>
            </>
          ) : readiness.state === "denied" ? (
            <>
              <p className="text-[13px] font-bold text-foreground">Alerts are blocked</p>
              {/* No button here on purpose: once denied, the browser will not
                  re-prompt, and a button that silently does nothing is worse
                  than no button. Say where the switch actually lives. */}
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                Your phone is blocking notifications for Homefront. Turn them back on in
                Settings → Notifications → Homefront, and you'll hear about live SPIFFs again.
              </p>
            </>
          ) : (
            <>
              <p className="text-[13px] font-bold text-foreground">Get told when there's money on the table</p>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                A ping when a SPIFF or a $50 challenge goes live, and when the team's closing.
                Nothing else — no spam, and never outside your shift.
              </p>
              <button
                type="button" onClick={turnOn} disabled={busy}
                data-testid="push-setup-enable"
                className={cn(
                  "mt-2.5 inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-60",
                  FOCUS,
                )}
              >
                {busy
                  ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  : <Bell className="h-4 w-4" aria-hidden="true" />}
                Turn on alerts
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
