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
import { Loader2, X } from "lucide-react";
import { AddToHomeScreen } from "@/components/AddToHomeScreen";
import { enablePush, pushReadiness, type PushReadiness } from "@/lib/pushNotifications";

const DISMISS_KEY = "hfs:push-card-dismissed-until";

// A dismissal EXPIRES rather than being permanent.
//
// Permanent was the obvious choice and it is wrong here: this card is the only
// route to phone notifications, and on iPhone it is the only route to them
// existing at all. A rep who taps X on their first morning — before they have
// ever seen a $50 challenge go live — would be opted out forever, silently,
// with no way back that they would ever find.
//
// Three days is long enough that it does not nag, short enough that the rep who
// dismissed it in week one still gets asked once they have context.
const DISMISS_DAYS = 3;

function dismissedUntil(): number {
  try { return Number(localStorage.getItem(DISMISS_KEY) ?? 0) || 0; } catch { return 0; }
}

export function PushSetupCard({ className }: { className?: string }) {
  const { toast } = useToast();
  const [readiness, setReadiness] = useState<PushReadiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => Date.now() < dismissedUntil());

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
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_DAYS * 86_400_000));
    } catch { /* private mode — it simply reappears next load, which is fine */ }
  };

  const turnOn = async () => {
    setBusy(true);
    const ok = await enablePush();
    setBusy(false);
    if (ok) {
      toast({ title: "Alerts on", description: "You'll hear about bonuses and challenges while they're live." });
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
        

        <div className="min-w-0 flex-1">
          {readiness.state === "needs_install" ? (
            <>
              <p className="text-[13px] font-bold text-foreground">Add Homefront to your Home Screen</p>
              {/* The reason first. "So you don't miss a $50 challenge" is worth
                  more than any number of instructions. */}
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                It opens full-screen like a real app - and it's the only way iPhone will let us
                alert you when a bonus or a $50 challenge goes live.
              </p>
              {/* SHOWN, not described. "Tap Share, scroll, tap Add to Home
                  Screen" names three taps in a sheet the rep has to recognise
                  first, and the Share glyph is the one iOS control nobody can
                  name. The animation plays the taps and ends on the destination
                  - the icon sitting on a home screen. */}
              <AddToHomeScreen className="mt-3" />
            </>
          ) : readiness.state === "denied" ? (
            <>
              <p className="text-[13px] font-bold text-foreground">Alerts are blocked</p>
              {/* No button here on purpose: once denied, the browser will not
                  re-prompt, and a button that silently does nothing is worse
                  than no button. Say where the switch actually lives — which is
                  a different place on a phone install than in a desktop
                  browser, so the copy follows the platform. "HomeFront" matches
                  the manifest short_name, i.e. the label iOS Settings shows. */}
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                {readiness.isIOS
                  ? <>Your phone is blocking notifications for HomeFront. Turn them back on in
                      Settings &gt; Notifications &gt; HomeFront, and you'll hear about live bonuses again.</>
                  : <>This browser is blocking notifications for HomeFront. Allow notifications for
                      this site in your browser's site settings, and you'll hear about live bonuses again.</>}
              </p>
            </>
          ) : (
            <>
              <p className="text-[13px] font-bold text-foreground">Get told when there's money on the table</p>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                A ping when a bonus or a $50 challenge goes live, and when the team's closing.
                Nothing else - no spam, and never outside your shift.
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
                  : null}
                Turn on alerts
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
