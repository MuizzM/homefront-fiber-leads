// ── Radar read model — tenant-scoped, no provider internals leaked ────────────
// Read queries for the Market Birth Radar command center. Every query is
// tenant-scoped. Reps never reach these routes; managers/admins see market
// intelligence but NOT raw provider identifiers or credentials.
import { rawDb } from "./db";

const g = <T = any>(sql: string, ...a: any[]): T => rawDb.prepare(sql).get(...a) as T;
const all = <T = any>(sql: string, ...a: any[]): T[] => rawDb.prepare(sql).all(...a) as T[];

export function radarOverview(tenantId: number) {
  const targets = g<{ total: number; active: number }>(
    `SELECT COUNT(*) total, SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) active FROM monitor_targets WHERE tenant_id=?`, tenantId);
  const states = all<{ discovery_state: string; c: number }>(
    `SELECT discovery_state, COUNT(*) c FROM target_state WHERE tenant_id=? GROUP BY discovery_state`, tenantId);
  const stateMap: Record<string, number> = {};
  for (const s of states) stateMap[s.discovery_state] = s.c;
  const episodes = all<{ status: string; c: number }>(
    `SELECT status, COUNT(*) c FROM transition_episodes WHERE tenant_id=? GROUP BY status`, tenantId);
  const epMap: Record<string, number> = {};
  for (const e of episodes) epMap[e.status] = e.c;
  // Radar is an analyst-only same-provider signal. Do not blend the operational
  // cross-verified `fresh_fiber` queue into this counter (or expose that queue
  // to Radar delivery workers).
  const pendingAlerts = g<{ c: number }>(
    `SELECT COUNT(*) c FROM notification_outbox
      WHERE tenant_id=? AND status='pending'
        AND kind IN ('primary_candidate_new','primary_reconfirmed_new')`,
    tenantId,
  ).c;
  const schemaDrift = g<{ c: number }>(`SELECT COUNT(*) c FROM target_observations WHERE tenant_id=? AND schema_drift=1`, tenantId).c;
  // Freshness: targets whose last successful observation is within 7 days.
  // Wrap the stored ISO ('…T…Z') value in datetime() so it is compared in the
  // same normalized form as datetime('now',…) — a raw string compare mixes 'T'
  // and space formats and over-counts on the boundary date.
  const fresh = g<{ c: number }>(
    `SELECT COUNT(*) c FROM monitor_targets WHERE tenant_id=? AND active=1 AND datetime(last_successful_observation_at) >= datetime('now','-7 days')`, tenantId).c;
  const dueBacklog = g<{ c: number }>(
    `SELECT COUNT(*) c FROM monitor_targets WHERE tenant_id=? AND active=1 AND (next_check_at IS NULL OR next_check_at <= datetime('now'))`, tenantId).c;
  return {
    monitoredTargets: targets.active ?? 0,
    totalTargets: targets.total ?? 0,
    freshWithinSla: fresh,
    dueBacklog,
    baselineNew: stateMap["BASELINE_NEW"] ?? 0,
    candidateNew: stateMap["CANDIDATE_NEW"] ?? 0,
    verifiedNew: stateMap["VERIFIED_NEW"] ?? 0,
    primaryReconfirmed: stateMap["VERIFIED_NEW"] ?? 0,
    confirmationScope: "same_provider_reconfirmation",
    operationalLeadEligible: false,
    regressed: stateMap["REGRESSED"] ?? 0,
    openCandidateEpisodes: epMap["candidate"] ?? 0,
    verifiedEpisodes: epMap["verified"] ?? 0,
    regressedEpisodes: epMap["regressed"] ?? 0,
    pendingAlerts,
    schemaDriftObservations: schemaDrift,
  };
}

// Recent transition episodes — the "what changed" feed. Carries the honest
// interval-censored detection window and status. NO provider_target_key /
// dfAddressId (provider internals stay server-side).
export function radarTransitions(tenantId: number, opts: { status?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(Number.isFinite(opts.limit as number) ? (opts.limit as number) : 50, 1), 200);
  const statusFilter = opts.status && ["candidate", "verified", "regressed"].includes(opts.status) ? "AND e.status = ?" : "";
  const args: any[] = [tenantId];
  if (statusFilter) args.push(opts.status);
  args.push(limit);
  return all<any>(
    `SELECT e.id, e.episode_sequence AS episodeSequence, e.status, e.previous_state AS previousState,
            e.candidate_at AS candidateAt, e.verified_at AS verifiedAt, e.regressed_at AS regressedAt,
            e.confirmation_count AS confirmations, e.verification_rule AS verificationRule,
            e.detection_from AS detectionFrom, e.detection_to AS detectionTo,
            t.city, t.state, t.zip, t.lat, t.lng, t.normalized_address AS address
       FROM transition_episodes e JOIN monitor_targets t ON t.id = e.target_id AND t.tenant_id = e.tenant_id
      WHERE e.tenant_id = ? ${statusFilter}
      ORDER BY e.candidate_at DESC LIMIT ?`,
    ...args,
  ).map(r => ({
    ...r,
    verificationRule: safeParse(r.verificationRule),
    confidence: r.status === "verified" ? "primary_reconfirmed" : "single_source_provisional",
    operationalLeadEligible: false,
    // The defensible claim — never "market first".
    claim: "First observed by HomeFront",
  }));
}

export function radarTransition(tenantId: number, id: number) {
  const ep = g<any>(
    `SELECT e.*, t.city, t.state, t.zip, t.lat, t.lng, t.normalized_address AS address
       FROM transition_episodes e JOIN monitor_targets t ON t.id = e.target_id AND t.tenant_id = e.tenant_id
      WHERE e.tenant_id = ? AND e.id = ?`, tenantId, id);
  if (!ep) return null;
  // Evidence timeline (append-only observations for this target), redacted to
  // categories + hashes — no raw provider payloads, no provider ids.
  const evidence = all<any>(
    `SELECT normalized_segment AS state, conclusive, outcome, result_category AS category,
            provider_observed_at AS observedAt, ingested_at AS ingestedAt, evidence_hash AS evidenceHash, schema_drift AS schemaDrift
       FROM target_observations WHERE target_id = ? AND tenant_id = ? ORDER BY ingested_at ASC`, ep.target_id, tenantId);
  return {
    id: ep.id, episodeSequence: ep.episode_sequence, status: ep.status,
    previousState: ep.previous_state, candidateAt: ep.candidate_at, verifiedAt: ep.verified_at, regressedAt: ep.regressed_at,
    confirmations: ep.confirmation_count, verificationRule: safeParse(ep.verification_rule),
    detectionWindow: { from: ep.detection_from, to: ep.detection_to },
    location: { city: ep.city, state: ep.state, zip: ep.zip, lat: ep.lat, lng: ep.lng, address: ep.address },
    confidence: ep.status === "verified" ? "primary_reconfirmed" : "single_source_provisional",
    operationalLeadEligible: false,
    claim: "First observed by HomeFront",
    evidence,
  };
}

function safeParse(s: any) { try { return JSON.parse(s); } catch { return null; } }
