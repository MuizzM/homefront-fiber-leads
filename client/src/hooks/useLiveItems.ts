// ── Feeding the Live Slot ────────────────────────────────────────────────────
// Adapts the four incentive queries the rep screens ALREADY make into the one
// shape the slot ranks. Deliberately client-side rather than a new aggregate
// endpoint: Today.tsx issues these exact four requests today (one per card), so
// composing them here costs zero extra round trips and no new server surface.
//
// If a fifth system lands (challenges), it plugs in here and everywhere the slot
// is mounted picks it up — which is the point of having one resolver.
import { useMyMilestones } from "@/components/MilestoneCard";
import { useMyDoorDrops } from "@/components/DoorDropCard";
import { useMomentum } from "@/components/MomentumOffer";
import { useMyCampaigns } from "@/components/CampaignBoard";
import type { LiveItem } from "@shared/liveSlot";

export function useLiveItems(enabled = true): LiveItem[] {
  const milestones = useMyMilestones(enabled);
  const drops = useMyDoorDrops(enabled);
  const momentum = useMomentum(enabled);
  const campaigns = useMyCampaigns(enabled);

  const items: LiveItem[] = [];

  // ── Momentum: the only one measured in minutes ───────────────────────────
  const offer = momentum.data?.offer;
  if (offer) {
    items.push({
      kind: "momentum",
      id: `momentum:${offer.id}`,
      headline: offer.headline,
      nextStep: offer.callToAction,
      rewardCents: offer.amountCents,
      endsAtMs: offer.expiresAtMs,
      pct: 0,
      // An armed offer IS the started state — it only arms because the rep is
      // already running hot.
      started: true,
    });
  }

  // ── Campaigns ────────────────────────────────────────────────────────────
  for (const c of campaigns.data?.campaigns ?? []) {
    // A campaign the rep has already earned is not something to chase.
    if (c.progress?.met) continue;
    items.push({
      kind: "campaign",
      id: `campaign:${c.id}`,
      headline: c.progress?.headline ?? c.name,
      nextStep: c.progress?.nextStep ?? "",
      rewardCents: c.rewardCents,
      endsAtMs: c.endsAtMs,
      pct: c.progress?.pct ?? 0,
      started: (c.progress?.current ?? 0) > 0,
    });
  }

  // ── The standing ladder ──────────────────────────────────────────────────
  const ladder = milestones.data;
  if (ladder?.enabled && ladder.progress && !ladder.progress.toppedOut) {
    items.push({
      kind: "ladder",
      id: "ladder",
      headline: ladder.progress.headline,
      nextStep: "",
      rewardCents: ladder.progress.nextRewardCents,
      // No deadline: it runs to the end of the commission period, which is not a
      // clock a rep should be watching.
      endsAtMs: null,
      pct: ladder.progress.pct,
      started: ladder.progress.doors > 0,
    });
  }

  // ── Door drops ───────────────────────────────────────────────────────────
  // Ranked last on purpose. It is true on every door of every day, so it can
  // never be the thing that makes someone look at the screen — but when nothing
  // else is running it is better than an empty slot.
  const drop = drops.data;
  if (drop?.enabled) {
    items.push({
      kind: "drop",
      id: "drop",
      headline: drop.statusLine,
      nextStep: "",
      // The band's top end — what a drop COULD pay. Used for ordering and for
      // the "on the table" line, never presented as a promise.
      rewardCents: drop.band.maxCents,
      endsAtMs: null,
      pct: 0,
      started: drop.doorsSinceLastDrop > 0,
    });
  }

  return items;
}
