import { useState } from "react";
import { MapPin, Pause, Play, ShieldCheck } from "lucide-react";
import { useFieldTracking, trackingReasonLabel } from "@/lib/fieldTracking";

// ── What the rep sees ────────────────────────────────────────────────────────
//
// This is the transparency half of "on by default". The org does not have to
// ask a rep to opt in, but a rep must never have to wonder whether their
// employer is watching where they are. So:
//
//   - the disclosure is shown BEFORE the first fix is ever recorded, and must
//     be acknowledged; the server refuses to store anything until it is
//   - whenever tracking is running it says so, in words, unprompted
//   - when it is NOT running it says why, so "off shift" and "your company
//     switched this off" are never confused with a broken phone
//   - the retention window is stated in the disclosure, not buried in a policy
//     document nobody opens
//
// The pause control appears only where org policy allows it. Resuming is always
// possible, so a rep can never be trapped in a paused state.

export function TrackingIndicator({ className = "" }: { className?: string }) {
  const t = useFieldTracking();
  const [busy, setBusy] = useState(false);

  // Nothing to say when the org does not collect location at all. Showing a
  // "not tracking" chip to every rep in an org that never turned this on would
  // be noise about a thing that does not exist for them.
  if (t.reason === "policy-off") return null;

  if (t.needsDisclosure) {
    return (
      <div
        className={`rounded-2xl border border-border bg-card p-4 ${className}`}
        data-testid="tracking-disclosure"
      >
        <div className="flex items-start gap-2.5">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="text-[14px] font-bold text-foreground">Location while you are on shift</h3>
            <div className="mt-1.5 space-y-1.5 text-[13px] leading-snug text-muted-foreground">
              <p>
                While you are clocked in, this app shares your location with your
                manager so the team can be coordinated in the field.
              </p>
              <p>
                It records your position only between clocking in and clocking
                out. It does not record where you go off shift, and it stops
                when your shift ends.
              </p>
              <p>
                Positions are deleted after {t.retentionDays}{" "}
                {t.retentionDays === 1 ? "day" : "days"}.
                {t.canPause && " You can pause sharing at any time."}
              </p>
            </div>
            <button
              onClick={async () => { setBusy(true); try { await t.acknowledge(); } finally { setBusy(false); } }}
              disabled={busy}
              data-testid="tracking-acknowledge"
              className="mt-3 inline-flex min-h-tap items-center rounded-xl bg-primary px-4 text-[13px] font-semibold text-primary-foreground transition-opacity disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {busy ? "Saving…" : "I understand"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const running = t.active && !t.denied;

  return (
    <div
      className={`flex items-center gap-2.5 rounded-2xl border px-3.5 py-2.5 ${
        running ? "border-success/25 bg-success/10" : "border-border bg-card"
      } ${className}`}
      role="status"
      data-testid="tracking-indicator"
    >
      <MapPin
        className={`h-4 w-4 shrink-0 ${running ? "text-success" : "text-muted-foreground"}`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className={`text-[13px] font-semibold ${running ? "text-success" : "text-foreground"}`}>
          {t.denied ? "Location unavailable" : trackingReasonLabel(t.reason)}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {t.denied
            ? "Your device is not providing a location. Your manager sees this, not an old position."
            : running
              ? `Only while clocked in · deleted after ${t.retentionDays}d`
              : "Nothing is being recorded"}
          {t.queuedCount > 0 && ` · ${t.queuedCount} waiting to send`}
        </div>
      </div>
      {t.canPause && t.clockedIn && (
        <button
          onClick={async () => { setBusy(true); try { await t.setPaused(!t.paused); } finally { setBusy(false); } }}
          disabled={busy}
          data-testid="tracking-pause"
          aria-label={t.paused ? "Resume location sharing" : "Pause location sharing"}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-[12px] font-semibold text-foreground transition-colors hover:bg-secondary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          {t.paused ? "Resume" : "Pause"}
        </button>
      )}
    </div>
  );
}
