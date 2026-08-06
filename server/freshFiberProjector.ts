import { rawDb } from "./db";
import { decideFreshFiberConfirmation, type FreshFiberConfirmationDecision, type IndependentAvailabilityEvidence } from "@shared/freshFiberConfirmation";
import { structuredLog } from "./structuredLog";
import { pointInPolygon } from "@shared/geo";
import { meterQualifiedLead } from "./billingStore";
import { normalizeKineticAddressKey, kineticLeadKeyOrNull } from "./scanner";
import { addressIdentityIssues } from "@shared/addressKey";

interface ProjectionCandidate {
  id: number;
  address: string;
  city: string;
  state: "NC" | "SC";
  zip: string;
  lat: number | null;
  lng: number | null;
  first_seen_fiber_at: string | null;
  last_fiber_status: string | null;
  last_billing_status: string | null;
  last_customer_segment: "new_opportunity" | "existing_customer" | "unknown";
  converted_to_lead_id: number | null;
  proven_flip: number;
  max_download_mbps: number | null;
  household_segment_type: string | null;
  billing_status: string | null;
  carrier?: string; // 'kinetic' (default) | 'frontier' — paints the lead red
  // Competitive eligibility (Spectrum-only gate) from the latest conclusive snapshot.
  competitive_decision: string | null; // 'eligible' | 'excluded_fiber_competitor' | 'competitor_review'
  competitor_name: string | null;
  competitor_tech: string | null;
  latest_fiber_available: number | null;
}

export interface ProjectionResult {
  considered: number;
  confirmed: number;
  created: number;
  linkedExisting: number;
  published: number;
  provisional: number;
  rejected: number;
  /** Quarantined by the ADDRESS_REVIEW identity gate (not rep-ready). */
  addressReview: number;
  leadIds: number[];
  /** Per-candidate failures. One bad door skips ONE door — it never rolls back
   * or blocks the rest of the batch (a single tenant-conflict throw used to
   * discard every other confirmed lead in the transaction). */
  errors: Array<{ targetId: number; reason: string }>;
}

interface TerritoryAssignment { territoryId: number; repId: number }

// Active territories fetched and JSON.parsed ONCE per projector call (built
// lazily on the first published candidate). The previous shape re-queried and
// re-parsed every polygon — potentially thousands of vertices each — once PER
// candidate, inside the write transaction: O(candidates × territories ×
// vertices) synchronous parsing per batch. DB state is stable inside the
// transaction, so parse-once is behavior-identical. Same pattern as the
// cityLeadIndex cache below. Rings that fail to parse (or are not >=3-vertex
// arrays) are dropped, exactly as the per-candidate catch treated them.
function buildTerritoryAssignmentIndex(tenantId: number): (lat: number | null, lng: number | null) => TerritoryAssignment | null {
  let areas: Array<{ id: number; repId: number; ring: [number, number][] }> | null = null;
  return (lat, lng) => {
    if (lat == null || lng == null) return null;
    areas ??= (rawDb.prepare(`SELECT id,rep_id,polygon FROM territories
      WHERE tenant_id=? AND status IN ('active','shared')`).all(tenantId) as any[])
      .map((territory) => {
        try {
          const ring = JSON.parse(territory.polygon) as [number, number][];
          return Array.isArray(ring) && ring.length >= 3
            ? { id: Number(territory.id), repId: Number(territory.rep_id), ring }
            : null;
        } catch { return null; }
      })
      .filter((t): t is { id: number; repId: number; ring: [number, number][] } => t != null);
    const matches = areas.filter((t) => pointInPolygon(lat, lng, t.ring));
    // Overlaps require a manager decision; silently choosing a territory could
    // leak a door across teams. A single unambiguous match is safe to auto-push.
    return matches.length === 1
      ? { territoryId: matches[0].id, repId: matches[0].repId }
      : null;
  };
}

/**
 * Idempotent projection from evidence history to operational leads. The scanner
 * never writes a lead directly: only this confirmation gate may publish a door
 * to the rep map.
 */
