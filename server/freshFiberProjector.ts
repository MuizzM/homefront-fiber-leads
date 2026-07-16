import { rawDb } from "./db";
import { decideFreshFiberConfirmation, type FreshFiberConfirmationDecision, type IndependentAvailabilityEvidence } from "@shared/freshFiberConfirmation";
import { structuredLog } from "./structuredLog";
import { pointInPolygon } from "@shared/geo";
import { meterQualifiedLead } from "./billingStore";

interface ProjectionCandidate {
  id: number;
  address: string;
  city: string;
  state: "NC" | "SC";
  zip: string;
  lat: number | null;
  lng: number | null;
  first_seen_fiber_at: string | null;
  last_fiber_available: number | null;
  last_fiber_status: string | null;
  last_billing_status: string | null;
  last_customer_segment: "new_opportunity" | "existing_customer" | "unknown";
  converted_to_lead_id: number | null;
  proven_flip: number;
  max_download_mbps: number | null;
  household_segment_type: string | null;
  billing_status: string | null;
}

export interface ProjectionResult {
  considered: number;
  confirmed: number;
  created: number;
  linkedExisting: number;
  published: number;
  provisional: number;
  rejected: number;
  leadIds: number[];
}

interface TerritoryAssignment { territoryId: number; repId: number }

function territoryAssignmentFor(tenantId: number, lat: number | null, lng: number | null): TerritoryAssignment | null {
  if (lat == null || lng == null) return null;
  const matches = (rawDb.prepare(`SELECT id,rep_id,polygon FROM territories
    WHERE tenant_id=? AND status IN ('active','shared')`).all(tenantId) as any[]).filter((territory) => {
    try {
      const ring = JSON.parse(territory.polygon) as [number, number][];
      return Array.isArray(ring) && ring.length >= 3 && pointInPolygon(lat, lng, ring);
    } catch { return false; }
  });
  // Overlaps require a manager decision; silently choosing a territory could
  // leak a door across teams. A single unambiguous match is safe to auto-push.
  return matches.length === 1
    ? { territoryId: Number(matches[0].id), repId: Number(matches[0].rep_id) }
    : null;
}

/**
 * Idempotent projection from evidence history to operational leads. The scanner
 * never writes a lead directly: only this confirmation gate may publish a door
 * to the rep map.
 */
