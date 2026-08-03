export type SavedKnockMessage = {
  title: "Sale saved" | "Outcome saved" | "A newer outcome already stands" | "SPIFF earned";
  description?: string;
};

/** A campaign award the server booked on THIS knock. The server only returns
 *  freshly-INSERTED awards, so an offline-queue replay of the same knock can
 *  never re-celebrate money the rep has already been told about. */
export type KnockCampaignAward = {
  campaignName: string;
  amountCents: number;
  reason: string;
};

export type MoneyQueryPrefix =
  | "/api/commission"
  | "/api/commissions"
  | "/api/payouts";

export type SavedKnockReconciliationEffects = {
  notify: (message: SavedKnockMessage) => void;
  invalidateQuery: (queryKey: readonly unknown[]) => void;
  invalidatePrefix: (prefix: MoneyQueryPrefix) => void;
};

export type FieldQueueIdentity = {
  id: number;
  role: string;
  teamMemberId?: number | null;
};

const FIELD_ROLES = new Set([
  "rep",
  "team_lead",
  "manager",
  "admin",
  "super_admin",
]);

function positiveId(value: number | null | undefined): number | null {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
}

/**
 * Queue ownership is an authenticated-client namespace, not sales credit.
 * Team members retain their existing positive key. Authorized field users
 * without a team-member row receive a unique negative user key, which cannot
 * collide with real positive team-member IDs.
 */
export function deriveFieldQueueOwnerKey(
  user: FieldQueueIdentity | null | undefined,
): number | null {
  if (!user || !FIELD_ROLES.has(user.role)) return null;
  const teamMemberId = positiveId(user.teamMemberId);
  if (teamMemberId != null) return teamMemberId;
  const userId = positiveId(user.id);
  return userId == null ? null : -userId;
}

/**
 * Resolves authoritative sales credit separately from queue ownership.
 * Synthetic negative owner keys are never eligible to enter a knock payload.
 */
export function resolveCreditedRepId(
  user: FieldQueueIdentity | null | undefined,
  assignedRepId?: number | null,
): number | null {
  if (!user || !FIELD_ROLES.has(user.role)) return null;
  const ownRepId = positiveId(user.teamMemberId);
  if (user.role === "rep") return ownRepId;
  return positiveId(assignedRepId) ?? ownRepId;
}

export function queryKeyMatchesApiPrefix(
  queryKey: readonly unknown[],
  prefix: MoneyQueryPrefix,
): boolean {
  const root = queryKey[0];
  return (
    typeof root === "string"
    && (root === prefix || root.startsWith(`${prefix}/`))
  );
}

/**
 * Reconciles UI state only after KnockQueue has durably saved a knock.
 * Superseded knocks are history-only: a newer authoritative outcome remains on
 * the lead, so the optimistic map state is reconciled immediately.
 */
export function createSavedKnockReconciliation(
  effects: SavedKnockReconciliationEffects,
) {
  return (
    leadId: number,
    outcome?: string,
    superseded = false,
    campaignAwards?: readonly KnockCampaignAward[],
  ): void => {
    if (superseded) {
      effects.notify({
        title: "A newer outcome already stands",
        description:
          "This knock was recorded as history; the door keeps its latest status.",
      });
    } else {
      effects.notify({
        title: outcome === "sold" ? "Sale saved" : "Outcome saved",
      });
    }

    // The campaign the rep just cleared, announced AT the door rather than the
    // next time they happen to open the Spiffs tab. A bonus a rep finds out
    // about on Friday did not change anything on Tuesday.
    for (const award of campaignAwards ?? []) {
      const whole = Math.floor(Math.abs(award.amountCents) / 100).toLocaleString("en-US");
      const rem = Math.abs(award.amountCents) % 100;
      const amount = rem === 0 ? `$${whole}` : `$${whole}.${String(rem).padStart(2, "0")}`;
      effects.notify({ title: "SPIFF earned", description: `${amount} — ${award.reason}` });
    }

    effects.invalidateQuery(["/api/leads/map"]);
    effects.invalidateQuery(["/api/leaderboard"]);
    // Every knock moves campaign progress, sale or not — that is the point of an
    // effort-shaped trigger. Refetch so the card the rep looks at next is live.
    effects.invalidateQuery(["/api/me/campaigns"]);
    effects.invalidateQuery(["/api/me/milestones"]);
    // Door drops move on EVERY verified door, and the card's whole job is to say
    // how long the dry run has been. A stale one contradicts the drop the rep was
    // just toasted about.
    effects.invalidateQuery(["/api/me/door-drops"]);
    // Momentum is the one with a clock measured in minutes — an armed offer the
    // rep cannot see for another 30 seconds has already lost part of its window.
    effects.invalidateQuery(["/api/me/momentum"]);
    effects.invalidateQuery(["/api/spiffs/mine"]);
    effects.invalidateQuery(["/api/leads"]);
    effects.invalidateQuery(["/api/followups"]);
    effects.invalidateQuery([`/api/leads/${leadId}`]);
    effects.invalidateQuery([`/api/leads/${leadId}/history`]);
    effects.invalidatePrefix("/api/commission");
    effects.invalidatePrefix("/api/commissions");
    effects.invalidatePrefix("/api/payouts");
  };
}
