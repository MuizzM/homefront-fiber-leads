// ── Merging a pushed lead into a map pin ─────────────────────────────────────
// Extracted from MapView so the one rule that decides what another rep's phone
// SHOWS after a push is unit-testable without mounting an 8k-line page. PURE:
// no React, no Mapbox, no cache — the caller owns where the merged pin goes.
//
// A stream event is NEVER spread wholesale over a pin. LeadStreamPin is
// deliberately narrower than the map pin — it has no knockCount /
// freshConfidence / carrier, because those are JOINED by the map query and the
// write path does not hold them — so `{...pin, ...event.lead}` would erase
// them with nulls. Fields are therefore taken one at a time, in three groups:
//
//  • Always-take (null = "no news"): geometry, address text, fiber/tag/score.
//    Nothing local ever owns these.
//  • Always-write (null = "cleared"): the assignment pair, assignMark and
//    doNotKnock. Every emit path projects the FULL post-write lead row, so for
//    these a null genuinely means the state was cleared — an unassigned door
//    must drop its halo, and a cleared triage mark must leave the card.
//  • Outcome-owned (leadStatus / lastOutcome / lastOutcomeAt / visited): only
//    when the push is at least as recent as what the pin already shows, by the
//    SAME clock the server's outcome CAS orders writes with —
//    leads.last_outcome_at, which every push carries as lastOutcomeAt and the
//    map wire now ships on the pin. This mirrors the server's rule rather than
//    inventing a second one, so client and server can never disagree about who
//    won a race between two reps (or a rep and a central mark) on one door.
//    The old code compared against lastKnockedAt — a KNOCK time a central mark
//    never advances — and then wrote the pushed outcome time INTO
//    lastKnockedAt, so one merged push corrupted the next comparison's
//    baseline. lastKnockedAt is now left alone entirely: the event does not
//    carry a knock time, and the 60s map poll re-joins the true one.
//
// knockCount is deliberately NOT touched: the event does not carry it, and
// guessing +1 for a knock we cannot attribute would drift a number the rep is
// paid on. The map poll re-joins the true count.
//
// Returns `prev` UNCHANGED when nothing moved, so a no-op push costs zero
// re-renders and zero re-clusters.
import type { LeadStreamPin } from "./leadStream";

/** The slice of the map-pin shape this merge reads and writes. Structural so
 *  MapView's own MapPin (which carries more joined fields) satisfies it. */
export interface StreamMergeablePin {
  id: number;
  address: string;
  city: string;
  state: string;
  zip: string;
  lat: number;
  lng: number;
  leadStatus: string;
  fiberStatus: string;
  assignedRepId: number | null;
  assignedTerritoryId?: number | null;
  leadScore: number;
  leadTag?: string | null;
  visited?: boolean;
  lastOutcome?: string | null;
  /** Last physical knock time (knock_log join). NOT the CAS clock. */
  lastKnockedAt?: string | null;
  /** The server outcome CAS clock (leads.last_outcome_at) — the ONLY recency
   *  authority for the outcome-owned fields. */
  lastOutcomeAt?: string | null;
  assignMark?: string | null;
  doNotKnock?: boolean;
}

export function mergePushedPin<T extends StreamMergeablePin>(prev: T, pin: LeadStreamPin): T {
  let next: T | null = null;
  const write = (key: keyof StreamMergeablePin, value: unknown): void => {
    if ((prev as any)[key] === value) return;
    next = next ?? { ...prev };
    (next as any)[key] = value;
  };
  // The projection nulls what the writer did not hold, so for these an absent
  // value means "no news", never "cleared".
  const take = (key: keyof StreamMergeablePin, value: string | number | null): void => {
    if (value !== null) write(key, value);
  };
  take("address", pin.address);
  take("city", pin.city);
  take("state", pin.state);
  take("zip", pin.zip);
  take("lat", pin.lat);
  take("lng", pin.lng);
  take("fiberStatus", pin.fiberStatus);
  take("leadTag", pin.leadTag);
  take("leadScore", pin.leadScore);
  // Written unconditionally: the server read the full post-write row to answer
  // repCanAccessLead before it sent the frame, so it definitely holds these and
  // null genuinely means cleared — the state that must drop a halo, hide a
  // triage mark, or lift a do-not-knock block. Normalized before comparing:
  // the compact map wire OMITS empty fields entirely, so an unassigned pin
  // holds `undefined` where the push holds `null` — those are the same state,
  // and writing one over the other would allocate a fresh pin (a re-render and
  // a re-cluster) for every push that changes nothing.
  const writeCleared = (key: keyof StreamMergeablePin, value: string | number | null): void => {
    if (((prev as any)[key] ?? null) === value) return;
    write(key, value);
  };
  writeCleared("assignedRepId", pin.assignedRepId);
  writeCleared("assignedTerritoryId", pin.assignedTerritoryId);
  writeCleared("assignMark", pin.assignMark);
  // Boolean by truthiness: an absent key and an explicit false both mean "no
  // block", exactly how every consumer already reads the compact pin.
  if (!(prev.doNotKnock ?? false) !== !pin.doNotKnock) write("doNotKnock", pin.doNotKnock);

  // ── Outcome CAS, mirrored from applyKnockOutcomeCas ────────────────────────
  // ISO-8601 compares lexicographically in timestamp order, so no Date parse.
  // Baseline: the pin's own CAS clock; legacy pins that predate the lead-level
  // columns never carry one, so their knock time stands in (for a knock-applied
  // outcome the two are the same instant). A pin with no clock at all has
  // nothing to defend and always takes the push.
  const localAt = prev.lastOutcomeAt ?? prev.lastKnockedAt ?? null;
  const pushedAt = pin.lastOutcomeAt ?? null;
  const outcomeWins = localAt == null || (pushedAt != null && pushedAt >= localAt);
  if (outcomeWins) {
    take("leadStatus", pin.leadStatus);
    take("lastOutcome", pin.lastOutcome);
    take("lastOutcomeAt", pin.lastOutcomeAt);
    if (pin.lastOutcome) write("visited", true);
  }
  return next ?? prev;
}

// The pin a never-before-seen door starts life as. Reduced-field exactly like
// the optimistic add paths (map tap, AddLeadSheet): the joined columns are
// simply absent until the next map GET fills them, and every consumer already
// reads the optional fields by truthiness.
export function pinFromPushedLead(pin: LeadStreamPin): StreamMergeablePin {
  return {
    id: pin.id,
    address: pin.address ?? "",
    city: pin.city ?? "",
    state: pin.state ?? "",
    zip: pin.zip ?? "",
    lat: pin.lat as number,
    lng: pin.lng as number,
    leadStatus: pin.leadStatus ?? "prospect",
    fiberStatus: pin.fiberStatus ?? "",
    assignedRepId: pin.assignedRepId,
    assignedTerritoryId: pin.assignedTerritoryId,
    leadScore: pin.leadScore ?? 0,
    leadTag: pin.leadTag,
    visited: !!pin.lastOutcome,
    lastOutcome: pin.lastOutcome,
    // The CAS clock rides in its own field; lastKnockedAt is left unset — the
    // push carries an OUTCOME time, and stamping it as a knock time was exactly
    // the conflation that broke the next merge's recency comparison.
    lastOutcomeAt: pin.lastOutcomeAt,
    assignMark: pin.assignMark,
    doNotKnock: pin.doNotKnock,
  };
}