export function projectConfirmedFreshLeads(tenantId: number, targetIds?: number[]): ProjectionResult {
  const ids = [...new Set((targetIds ?? []).filter((id) => Number.isInteger(id) && id > 0))];
  const filter = ids.length ? `AND s.id IN (${ids.map(() => "?").join(",")})` : "";
  const candidates = rawDb.prepare(`
    SELECT s.id,s.address,s.city,s.state,s.zip,s.lat,s.lng,s.first_seen_fiber_at,s.last_fiber_available,
           s.last_fiber_status,s.last_billing_status,s.last_customer_segment,s.converted_to_lead_id,
           EXISTS(SELECT 1 FROM availability_snapshots f WHERE f.scan_target_id=s.id AND f.tenant_id=? AND f.fresh=1 AND f.conclusive=1) AS proven_flip,
           latest.max_download_mbps,latest.household_segment_type,latest.billing_status
      FROM scan_targets s
      -- Latest CONCLUSIVE snapshot, ordered by the canonical epoch (never raw text).
      -- A failed/inconclusive attempt is excluded, so it can never outrank or mask a
      -- genuine NEW FIBER answer (the discovery↔Manual-Check divergence).
      LEFT JOIN availability_snapshots latest ON latest.id=(
        SELECT a.id FROM availability_snapshots a WHERE a.scan_target_id=s.id AND a.tenant_id=? AND a.conclusive=1
        ORDER BY a.checked_at_epoch DESC,a.id DESC LIMIT 1
      )
     WHERE s.first_seen_fiber_at IS NOT NULL AND s.state IN ('NC','SC')
       AND s.tenant_id=? ${filter}
     ORDER BY s.id`).all(tenantId, tenantId, tenantId, ...ids) as ProjectionCandidate[];

  const evidenceStmt = rawDb.prepare(`SELECT source,observed_at AS observedAt,availability,technology
    FROM availability_corroboration WHERE tenant_id=? AND scan_target_id=? ORDER BY observed_at`);
  const findBySource = rawDb.prepare(`SELECT id,assigned_rep_id FROM leads WHERE tenant_id=? AND source_scan_target_id=? LIMIT 1`);
  const findByAddress = rawDb.prepare(`SELECT id,tenant_id,assigned_rep_id FROM leads
    WHERE lower(trim(address))=lower(trim(?)) AND lower(trim(city))=lower(trim(?)) AND upper(state)=upper(?)
    ORDER BY CASE WHEN tenant_id=? THEN 0 ELSE 1 END,id LIMIT 1`);
  const insert = rawDb.prepare(`INSERT INTO leads
    (address,city,state,zip,lat,lng,fiber_status,max_download_mbps,is_new_deployment,is_new_fiber,is_tenured,
     household_segment_type,billing_status,lead_status,notes,deployment_notes,lead_tag,lead_score,tenant_id,
     source_scan_target_id,fresh_confirmed_at,fresh_confidence,fresh_sources,assigned_rep_id,assigned_territory_id,
     assignment_source,assigned_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,1,1,0,?,?,'prospect',?,?, 'fresh_fiber_confirmed',100,?,?,?,?,?,?,?,'fresh-fiber-territory',
      CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END,datetime('now'),datetime('now'))`);
  const stamp = rawDb.prepare(`UPDATE leads SET source_scan_target_id=COALESCE(source_scan_target_id,?),
    fresh_confirmed_at=?,fresh_confidence=CASE WHEN fresh_confidence='cross_verified' THEN 'cross_verified' ELSE ? END,fresh_sources=?,lead_tag='fresh_fiber_confirmed',
    lead_score=MAX(COALESCE(lead_score,0),100),assigned_rep_id=COALESCE(assigned_rep_id,?),
    assigned_territory_id=COALESCE(assigned_territory_id,?),
    assignment_source=CASE WHEN assigned_rep_id IS NULL AND ? IS NOT NULL THEN 'fresh-fiber-territory' ELSE assignment_source END,
    assigned_at=CASE WHEN assigned_rep_id IS NULL AND ? IS NOT NULL THEN datetime('now') ELSE assigned_at END,
    updated_at=datetime('now') WHERE id=? AND tenant_id=?`);
  const link = rawDb.prepare(`UPDATE scan_targets SET converted_to_lead_id=? WHERE id=? AND tenant_id=?`);
  const assignmentEvent = rawDb.prepare(`INSERT INTO lead_events (lead_id,type,actor,detail,at)
    VALUES (?,'assignment','Fresh Fiber Monitor',?,datetime('now'))`);

  const result: ProjectionResult = { considered: candidates.length, confirmed: 0, created: 0, linkedExisting: 0, published: 0, provisional: 0, rejected: 0, leadIds: [] };
  const tx = rawDb.transaction(() => {
    for (const candidate of candidates) {
      const evidence = evidenceStmt.all(tenantId, candidate.id) as IndependentAvailabilityEvidence[];
      const evidenceDecision = decideFreshFiberConfirmation({
        transitionFresh: !!candidate.proven_flip,
        currentFiberAvailable: candidate.last_fiber_available == null ? null : !!candidate.last_fiber_available,
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
      const fiberAvail = candidate.last_fiber_available == null ? null : !!candidate.last_fiber_available;
      // NOW ACTIVE transition: a genuinely newer CONCLUSIVE NEW FIBER + billing Y
      // (the `latest` join is conclusive-only, epoch-ordered) means the prospect
      // signed up. Move the existing Fresh Lead to now_active — never delete it.
      // Only lead_status changes (not a fresh-guard-watched column), so the guard
      // trigger is untouched.
      if (candidate.converted_to_lead_id != null && seg === "NEW FIBER" && billing === "Y") {
        const changed = rawDb.prepare(`UPDATE leads SET lead_status='now_active', updated_at=datetime('now')
          WHERE id=? AND tenant_id=? AND lead_status<>'now_active'`).run(candidate.converted_to_lead_id, tenantId).changes;
        if (changed) result.leadIds.push(candidate.converted_to_lead_id);
        continue;
      }
      const authoritativeFresh = seg === "NEW FIBER" && billing === "N" && fiberAvail !== false;
      const decision: FreshFiberConfirmationDecision = evidenceDecision.confirmed
        ? evidenceDecision
        : authoritativeFresh
          ? { status: "confirmed", confirmed: true, reasons: ["NEW FIBER + billing N (authoritative Fresh Lead rule)."], sources: ["kinetic"], confirmedAt: candidate.first_seen_fiber_at }
          : evidenceDecision;
      if (decision.status === "provisional") { result.provisional++; continue; }
      if (!decision.confirmed || !decision.confirmedAt) { result.rejected++; continue; }
      // Honest confidence: cross_verified only with >=2 independent sources; a
      // single-source authoritative lead is labelled kinetic_new_fiber.
      const confidence = decision.sources.length >= 2 ? "cross_verified" : "kinetic_new_fiber";
      result.confirmed++;

      let found = findBySource.get(tenantId, candidate.id) as any;
      let leadId = found?.id as number | undefined;
      // A stable converted link is the publication idempotency boundary. Do not
      // rewrite updated_at or churn the map ETag on every unchanged rescan.
      if (candidate.converted_to_lead_id != null && leadId === candidate.converted_to_lead_id) {
        result.linkedExisting++;
        result.leadIds.push(leadId);
        continue;
      }
      result.published++;
      const assignment = territoryAssignmentFor(tenantId, candidate.lat, candidate.lng);
      if (!leadId) {
        const addressMatch = findByAddress.get(candidate.address, candidate.city, candidate.state, tenantId) as any;
        if (addressMatch && Number(addressMatch.tenant_id) !== tenantId) {
          throw new Error(`LEAD_ADDRESS_TENANT_CONFLICT: scan target ${candidate.id}`);
        }
        leadId = addressMatch?.id as number | undefined;
        found = addressMatch;
      }
      const wasUnassigned = !found?.assigned_rep_id;
      if (!leadId) {
        // Persist segment/billing that satisfy the DB fresh-lead guard even when the
        // latest snapshot join is null — fall back to the target's last-conclusive
        // signal so an authoritative lead is never blocked by a null-segment row.
        const leadSegment = candidate.household_segment_type ?? (authoritativeFresh ? "NEW FIBER" : candidate.last_fiber_status);
        const leadBilling = candidate.billing_status ?? candidate.last_billing_status ?? (authoritativeFresh ? "N" : null);
        const created = insert.run(
          candidate.address, candidate.city, candidate.state, candidate.zip ?? "", candidate.lat, candidate.lng,
          candidate.last_fiber_status ?? "new_fiber", candidate.max_download_mbps,
          leadSegment, leadBilling,
          "Confirmed fresh Kinetic fiber with no active-service signal.",
          decision.sources.length >= 2
            ? `Unavailable-to-fiber flip; independently confirmed by ${decision.sources.slice(1).join(", ")}.`
            : "NEW FIBER + billing N (authoritative Kinetic new-build signal).",
          tenantId, candidate.id, decision.confirmedAt, confidence, JSON.stringify(decision.sources),
          assignment?.repId ?? null, assignment?.territoryId ?? null,
          assignment?.repId ?? null,
        );
        leadId = Number(created.lastInsertRowid);
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
    structuredLog("fresh_fiber.projected", {
      tenantId, confirmed: result.confirmed, created: result.created, linkedExisting: result.linkedExisting, published: result.published,
      targets: result.leadIds.length,
    });
  }
  return result;
}