export function projectConfirmedFreshLeads(tenantId: number, targetIds?: number[]): ProjectionResult {
  const ids = [...new Set((targetIds ?? []).filter((id) => Number.isInteger(id) && id > 0))];
  // A caller that PROVIDED targets but none survived validation asked to
  // project nothing — falling through would silently run the full tenant
  // sweep (every scan_target × latest-snapshot seek). Only an explicit
  // no-argument call may sweep.
  if (targetIds && ids.length === 0) {
    return { considered: 0, confirmed: 0, created: 0, linkedExisting: 0, published: 0, provisional: 0, rejected: 0, addressReview: 0, leadIds: [], errors: [] };
  }
  const filter = ids.length ? `AND s.id IN (${ids.map(() => "?").join(",")})` : "";
  const candidates = rawDb.prepare(`
    SELECT s.id,s.address,s.city,s.state,s.zip,s.lat,s.lng,s.first_seen_fiber_at,
           s.last_fiber_status,s.last_billing_status,s.last_customer_segment,s.converted_to_lead_id,s.carrier,s.frontier_control,
           EXISTS(SELECT 1 FROM availability_snapshots f WHERE f.scan_target_id=s.id AND f.tenant_id=? AND f.fresh=1 AND f.conclusive=1) AS proven_flip,
           latest.max_download_mbps,latest.household_segment_type,latest.billing_status,latest.service_status,
      latest.fiber_available AS latest_fiber_available,
      latest.competitive_decision,latest.competitor_name,latest.competitor_tech
      FROM scan_targets s
      -- Latest CONCLUSIVE snapshot, ordered by the canonical epoch (never raw text).
      -- A failed/inconclusive attempt is excluded, so it can never outrank or mask a
      -- genuine NEW FIBER answer (the discovery↔Manual-Check divergence).
      LEFT JOIN availability_snapshots latest ON latest.id=(
        SELECT a.id FROM availability_snapshots a WHERE a.scan_target_id=s.id AND a.tenant_id=? AND a.conclusive=1
        ORDER BY a.checked_at_epoch DESC,a.id DESC LIMIT 1
      )
     WHERE s.state IN ('GA','NC','SC') AND s.tenant_id=?
       -- No historical requirement: a target qualifies on its flip stamp OR on
       -- the CURRENT conclusive answer alone (NEW FIBER + billing N is a Fresh
       -- Lead now — no first_seen_fiber_at, detected flip, or corroboration
       -- needed to be considered).
       AND (s.first_seen_fiber_at IS NOT NULL
            OR (upper(COALESCE(latest.household_segment_type,''))='NEW FIBER'
                AND upper(COALESCE(latest.billing_status,''))='N'))
       -- CROSS-CARRIER CONTAMINATION GUARD: the Kinetic observation path stamps
       -- fiber state on shared targets regardless of carrier. A frontier lead
       -- may ONLY be published from an actual Frontier serviceability verdict
       -- (notes start "Frontier fiber live"); Kinetic-fabric verdicts on a
       -- frontier-tagged target are NOT Frontier leads — observed live
       -- re-minting hundreds of false red pins after the strict cleanup.
       AND (COALESCE(s.carrier,'') <> 'frontier'
            OR latest.service_status LIKE 'Frontier fiber live%') ${filter}
     ORDER BY s.id`).all(tenantId, tenantId, tenantId, ...ids) as ProjectionCandidate[];

  const evidenceStmt = rawDb.prepare(`SELECT source,observed_at AS observedAt,availability,technology
    FROM availability_corroboration WHERE tenant_id=? AND scan_target_id=? ORDER BY observed_at`);
  const findBySource = rawDb.prepare(`SELECT id,assigned_rep_id FROM leads WHERE tenant_id=? AND source_scan_target_id=? LIMIT 1`);
  // Address match must use the CANONICAL key, not raw text: Kinetic's canonical
  // form abbreviates suffixes and directionals ("338 Farrell Road" vs
  // "338 FARRELL RD"), and two scan targets for the same house (OSM harvest vs
  // Kinetic canonical) would otherwise mint duplicate leads (observed: lead
  // #11318 duplicating #11198). Pull the city's leads and compare normalized.
  // Tenant-scoped: a foreign tenant's lead for the same street text must never
  // enter the index — it used to surface here and throw LEAD_ADDRESS_TENANT_
  // CONFLICT, which aborted the WHOLE batch (see per-candidate isolation below).
  const findByCityLeads = rawDb.prepare(`SELECT id,tenant_id,assigned_rep_id,address FROM leads
    WHERE lower(trim(city))=lower(trim(?)) AND upper(state)=upper(?) AND tenant_id=?
    ORDER BY id`);
  // Per-CITY normalized-address index, built ONCE per city per projector call and
  // cached. The previous version re-hashed every lead in the city for EVERY
  // candidate — O(candidates × city_leads) synchronous work that pegged the single
  // event-loop thread and wedged the app as the leads table grew (prod outage:
  // fresh_fiber.projected froze the loop). Now each city's leads are hashed once
  // into a Map for O(1) lookups; newly-inserted leads are added to the live index
  // so within-call dedup stays correct.
  const cityLeadIndex = new Map<string, Map<string, any>>();
  const cityIndexKey = (city: string, state: string) => `${String(city).trim().toLowerCase()}|${String(state).trim().toUpperCase()}`;
  const getCityIndex = (city: string, state: string): Map<string, any> => {
    const ck = cityIndexKey(city, state);
    let idx = cityLeadIndex.get(ck);
    if (!idx) {
      idx = new Map();
      for (const row of findByCityLeads.iterate(city, state, tenantId) as Iterable<any>) {
        const k = normalizeKineticAddressKey(row.address ?? "", city, state, "");
        if (!idx.has(k)) idx.set(k, row); // tenant-preferred, lowest id wins
      }
      cityLeadIndex.set(ck, idx);
    }
    return idx;
  };
  const findByAddressNormalized = (address: string, city: string, state: string): any =>
    getCityIndex(city, state).get(normalizeKineticAddressKey(address, city, state, ""));
  const rememberNewLead = (lead: { id: number; tenant_id: number; assigned_rep_id: number | null }, address: string, city: string, state: string): void => {
    const idx = cityLeadIndex.get(cityIndexKey(city, state));
    if (!idx) return; // not built yet — a later lookup rebuilds it from the DB (sees this insert)
    const k = normalizeKineticAddressKey(address, city, state, "");
    if (!idx.has(k)) idx.set(k, { id: lead.id, tenant_id: lead.tenant_id, assigned_rep_id: lead.assigned_rep_id, address });
  };
  // Territories parsed once per call, not once per candidate (see the builder).
  const territoryAssignmentFor = buildTerritoryAssignmentIndex(tenantId);
  const insert = rawDb.prepare(`INSERT INTO leads
    (address,city,state,zip,lat,lng,fiber_status,max_download_mbps,is_new_deployment,is_new_fiber,is_tenured,
     household_segment_type,billing_status,lead_status,notes,deployment_notes,lead_tag,lead_score,tenant_id,
     source_scan_target_id,fresh_confirmed_at,fresh_confidence,fresh_sources,assigned_rep_id,assigned_territory_id,
     assignment_source,assigned_at,created_at,updated_at,carrier,exchange_id,canonical_key)
    VALUES (?,?,?,?,?,?,?,?,1,1,0,?,?,'prospect',?,?, 'fresh_fiber_confirmed',100,?,?,?,?,?,?,?,'fresh-fiber-territory',
      CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END,datetime('now'),datetime('now'),?,?,?)
    ON CONFLICT(tenant_id, canonical_key) WHERE canonical_key IS NOT NULL
      DO UPDATE SET updated_at=datetime('now')
    RETURNING id`);
  const stamp = rawDb.prepare(`UPDATE leads SET source_scan_target_id=COALESCE(source_scan_target_id,?),
    fresh_confirmed_at=?,fresh_confidence=CASE WHEN fresh_confidence='cross_verified' THEN 'cross_verified' ELSE ? END,fresh_sources=?,lead_tag='fresh_fiber_confirmed',
    lead_score=MAX(COALESCE(lead_score,0),100),assigned_rep_id=COALESCE(assigned_rep_id,?),
    assigned_territory_id=COALESCE(assigned_territory_id,?),
    assignment_source=CASE WHEN assigned_rep_id IS NULL AND ? IS NOT NULL THEN 'fresh-fiber-territory' ELSE assignment_source END,
    assigned_at=CASE WHEN assigned_rep_id IS NULL AND ? IS NOT NULL THEN datetime('now') ELSE assigned_at END,
    updated_at=datetime('now') WHERE id=? AND tenant_id=?`);
  const link = rawDb.prepare(`UPDATE scan_targets SET converted_to_lead_id=? WHERE id=? AND tenant_id=?`);
  // ADDRESS_REVIEW quarantine writers (identity gate below). Reasons stored on
  // the target for audit/release; a previously-published lead flips to the
  // review status (never deleted), leaving the rep-ready surfaces.
  const markAddressReview = rawDb.prepare(`UPDATE scan_targets SET address_review_reason=? WHERE id=?`);
  const reviewLead = rawDb.prepare(`UPDATE leads SET lead_status='address_review', updated_at=datetime('now')
     WHERE id=? AND tenant_id=? AND lead_status NOT IN ('sold','now_active','competitor_suppressed','scope_suppressed','address_review')`);
  let reviewLeadEvent: import("better-sqlite3").Statement | null = null;
  try {
    reviewLeadEvent = rawDb.prepare(`INSERT INTO lead_events (lead_id,type,actor,detail,at) VALUES (?,'status_change','Address Review',?,datetime('now'))`);
  } catch { /* lead_events absent on bare replay DBs */ }
  const assignmentEvent = rawDb.prepare(`INSERT INTO lead_events (lead_id,type,actor,detail,at)
    VALUES (?,'assignment','Fresh Fiber Monitor',?,datetime('now'))`);

  const result: ProjectionResult = { considered: candidates.length, confirmed: 0, created: 0, linkedExisting: 0, published: 0, provisional: 0, rejected: 0, addressReview: 0, leadIds: [], errors: [] };
  // PER-CANDIDATE ISOLATION: each door publishes inside its own savepoint
  // (better-sqlite3 nests transaction functions as SAVEPOINTs). A throw for one
  // candidate rolls back that one door and is recorded in result.errors; every
  // other confirmed lead in the batch still commits. The old single-transaction
  // shape lost entire batches: one LEAD_ADDRESS_TENANT_CONFLICT (or any DB
  // guard RAISE) discarded up to hundreds of confirmed green leads at once —
  // observed live 2026-07-18: 72 new_fiber/N targets scanned, zero leads minted.
  const perCandidate = rawDb.transaction((candidate: ProjectionCandidate) => {
      const evidence = evidenceStmt.all(tenantId, candidate.id) as IndependentAvailabilityEvidence[];
      const evidenceDecision = decideFreshFiberConfirmation({
        transitionFresh: !!candidate.proven_flip,
        currentFiberAvailable: candidate.latest_fiber_available == null ? null : !!candidate.latest_fiber_available,
        customerSegment: candidate.last_customer_segment ?? "unknown",
        firstDetectedAt: candidate.first_seen_fiber_at,
        evidence,
      });
      // AUTHORITATIVE LEAD RULE: householdSegmentType = NEW FIBER AND billing = N →
      // publish a Fresh Lead on Kinetic's own new-build signal, no flip/corroboration
      // wait. Cross-verification still WINS when it exists; the gate governs every
      // other transition. The `latest` join above now selects the latest CONCLUSIVE
      // snapshot by real datetime, so a null-segment failed snapshot can never mask a
      // genuine NEW FIBER answer (the discovery↔Manual-Check divergence).
      const seg = String(candidate.household_segment_type ?? "").toUpperCase();
      const billing = String(candidate.billing_status ?? "").toUpperCase();
      // Same-epoch evidence tuple: availability, segment, billing and competitive
      // decision all come from the exact same latest CONCLUSIVE snapshot selected
      // by the join above. scan_targets.last_fiber_available can lag that snapshot
      // and must never fill a null/unknown provider answer.
      const fiberAvail = candidate.latest_fiber_available == null ? null : !!candidate.latest_fiber_available;
      // Null is inconclusive and cannot mutate any lead state.
      if (fiberAvail == null) { result.rejected++; return; }
      // NOW ACTIVE transition: a genuinely newer CONCLUSIVE NEW FIBER + billing Y
      // (the `latest` join is conclusive-only, epoch-ordered) means the prospect
      // signed up. Move the existing Fresh Lead to now_active — never delete it.
      // Only lead_status changes (not a fresh-guard-watched column), so the guard
      // trigger is untouched.
      // "A" is Kinetic's other active-billing value (verified live) — same flip.
      if (candidate.converted_to_lead_id != null && seg === "NEW FIBER" && (billing === "Y" || billing === "A")) {
        const changed = rawDb.prepare(`UPDATE leads SET lead_status='now_active', updated_at=datetime('now')
          WHERE id=? AND tenant_id=? AND lead_status<>'now_active'`).run(candidate.converted_to_lead_id, tenantId).changes;
        if (changed) result.leadIds.push(candidate.converted_to_lead_id);
        return;
      }
      // ── COMPETITIVE ELIGIBILITY GATE (Spectrum-only) ────────────────────────
      // A Fresh Lead is deliverable ONLY when the competitive landscape is clear
      // of non-Kinetic FIBER. The decision is precomputed at snapshot-write time
      // (availabilitySnapshot.ts) by the canonical classifier; here we ENFORCE:
      //  - excluded_fiber_competitor / competitor_review → never publish, and
      //    RETRACT an already-published lead (a recheck revealed a fiber rival or
      //    an ambiguous competitor) so it leaves the rep map + queues.
      //  - null decision (legacy snapshot with no competitor evidence) → treated
      //    as eligible so the historical no-competitor pool is unaffected; new
      //    scans always carry a decision.
      const competitiveDecision = candidate.competitive_decision;
      const competitiveBlocked = competitiveDecision === "excluded_fiber_competitor" || competitiveDecision === "competitor_review";
      if (competitiveBlocked) {
        // Retract: suppress an existing lead so it never sits on the map/queue
        // while a fiber competitor (or unresolved competitor) is present. Never
        // deleted — flipped to a terminal non-deliverable status for audit, and
        // the scan_target link kept so a later clear recheck can re-publish.
        if (candidate.converted_to_lead_id != null) {
          const changed = rawDb.prepare(`UPDATE leads SET lead_status='competitor_suppressed', updated_at=datetime('now')
            WHERE id=? AND tenant_id=? AND lead_status NOT IN ('sold','now_active','competitor_suppressed')`)
            .run(candidate.converted_to_lead_id, tenantId).changes;
          if (changed) {
            (result as any).retracted = ((result as any).retracted ?? 0) + 1;
            try {
              rawDb.prepare(`INSERT INTO lead_events (lead_id,type,actor,detail,at)
                VALUES (?,'status_change','Competitive Eligibility',?,datetime('now'))`)
                .run(candidate.converted_to_lead_id, JSON.stringify({
                  to: "competitor_suppressed", reason: competitiveDecision,
                  competitor: candidate.competitor_name, competitorTech: candidate.competitor_tech,
                }));
            } catch { /* lead_events optional on this DB */ }
          }
        }
        result.rejected++;
        return;
      }

      // An explicit unavailable result is conclusive but cannot publish. It was
      // deliberately allowed through the competitive gate above so a confirmed
      // fiber-competitor recheck can retain the existing suppression behavior.
      if (fiberAvail !== true) { result.rejected++; return; }
      // NEW FIBER + N is authoritative only alongside the explicit positive
      // availability observation enforced above.
      const authoritativeFresh = seg === "NEW FIBER" && billing === "N" && fiberAvail === true;
      const decision: FreshFiberConfirmationDecision = evidenceDecision.confirmed
        ? evidenceDecision
        : authoritativeFresh
          ? { status: "confirmed", confirmed: true, reasons: ["NEW FIBER + billing N (authoritative Fresh Lead rule)."], sources: ["kinetic"], confirmedAt: candidate.first_seen_fiber_at ?? new Date().toISOString() }
          : evidenceDecision;
      if (decision.status === "provisional") { result.provisional++; return; }
      if (!decision.confirmed || !decision.confirmedAt) { result.rejected++; return; }
      // Honest confidence: cross_verified only with >=2 independent sources; a
      // single-source authoritative lead is labelled kinetic_new_fiber.
      const confidence = decision.sources.length >= 2 ? "cross_verified" : "kinetic_new_fiber";
      result.confirmed++;

      // ADDRESS_REVIEW QUARANTINE — a fresh signal with a broken identity
      // (no house number, blank city/state, missing or invalid coordinates)
      // must never become a rep-ready pin: it renders in the wrong place or
      // not at all, and its card shows guessed fields. Park the target with
      // the reasons; an operator (or a later corrected echo) can release it.
      // The evidence is preserved — nothing is deleted.
      const identityIssues = addressIdentityIssues({
        address: candidate.address, city: candidate.city, state: candidate.state,
        lat: candidate.lat, lng: candidate.lng,
      });
      if (identityIssues.length) {
        try {
          markAddressReview.run(identityIssues.join("; "), candidate.id);
          if (candidate.converted_to_lead_id != null) {
            reviewLead.run(candidate.converted_to_lead_id, tenantId);
            reviewLeadEvent?.run(candidate.converted_to_lead_id, JSON.stringify({ to: "address_review", issues: identityIssues }));
          }
        } catch { /* column may predate migration on a replay DB — quarantine is best-effort there */ }
        result.addressReview++;
        return;
      }

      let found = findBySource.get(tenantId, candidate.id) as any;
      let leadId = found?.id as number | undefined;
      // A stable converted link is the publication idempotency boundary. Do not
      // rewrite updated_at or churn the map ETag on every unchanged rescan.
      if (candidate.converted_to_lead_id != null && leadId === candidate.converted_to_lead_id) {
        result.linkedExisting++;
        result.leadIds.push(leadId);
        return;
      }
      result.published++;
      const assignment = territoryAssignmentFor(candidate.lat, candidate.lng);
      if (!leadId) {
        const addressMatch = findByAddressNormalized(candidate.address, candidate.city, candidate.state);
        if (addressMatch && Number(addressMatch.tenant_id) !== tenantId) {
          throw new Error(`LEAD_ADDRESS_TENANT_CONFLICT: scan target ${candidate.id}`);
        }
        leadId = addressMatch?.id as number | undefined;
        found = addressMatch;
      }
      // GEO GUARD — cross-city twin catch. OSM/Kinetic/Mapbox legitimately
      // assign different postal cities to boundary houses; city is part of the
      // canonical key AND the city-scoped lead index, so the same rooftop filed
      // under the other city name is invisible to both layers. Forensics found
      // confirmed dup pairs 0–1.4m apart. Before minting, attach to any
      // existing lead within ~15m that shares the house number.
      if (!leadId && candidate.lat != null && candidate.lng != null) {
        const houseNum = String(candidate.address ?? "").trim().split(/\s+/)[0] ?? "";
        if (/^\d+$/.test(houseNum)) {
          const geoHit = rawDb.prepare(`SELECT id, tenant_id, assigned_rep_id, address FROM leads
            WHERE tenant_id=? AND lat BETWEEN ?-0.00015 AND ?+0.00015 AND lng BETWEEN ?-0.0002 AND ?+0.0002
              AND (address = ? OR address LIKE ? || ' %')
            ORDER BY id LIMIT 1`).get(
            tenantId, candidate.lat, candidate.lat, candidate.lng, candidate.lng,
            houseNum, houseNum,
          ) as any;
          if (geoHit) {
            leadId = Number(geoHit.id);
            found = geoHit;
          }
        }
      }
      const wasUnassigned = !found?.assigned_rep_id;
      if (!leadId) {
        // Persist segment/billing that satisfy the DB fresh-lead guard even when the
        // latest snapshot join is null — fall back to the target's last-conclusive
        // signal so an authoritative lead is never blocked by a null-segment row.
        const leadSegment = candidate.household_segment_type ?? (authoritativeFresh ? "NEW FIBER" : candidate.last_fiber_status);
        const leadBilling = candidate.billing_status ?? candidate.last_billing_status ?? (authoritativeFresh ? "N" : null);
        // Carrier-honest copy: Frontier leads were being stamped "Kinetic fiber"
        // (hardcoded below), which read as a wrong-carrier verdict on red pins.
        const carrierName = (candidate as any).carrier === "frontier" ? "Frontier" : "Kinetic";
        const created = insert.get(
          candidate.address, candidate.city, candidate.state, candidate.zip ?? "", candidate.lat, candidate.lng,
          candidate.last_fiber_status ?? "new_fiber", candidate.max_download_mbps,
          leadSegment, leadBilling,
          `Confirmed fresh ${carrierName} fiber with no active-service signal.`,
          decision.sources.length >= 2
            ? `Unavailable-to-fiber flip; independently confirmed by ${decision.sources.slice(1).join(", ")}.`
            : `NEW FIBER + billing N (authoritative ${carrierName} new-build signal).`,
          tenantId, candidate.id, decision.confirmedAt, confidence, JSON.stringify(decision.sources),
          assignment?.repId ?? null, assignment?.territoryId ?? null,
          assignment?.repId ?? null,
          (candidate as any).carrier ?? "kinetic",
          // Frontier serving-area fingerprint (controlNumber) → build-zone clusters.
          (candidate as any).frontier_control ?? null,
          // Canonical key — a concurrent projector (multi-process) that already
          // created this address resolves via ON CONFLICT to the SAME id instead
          // of a duplicate pin. NULL for a keyless (blank/garbage) address so two
          // DIFFERENT such leads can't false-merge into one and lose a real lead.
          kineticLeadKeyOrNull(candidate.address, candidate.city, candidate.state, candidate.zip ?? ""),
        ) as { id: number } | undefined;
        leadId = created?.id ?? undefined;
        if (leadId == null) { result.rejected++; return; } // conflict returned no row — skip safely
        // Keep the in-memory index current so a later candidate for the SAME
        // normalized address in this call attaches instead of minting a duplicate.
        rememberNewLead({ id: leadId, tenant_id: tenantId, assigned_rep_id: assignment?.repId ?? null }, candidate.address, candidate.city, candidate.state);
        result.created++;
      } else {
        result.linkedExisting++;
      }
      stamp.run(
        candidate.id, decision.confirmedAt, confidence, JSON.stringify(decision.sources),
        assignment?.repId ?? null, assignment?.territoryId ?? null,
        assignment?.repId ?? null, assignment?.repId ?? null,
        leadId, tenantId,
      );
      link.run(leadId, candidate.id, tenantId);
      if (assignment && wasUnassigned) {
        assignmentEvent.run(leadId, JSON.stringify({
          assignedToRepId: assignment.repId,
          territoryId: assignment.territoryId,
          source: "confirmed_fresh_fiber",
        }));
      }
      result.leadIds.push(leadId);
  });
  const tx = rawDb.transaction(() => {
    for (const candidate of candidates) {
      try {
        perCandidate.immediate(candidate);
      } catch (error: any) {
        // The savepoint already rolled this one door back; record and move on.
        const reason = String(error?.message ?? error).slice(0, 200);
        result.errors.push({ targetId: candidate.id, reason });
        structuredLog("fresh_fiber.candidate_failed", { tenantId, targetId: candidate.id, reason }, "warn");
      }
    }
  });
  tx.immediate();
  // Billing follows the same idempotency boundary as publication. Calling for
  // every confirmed lead ID also backfills a missed accounting event after a
  // crash; meterQualifiedLead deduplicates by (tenant,lead) and is dark-by-
  // default for installations without SaaS billing enabled.
  for (const leadId of new Set(result.leadIds)) {
    try {
      meterQualifiedLead(tenantId, leadId, "system:fresh-fiber-projector");
    } catch (error: any) {
      structuredLog("fresh_fiber.billing_meter_failed", {
        tenantId, leadId, error: String(error?.message ?? error),
      }, "warn");
    }
  }
  if (result.published > 0) {
    const bust = (globalThis as any).__bustMapCache;
    if (typeof bust === "function") bust(tenantId);
    // Auto-enroll every fresh drop into the calling queue the moment it
    // publishes. force=true: this is THE event-driven sync the read-side
    // debounce leans on — it must never itself be debounced away.
    try {
      const { syncFreshFiberQueue } = require("./calling/store") as typeof import("./calling/store");
      syncFreshFiberQueue(tenantId, true);
    } catch { /* calling module optional — never block lead publication */ }
    structuredLog("fresh_fiber.projected", {
      tenantId, confirmed: result.confirmed, created: result.created, linkedExisting: result.linkedExisting, published: result.published,
      targets: result.leadIds.length,
    });
  }
  return result;
}
