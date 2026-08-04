// ── The Live Slot: one urgent thing at a time ───────────────────────────────
//
// THE PROBLEM THIS EXISTS TO SOLVE, measured in the real Today.tsx:
//
// Five systems can each produce a card — momentum offers, campaigns, the knock
// ladder, door drops, and (next) challenges. Today.tsx renders four of them
// stacked, unconditionally. On a 390x740 phone that is ~440px of incentive
// cards below a ~85px greeting and a ~140px stat block: a rep with everything
// live sees nothing else without scrolling, and a screen that looks like a slot
// machine gets read like one — which is to say, not at all.
//
// So there is ONE slot. A resolver picks the single highest-priority live item;
// everything else collapses to a one-line "2 more active" chip that opens the
// SPIFF Center. That constraint is the whole design, and it is worth defending
// against every future "can we also show…".
//
// ── HOW IT RANKS ───────────────────────────────────────────────────────────
//
// Urgency divided by REACHABILITY. A deadline you can still hit outranks a
// bigger prize you cannot, and started-but-unfinished always wins — it is the
// only state where showing the card changes the outcome. A rep who has done 6
// of 10 doors will finish; a rep who has done 0 has already decided not to.
//
// PURE: no clock beyond the nowMs passed in, no database.

export type LiveKind = "challenge" | "momentum" | "campaign" | "ladder" | "drop";

export interface LiveItem {
  kind: LiveKind;
  /** Stable id for keying + dedupe. */
  id: string;
  /** What the rep reads. Already second-person and specific. */
  headline: string;
  /** What to do next. Empty once met. */
  nextStep: string;
  rewardCents: number;
  /** Epoch ms the thing closes; null when it has no deadline (the ladder). */
  endsAtMs: number | null;
  /** 0..100. */
  pct: number;
  /** True once the rep has done anything toward it. Drives the ranking. */
  started: boolean;
}

/** Lower sorts first. */
function rank(i: LiveItem, nowMs: number): number {
  switch (i.kind) {
    // Started and on a clock — the only state where a nudge changes anything.
    case "challenge": return i.started ? 0 : 3;
    // Momentum is measured in MINUTES, so it outranks anything running to 6 PM.
    case "momentum": return 1;
    case "campaign": {
      const soon = i.endsAtMs != null && i.endsAtMs - nowMs < 90 * 60_000;
      // A started campaign about to close beats an untouched one with hours left.
      if (soon) return i.started ? 2 : 4;
      return i.started ? 5 : 6;
    }
    // Standing programmes. Always true, so they are the floor rather than news.
    case "ladder": return 7;
    case "drop": return 8;
    default: return 9;
  }
}

export interface SlotResolution {
  /** The one thing to render. Null when nothing is live. */
  primary: LiveItem | null;
  /** How many OTHER live items were suppressed. Drives "2 more active". */
  otherCount: number;
  /** Their combined value — the reason a rep taps through to see them. */
  otherRewardCents: number;
}

/**
 * Pick the one item to show.
 *
 * Expired items are dropped before ranking: an item whose clock has run out is
 * not "low priority", it is not live, and rendering it as a stale card is how a
 * rep learns the screen lies.
 */
export function resolveLiveSlot(items: LiveItem[], nowMs: number): SlotResolution {
  const live = items.filter(i => i.endsAtMs == null || i.endsAtMs > nowMs);
  if (live.length === 0) return { primary: null, otherCount: 0, otherRewardCents: 0 };

  const sorted = [...live].sort((a, b) =>
    rank(a, nowMs) - rank(b, nowMs)
    // Then soonest deadline — among equals, the one about to disappear.
    || (a.endsAtMs ?? Infinity) - (b.endsAtMs ?? Infinity)
    // Then the bigger prize, then id so the order never shuffles between renders.
    || b.rewardCents - a.rewardCents
    || a.id.localeCompare(b.id));

  const [primary, ...rest] = sorted;
  return {
    primary: primary!,
    otherCount: rest.length,
    otherRewardCents: rest.reduce((s, i) => s + Math.max(0, i.rewardCents), 0),
  };
}

/** Milliseconds left, floored at 0. Drives the countdown. */
export function msLeft(item: Pick<LiveItem, "endsAtMs">, nowMs: number): number {
  return item.endsAtMs == null ? Infinity : Math.max(0, item.endsAtMs - nowMs);
}

/**
 * "43 min" / "2h 10m" / "9 min".
 *
 * Switches to minutes under an hour because "1h 3m left" reads as comfortable
 * and "63 min" reads as a clock — and under 10 minutes it is the only number on
 * the card that matters.
 */
export function countdownLabel(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Under ten minutes, the countdown turns red and nothing else on the card
 *  competes with it. */
export function isUrgent(ms: number): boolean {
  return Number.isFinite(ms) && ms > 0 && ms <= 10 * 60_000;
}
