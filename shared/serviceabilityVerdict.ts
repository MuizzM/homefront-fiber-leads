// ── What one provider answer says about serviceability ───────────────────────
//
// A SEGMENT IS NOT A QUALIFICATION.
//
// `householdSegmentType` describes the household's HISTORY with the carrier -
// TENURED means plant and a record here, NEW FIBER means a recent build. The
// qualification (`fiberQualified`) describes whether fiber can be ORDERED
// TODAY. They are different facts, and only the second may set a fiber status.
//
// This lived inside scanAddressDirect, which is network-bound, so every scanner
// test injected a fake checker and none of them ever reached it. That is how a
// real answer (2026-08-24, 1716 Sawtooth Court) carrying maxQual "NO QUAL",
// techType "", validationResult "AddressUnserviceableInTerritory" and
// broadbandService.qualDesc "FUTURE QUAL UP TO 1G" with estimatedCompletionDt
// NOV-2026 was stored as fiber_status='tenured_fiber' NEXT TO
// fiber_available=0 - a row contradicting itself, which every consumer keying
// on the status string then read as fiber. 49 China Grove doors were in that
// state; the map painted them walkable and the projector published them.
//
// The unqualified verdict deliberately reuses the EXISTING vocabulary
// ('no_service' / 'copper') rather than inventing a status. Neither string
// appears in any consumer's fiber list, so an unqualified door stops counting
// as fiber everywhere at once - no six-file sweep, and no reader left behind on
// a value it has never seen.

export type FiberStatus =
  | "new_fiber" | "tenured_fiber" | "existing_fiber" | "copper" | "no_service";

export interface ServiceabilityInput {
  householdSegmentType?: string | null;
  /** The canonical, copper-override-safe qualification (kineticResponseParser). */
  fiberQualified: boolean;
  validationResult?: string | null;
  billingStatus?: string | null;
  techType?: string | null;
  chipSetType?: string | null;
  maxQual?: string | null;
  maxDownloadMbps?: number | null;
  competitorName?: string | null;
  competitorSpeed?: string | null;
  competitorTech?: string | null;
}

export interface ServiceabilityVerdict {
  fiberStatus: FiberStatus;
  /** Feeds the fresh-fiber moat, so it requires qualification, not just a segment. */
  isNewFiber: boolean;
  /** Descriptive of household history; true even when fiber is not orderable. */
  isTenured: boolean;
  notes: string;
}

const UNSERVICEABLE_RE = /UNSERVICEABLE|NOTSERVICEABLE|OUTOFTERRITORY|NOSERVICE/;
const ACTIVE_BILLING = new Set(["Y", "A"]);

export function classifyServiceability(i: ServiceabilityInput): ServiceabilityVerdict {
  const segment = String(i.householdSegmentType ?? "").trim().toUpperCase();
  const qualified = i.fiberQualified === true;
  const unserviceable = UNSERVICEABLE_RE.test(
    String(i.validationResult ?? "").toUpperCase().replace(/\s+/g, ""));

  // History flags. isTenured stays true whatever the qualification says - a
  // household's record with the carrier is a fact about the past. isNewFiber
  // additionally requires qualification because it feeds the fresh-fiber moat,
  // whose own rule already demands availability.
  const isTenured = segment === "TENURED";
  const isNewFiber = segment === "NEW FIBER" && qualified;

  if (segment === "NEW FIBER" && qualified) {
    const competitor = i.competitorName
      ? `Competitor: ${i.competitorName} (${i.competitorSpeed} Mbps ${i.competitorTech}).` : "";
    const fttp = i.chipSetType === "FTTP" ? "FTTP confirmed." : "";
    return { fiberStatus: "new_fiber", isNewFiber, isTenured,
      notes: `New fiber deployment. ${competitor} ${fttp}`.trim() };
  }
  if (segment === "TENURED" && qualified) {
    const sold = ACTIVE_BILLING.has(String(i.billingStatus ?? "").trim().toUpperCase());
    return { fiberStatus: "tenured_fiber", isNewFiber, isTenured,
      notes: sold
        ? `TENURED - long-established fiber address, already a Kinetic subscriber. Tech: ${i.techType}. ${i.maxDownloadMbps} Mbps qualified.`
        : `TENURED - long-established fiber address, NOT a current subscriber. Prime upgrade target. Tech: ${i.techType}. ${i.maxDownloadMbps} Mbps qualified.` };
  }
  if (qualified) {
    return { fiberStatus: "existing_fiber", isNewFiber, isTenured,
      notes: `Fiber available. Segment: ${segment || "unknown"}.` };
  }
  if (unserviceable) {
    // The carrier's own words: not serviceable here. However long the
    // household's history, the segment does not overrule that.
    return { fiberStatus: "no_service", isNewFiber, isTenured,
      notes: `Not serviceable (${i.validationResult}). Segment: ${segment || "unknown"}. Max qual: ${i.maxQual ?? "none"}.` };
  }
  return { fiberStatus: "copper", isNewFiber, isTenured,
    notes: `Legacy copper/DSL. Max qual: ${i.maxDownloadMbps} Mbps. Segment: ${segment}.` };
}
