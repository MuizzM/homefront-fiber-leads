// ── "Put Homefront on your home screen" — animated ──────────────────────────
//
// Text instructions for an iOS install have a bad hit rate: "tap Share, scroll,
// tap Add to Home Screen" describes three taps in a sheet the rep has to
// recognise first, and the Share glyph is the one iOS control nobody can name.
// So this SHOWS it — a phone frame that plays the three taps on a loop and ends
// on the destination, the icon sitting on a home screen.
//
// Mobbin references for the pattern (Duolingo, Speak, Tolan, Liven all do the
// same thing for widgets): lead with the END STATE, not the steps. A rep who
// sees the icon land understands what they are being asked for before reading a
// word.
//
// ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────
//
// On iPhone, web push works ONLY from a home-screen install. This is not a
// nice-to-have — it is the gate on every notification the app will ever send a
// rep. Getting the install rate up IS getting the notification rate up.
//
// ── ANIMATION RULES ────────────────────────────────────────────────────────
//
// Pure CSS keyframes on transform/opacity — no JS timers, no layout thrash, and
// nothing that keeps React re-rendering while it plays. Under
// prefers-reduced-motion the whole thing freezes on the final frame, which is
// the most informative one: the icon already on the home screen.
//
// The keyframes live in index.css rather than a <style> tag in this file,
// because inlining them would mean dangerouslySetInnerHTML — reintroducing the
// only DOM injection sink in the codebase, which the security pass removed.
import { cn } from "@/lib/utils";
import { Share, Plus, Check } from "lucide-react";

/** The phone. Deliberately schematic rather than a screenshot: a screenshot
 *  goes stale with every iOS release and is unreadable at this size. */
function PhoneDemo() {
  return (
    <div
      className="hfs-a2hs relative mx-auto w-[132px] select-none"
      aria-hidden="true"
    >
      <div className="relative h-[210px] overflow-hidden rounded-[22px] border-[3px] border-foreground/25 bg-background shadow-sm">
        {/* notch */}
        <div className="mx-auto mt-1.5 h-1 w-8 rounded-full bg-foreground/20" />

        {/* Home-screen grid: the destination. */}
        <div className="mt-3 grid grid-cols-4 gap-1.5 px-2.5">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="aspect-square rounded-[6px] bg-foreground/[0.07]" />
          ))}
          <div className="relative aspect-square">
            <div data-anim="glow" className="absolute -inset-1 rounded-[9px] bg-primary/40 blur-[6px]" />
            <div
              data-anim="icon"
              className="relative grid h-full w-full place-items-center rounded-[6px] bg-primary text-primary-foreground shadow"
            >
              <span className="text-[9px] font-black leading-none">HF</span>
            </div>
          </div>
        </div>

        {/* Safari-ish bottom bar with the Share glyph pulsing. */}
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-around border-t border-foreground/10 bg-secondary/70 py-1.5">
          <div className="h-1.5 w-3 rounded bg-foreground/25" />
          <div data-anim="tap" className="text-primary">
            <Share className="h-3.5 w-3.5" />
          </div>
          <div className="h-1.5 w-3 rounded bg-foreground/25" />
        </div>

        {/* The share sheet sliding up, with the target row highlighting. */}
        <div
          data-anim="sheet"
          className="absolute inset-x-0 bottom-0 rounded-t-xl border-t border-border bg-card px-2 pb-2 pt-1.5 shadow-lg"
        >
          <div className="mx-auto mb-1.5 h-0.5 w-6 rounded-full bg-foreground/25" />
          <div className="h-3 rounded bg-foreground/[0.06]" />
          <div
            data-anim="row"
            className="mt-1 flex items-center gap-1 rounded px-1 py-1"
          >
            <Plus className="h-2.5 w-2.5 text-foreground/70" />
            <span className="text-[7px] font-semibold leading-none text-foreground/80">Add to Home Screen</span>
          </div>
          <div className="mt-1 h-3 rounded bg-foreground/[0.06]" />
        </div>
      </div>
    </div>
  );
}

const STEPS = [
  { icon: Share, text: <>Tap <strong>Share</strong> at the bottom of Safari</> },
  { icon: Plus, text: <>Scroll and tap <strong>Add to Home Screen</strong></> },
  { icon: Check, text: <>Open it from the new icon — then turn on alerts</> },
];

export function AddToHomeScreen({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col gap-3", className)} data-testid="a2hs-guide">
      <PhoneDemo />
      <ol className="flex flex-col gap-2" data-testid="a2hs-steps">
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          return (
            <li key={i} className="flex items-start gap-2.5 text-[13px] text-foreground">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/15 text-[11px] font-bold text-primary">
                {i + 1}
              </span>
              <span className="flex items-center gap-1.5 leading-6">
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span>{s.text}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Compact variant for the setup card — the phone plus one line, no numbered
 *  list, for places where the full walkthrough would dominate the screen. */
export function AddToHomeScreenMini({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)} data-testid="a2hs-mini">
      <PhoneDemo />
      <p className="min-w-0 flex-1 text-[13px] text-muted-foreground">
        Tap <Share className="inline h-3.5 w-3.5 -translate-y-px" aria-hidden="true" />{" "}
        <strong className="text-foreground">Share</strong>, then{" "}
        <strong className="text-foreground">Add to Home Screen</strong>. Open it from the new
        icon and you'll get alerts when a SPIFF goes live.
      </p>
    </div>
  );
}
