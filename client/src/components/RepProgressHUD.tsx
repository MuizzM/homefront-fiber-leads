// ── Rep progress HUD ──────────────────────────────────────────────────────────
// Compact floating pill showing a rep's day at a glance. Stats are derived
// client-side from the map pins already in memory — no extra endpoint, so the
// numbers always match what the rep sees on the map. The parent flips `mini`
// on map movestart so the pill shrinks out of the way while panning.

import { useMemo } from "react";

export interface RepProgressHUDProps {
  pins: { leadStatus: string; visited?: boolean; lastKnockedAt?: string | null }[];
  mini: boolean;              // parent collapses on map movestart
  onToggle: () => void;
}

function Stat({ testid, value, label, valueClass }: {
  testid: string; value: number; label: string; valueClass?: string;
}) {
  return (
    <span data-testid={testid} className="flex items-baseline gap-1">
      <span className={`text-xs font-semibold tabular-nums ${valueClass ?? "text-foreground"}`}>
        {value}
      </span>
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </span>
  );
}

export function RepProgressHUD({ pins, mini, onToggle }: RepProgressHUDProps) {
  const stats = useMemo(() => {
    // "Today" is the rep's local midnight, not UTC — a 7am knock must not
    // vanish from the count because the server stores ISO/UTC timestamps.
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const mt = midnight.getTime();
    let knockedToday = 0, left = 0, sold = 0, followUps = 0;
    for (const p of pins) {
      if (p.lastKnockedAt) {
        const t = new Date(p.lastKnockedAt).getTime();
        if (Number.isFinite(t) && t >= mt) knockedToday++;
      }
      if (!p.visited) left++;
      if (p.leadStatus === "sold") sold++;
      if (p.leadStatus === "follow_up") followUps++;
    }
    return { knockedToday, left, sold, followUps };
  }, [pins]);

  if (mini) {
    return (
      <button
        type="button"
        data-testid="progress-hud-mini"
        onClick={onToggle}
        className="flex items-baseline gap-1 h-8 px-3 rounded-full bg-card/90 backdrop-blur-md border border-border shadow-lg whitespace-nowrap transition-[opacity,transform] duration-200 active:scale-95"
      >
        {stats.left === 0 ? (
          <span className="text-xs font-semibold text-emerald-400">Done ✓</span>
        ) : (
          <>
            <span className="text-xs font-bold tabular-nums text-foreground">{stats.left}</span>
            <span className="text-[10px] text-muted-foreground">left</span>
          </>
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      data-testid="progress-hud"
      onClick={onToggle}
      className="flex items-center gap-3 h-9 px-3.5 rounded-full bg-card/90 backdrop-blur-md border border-border shadow-lg whitespace-nowrap transition-[opacity,transform] duration-200"
    >
      {/* Four numbers, not five — "assigned" never changed a rep's next step.
          Effort pair | pipeline pair; "left" is the hero number in bold white so
          amber uniquely means follow-up everywhere (pins, buttons, HUD). */}
      <Stat testid="progress-stat-knocked" value={stats.knockedToday} label="knocked" />
      <Stat testid="progress-stat-left" value={stats.left} label="left" valueClass="text-foreground font-bold text-[13px]" />
      <span aria-hidden className="w-px h-3.5 bg-white/15" />
      <Stat testid="progress-stat-followups" value={stats.followUps} label="follow-ups" valueClass="text-[#fbbf24]" />
      <Stat testid="progress-stat-sold" value={stats.sold} label="sold" valueClass="text-[#34d399]" />
    </button>
  );
}

export default RepProgressHUD;
