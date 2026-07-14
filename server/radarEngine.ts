// ── Radar ingest engine — the transactional truth writer ──────────────────────
// Turns a ProviderObservation into durable, exactly-once truth. Every ingest is
// ONE better-sqlite3 transaction (synchronous → serialized in-process, so
// concurrent workers can't interleave a half-applied state) that:
//   1. appends the observation (idempotent by attempt_key — a replay is a no-op)
//   2. rejects a LATE observation that is older than what we already know
//   3. runs the pure transition decision against the freshest state
//   4. compare-and-set updates target_state (state_version guard)
//   5. opens / advances / closes the transition episode
//   6. enqueues the alert in the outbox (idempotent by dedupe_key)
// Result: OLD→NEW→OLD→NEW = 2 episodes; 100 concurrent identical observations →
// exactly ONE episode and ONE alert; a failure never changes fiber state.
import { rawDb } from "./db";
import {
  decideTransition, opensEpisode, advancesEpisode, closesEpisode,
  DEFAULT_VERIFICATION_RULE, type VerificationRule, type TargetSnapshot, type NormalizedObservation,
} from "@shared/transition";
import type { ProviderObservation, AuthorizedTarget, AvailabilityProvider } from "./providerAdapter";

export interface IngestResult {
  applied: boolean;        // false = replay/no-op
  action: string;
  discoveryState: string;
  episodeId?: number;
  episodeSequence?: number;
  alertKind?: string;
  schemaDrift: boolean;
}

// Ingest one observation for a target. `attemptKey` makes the whole operation
// idempotent — the same logical check (retry, replay, duplicate dispatch) is a
// no-op. Pass a deterministic key for the guarantee to hold.
export function ingestObservation(
  target: AuthorizedTarget,
  obs: ProviderObservation,
  attemptKey: string,
  rule: VerificationRule = DEFAULT_VERIFICATION_RULE,
): IngestResult {
  const fixtureFlag = obs.isFixture ? 1 : 0;
  // Structural guarantee: labelled fixture evidence can NEVER enter a production
  // database. (Per-target mixing is still guarded below for demo/dev envs.)
  if (fixtureFlag && process.env.NODE_ENV === "production") {
    return { applied: false, action: "FIXTURE_REJECTED_IN_PROD", discoveryState: "", schemaDrift: false };
  }
  const scopedKey = `${target.id}:${attemptKey}`;  // attempt_key idempotency is target-scoped
  const tx = rawDb.transaction((): IngestResult => {
    // 1. Read current state (create on first sight, stamping the evidence class).
    let state = rawDb.prepare(`SELECT * FROM target_state WHERE target_id=?`).get(target.id) as any;
    const stateExisted = !!state;
    if (!state) {
      rawDb.prepare(`INSERT INTO target_state (target_id, tenant_id, is_fixture) VALUES (?,?,?)`).run(target.id, target.tenantId, fixtureFlag);
      state = rawDb.prepare(`SELECT * FROM target_state WHERE target_id=?`).get(target.id) as any;
    }

    // 2. FIXTURE/LIVE ISOLATION: labelled fixture evidence must NEVER mix with
    // production evidence on the same target (or vice-versa). Refuse — recording
    // nothing — rather than corrupt a real target's history with scripted data.
    if (stateExisted && Number(state.is_fixture) !== fixtureFlag) {
      return { applied: false, action: "FIXTURE_MIXING_BLOCKED", discoveryState: state.discovery_state, schemaDrift: false };
    }

    // 3. Idempotency: claim the attempt. If it already exists, this is a replay.
    const claimed = rawDb.prepare(
      `INSERT OR IGNORE INTO target_observations
         (target_id, tenant_id, attempt_key, provider_observed_at, ingested_at, raw_segment, normalized_segment, conclusive, outcome, result_category, latency_ms, schema_version, evidence_hash, response_reference, schema_drift, is_fixture)
       VALUES (@tid,@ten,@ak,@pobs,@ing,@raw,@norm,@conc,'pending',@cat,@lat,@sv,@hash,@ref,0,@fix)`,
    ).run({
      tid: target.id, ten: target.tenantId, ak: scopedKey,
      pobs: iso(obs.providerObservedAtMs), ing: iso(obs.ingestedAtMs),
      raw: obs.rawSegment, norm: obs.canonical, conc: obs.conclusive ? 1 : 0,
      cat: obs.conclusive ? "ok" : (obs.failureKind ?? "server"),
      lat: obs.latencyMs, sv: obs.schemaVersion, hash: obs.evidenceHash, ref: obs.responseReference ?? null, fix: fixtureFlag,
    });
    if (claimed.changes === 0) {
      return { applied: false, action: "REPLAY", discoveryState: "", schemaDrift: false };
    }
    const observationId = Number(claimed.lastInsertRowid);

    // An attempt was made — record it (regardless of outcome, incl. a late one).
    const success = obs.conclusive && obs.recognized;  // a genuine availability read
    rawDb.prepare(`UPDATE monitor_targets SET last_attempt_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(target.id);

    // 4. LATE-ARRIVAL GUARD: a conclusive observation OLDER than our newest
    // conclusive knowledge is recorded but must not overwrite newer truth — AND
    // must not regress the freshness columns (freshness writes come AFTER this).
    const lastConclusiveMs = parseIso(state.last_conclusive_at);
    const isLate = obs.conclusive && lastConclusiveMs != null && obs.providerObservedAtMs < lastConclusiveMs;
    if (isLate) {
      // Preserve the drift signal on a late unrecognized observation (a late
      // provider relabel should still surface in schemaDriftObservations).
      finalizeObservation(observationId, "STALE_LATE", obs.conclusive && !obs.recognized);
      return { applied: false, action: "STALE_LATE", discoveryState: state.discovery_state, schemaDrift: obs.conclusive && !obs.recognized };
    }

    // Freshness: a genuine availability read advances last_successful + next_check,
    // FORWARD-ONLY (a not-late-but-slightly-out-of-order read can't drag it back).
    if (success) {
      rawDb.prepare(`UPDATE monitor_targets SET last_successful_observation_at=@t, next_check_at=datetime('now','+6 hours')
                      WHERE id=@id AND (last_successful_observation_at IS NULL OR last_successful_observation_at < @t)`)
        .run({ t: iso(obs.providerObservedAtMs), id: target.id });
    }

    // 4. Build the pure snapshot + decide.
    const openEp = rawDb.prepare(`SELECT * FROM transition_episodes WHERE target_id=? AND status='candidate' ORDER BY episode_sequence DESC LIMIT 1`).get(target.id) as any;
    const snapshot: TargetSnapshot = {
      everObservedSuccessfully: !!state.last_conclusive_at,
      lastConclusiveCanonical: state.last_conclusive_at ? state.canonical_state : null,
      lastNonNewObservedAtMs: state.last_non_new_observed_at ? (Date.parse(state.last_non_new_observed_at + "Z") || Date.parse(state.last_non_new_observed_at)) : null,
      hasOpenCandidate: !!openEp,
      openEpisodeConfirmations: openEp?.confirmation_count ?? 0,
    };
    const norm: NormalizedObservation = {
      canonical: obs.canonical, billingStatus: obs.billingStatus, conclusive: obs.conclusive,
      recognized: obs.recognized, providerObservedAtMs: obs.providerObservedAtMs, ingestedAtMs: obs.ingestedAtMs,
      failureKind: obs.failureKind,
    };
    const d = decideTransition(snapshot, norm, rule);
    finalizeObservation(observationId, d.action, d.schemaDrift);

    if (!d.changesFiberState) {
      // Recognized-conclusive steady state (repeat NEW / repeat non-New with no
      // material change): advance the freshness + late-arrival watermark so a
      // genuinely OLDER observation can never later masquerade as fresh truth.
      // Failures and schema drift are NOT truth — they never advance it. The
      // watermark only ever moves forward (guarded), never backward.
      if (obs.conclusive && obs.recognized && d.action === "NONE") {
        rawDb.prepare(`UPDATE target_state SET last_conclusive_at=@c, last_successful_observation_id=@o, updated_at=datetime('now')
                        WHERE target_id=@t AND (last_conclusive_at IS NULL OR last_conclusive_at < @c)`)
          .run({ c: iso(obs.providerObservedAtMs), o: observationId, t: target.id });
      }
      // Report the REAL persisted discovery state (never a guessed one).
      return { applied: false, action: d.action, discoveryState: state.discovery_state, schemaDrift: d.schemaDrift };
    }

    // 5. Compare-and-set target_state (version guard). Because transactions are
    // serialized, the guard is belt-and-suspenders, but it makes the write's
    // intent explicit and safe if this ever moves to a concurrent store.
    const nextConclusive = obs.canonical;
    const newNonNewAt = obs.canonical !== "NEW_FIBER" ? iso(obs.providerObservedAtMs) : state.last_non_new_observed_at;
    const firstNewAt = obs.canonical === "NEW_FIBER" && !state.first_new_observed_at ? iso(obs.providerObservedAtMs) : state.first_new_observed_at;
    const baselineAt = d.action === "RECORD_BASELINE_NEW" ? iso(obs.providerObservedAtMs) : state.baseline_observed_at;
    const cas = rawDb.prepare(
      `UPDATE target_state SET canonical_state=@cs, discovery_state=@ds, state_version=state_version+1,
          baseline_observed_at=@base, last_non_new_observed_at=@nonnew, first_new_observed_at=@firstnew,
          verified_at=@verat, last_successful_observation_id=@obs, last_conclusive_at=@conc, updated_at=datetime('now')
        WHERE target_id=@tid AND state_version=@ver`,
    ).run({
      cs: nextConclusive, ds: d.discoveryState, base: baselineAt, nonnew: newNonNewAt, firstnew: firstNewAt,
      verat: (d.action === "VERIFY_EPISODE" || d.verifyOnOpen) ? iso(obs.providerObservedAtMs) : state.verified_at,
      obs: observationId, conc: iso(obs.providerObservedAtMs), tid: target.id, ver: state.state_version,
    });
    if (cas.changes === 0) {
      // A concurrent writer already advanced the state — this observation is
      // stale relative to it. Recorded, but not applied. (Unreachable in the
      // synchronous single-process model; kept for correctness under a future
      // concurrent store.)
      return { applied: false, action: "STALE_VERSION", discoveryState: state.discovery_state, schemaDrift: d.schemaDrift };
    }

    // 6. Episode lifecycle + outbox alert (idempotent by dedupe_key).
    let episodeId: number | undefined, episodeSequence: number | undefined, alertKind: string | undefined;
    if (opensEpisode(d.action)) {
      const nextSeq = (rawDb.prepare(`SELECT COALESCE(MAX(episode_sequence),0) AS s FROM transition_episodes WHERE target_id=?`).get(target.id) as any).s + 1;
      // n≤1 → the opening flip is itself the verified transition (no phantom 2nd read).
      const verifyOnOpen = !!d.verifyOnOpen;
      const ep = rawDb.prepare(
        `INSERT INTO transition_episodes (tenant_id, target_id, episode_sequence, previous_state, candidate_observation_id, candidate_at, verification_rule, confirmation_count, verified_observation_id, verified_at, status, detection_from, detection_to, evidence_summary)
         VALUES (@ten,@tid,@seq,@prev,@obs,@at,@rule,1,@vobs,@vat,@status,@from,@to,@ev)`,
      ).run({
        ten: target.tenantId, tid: target.id, seq: nextSeq, prev: snapshot.lastConclusiveCanonical,
        obs: observationId, at: iso(obs.providerObservedAtMs), rule: JSON.stringify(rule),
        vobs: verifyOnOpen ? observationId : null, vat: verifyOnOpen ? iso(obs.providerObservedAtMs) : null,
        status: verifyOnOpen ? "verified" : "candidate",
        from: d.detectionWindow?.fromMs != null ? iso(d.detectionWindow.fromMs) : null,
        to: iso(d.detectionWindow!.toMs), ev: JSON.stringify({ evidenceHash: obs.evidenceHash, firstObservedBy: "HomeFront" }),
      });
      episodeId = Number(ep.lastInsertRowid); episodeSequence = nextSeq;
      alertKind = verifyOnOpen
        ? enqueue(target.tenantId, `primary-reconfirmed:${target.tenantId}:${target.id}:${nextSeq}`, "primary_reconfirmed_new", target.id, episodeId, { detectionWindow: d.detectionWindow, operational: false })
        : enqueue(target.tenantId, `primary-candidate:${target.tenantId}:${target.id}:${nextSeq}`, "primary_candidate_new", target.id, episodeId, { detectionWindow: d.detectionWindow, operational: false });
    } else if (advancesEpisode(d.action) && openEp) {
      episodeId = openEp.id; episodeSequence = openEp.episode_sequence;
      if (d.action === "VERIFY_EPISODE") {
        // Preserve the interval-censored window: detection_to stays the FIRST New
        // observation (set at open) — NEVER widened to the later confirming read,
        // which would overstate how long the address had been live.
        rawDb.prepare(`UPDATE transition_episodes SET status='verified', confirmation_count=confirmation_count+1, verified_observation_id=?, verified_at=?, updated_at=datetime('now') WHERE id=?`)
          .run(observationId, iso(obs.providerObservedAtMs), openEp.id);
        alertKind = enqueue(target.tenantId, `primary-reconfirmed:${target.tenantId}:${target.id}:${openEp.episode_sequence}`, "primary_reconfirmed_new", target.id, openEp.id,
          { detectionWindow: { fromMs: parseIso(openEp.detection_from), toMs: parseIso(openEp.detection_to) ?? obs.providerObservedAtMs }, operational: false });
      } else {
        rawDb.prepare(`UPDATE transition_episodes SET confirmation_count=confirmation_count+1, updated_at=datetime('now') WHERE id=?`).run(openEp.id);
      }
    } else if (closesEpisode(d.action)) {
      // A regression closes the CURRENT active episode — candidate OR verified
      // (the open-candidate lookup above only finds unverified ones). The
      // episode is preserved (status→regressed), never deleted.
      const active = rawDb.prepare(`SELECT * FROM transition_episodes WHERE target_id=? AND status IN ('candidate','verified') ORDER BY episode_sequence DESC LIMIT 1`).get(target.id) as any;
      if (active) {
        episodeId = active.id; episodeSequence = active.episode_sequence;
        rawDb.prepare(`UPDATE transition_episodes SET status='regressed', regressed_at=?, updated_at=datetime('now') WHERE id=?`).run(iso(obs.providerObservedAtMs), active.id);
        // Cancel any not-yet-delivered alert for the now-dead episode — reps must
        // never be dispatched to an address whose "live" claim we've retracted.
        rawDb.prepare(`UPDATE notification_outbox SET status='superseded' WHERE episode_id=? AND status='pending'`).run(active.id);
      }
    }

    return { applied: true, action: d.action, discoveryState: d.discoveryState, episodeId, episodeSequence, alertKind, schemaDrift: d.schemaDrift };
  });
  // BEGIN IMMEDIATE: take the write lock up front so the reordered read-first flow
  // still serializes cleanly under a future multi-process/WAL deployment.
  return tx.immediate();
}

function finalizeObservation(id: number, outcome: string, drift: boolean): void {
  rawDb.prepare(`UPDATE target_observations SET outcome=?, schema_drift=? WHERE id=?`).run(outcome, drift ? 1 : 0, id);
}

// Enqueue an alert exactly once (dedupe_key UNIQUE). Returns the kind if newly
// enqueued, undefined if it already existed (so callers don't double-report).
function enqueue(tenantId: number, dedupeKey: string, kind: string, targetId: number, episodeId: number, payload: any): string | undefined {
  const r = rawDb.prepare(
    `INSERT OR IGNORE INTO notification_outbox (tenant_id, dedupe_key, kind, target_id, episode_id, payload, status)
     VALUES (?,?,?,?,?,?,'pending')`,
  ).run(tenantId, dedupeKey, kind, targetId, episodeId, JSON.stringify(payload));
  return r.changes > 0 ? kind : undefined;
}

// Deliver pending outbox notifications. The outbox row is the durable ledger;
// enqueue is EXACTLY-ONCE (dedupe_key UNIQUE). Delivery here is AT-LEAST-ONCE by
// design — a crash between a successful deliver() and the status flip re-delivers
// — so the channel MUST be idempotent by dedupe_key. A row is marked 'sent' ONLY
// after deliver() resolves (await catches an async channel's rejection, so a
// failed send is never silently marked delivered); a throwing/rejecting deliver
// bumps attempts and, past maxAttempts, parks the row as 'failed' (no infinite
// poison-retry). Returns how many were newly marked sent.
export async function drainOutbox(limit = 100, deliver?: (row: any) => void | Promise<void>, maxAttempts = 8): Promise<number> {
  if (!deliver) throw new Error("RADAR_DELIVERY_HANDLER_REQUIRED");
  // Radar confirmations are repeated observations from one provider. Keep them
  // analyst-only and isolated from the independently confirmed fresh_fiber
  // outbox; this function must never consume the field-dispatch queue.
  const pending = rawDb.prepare(`SELECT * FROM notification_outbox
    WHERE status='pending' AND kind IN ('primary_candidate_new','primary_reconfirmed_new')
    ORDER BY created_at LIMIT ?`).all(limit) as any[];
  const markSent = rawDb.prepare(`UPDATE notification_outbox SET status='sent', attempts=attempts+1, sent_at=datetime('now') WHERE id=? AND status='pending'`);
  const bump = rawDb.prepare(`UPDATE notification_outbox SET attempts=attempts+1 WHERE id=?`);
  const park = rawDb.prepare(`UPDATE notification_outbox SET status='failed', attempts=attempts+1 WHERE id=?`);
  let sent = 0;
  for (const row of pending) {
    try {
      await deliver(row);
      if (markSent.run(row.id).changes > 0) sent++;
    } catch {
      if (row.attempts + 1 >= maxAttempts) park.run(row.id);
      else bump.run(row.id);
    }
  }
  return sent;
}

// Convenience: check a target through a provider and ingest the result. The
// attemptKey is deterministic per (target, provider-observed-time) so an
// accidental double-dispatch of the SAME check dedups. NEVER spends proxy money
// with a FixtureProvider; with KineticProvider it is live-gated (RADAR_LIVE).
export async function checkAndIngest(provider: AvailabilityProvider, target: AuthorizedTarget, rule?: VerificationRule): Promise<IngestResult> {
  // Authorization gate: never exercise a LIVE provider for a target whose
  // authorized source is inactive or past its authorization window. (Per-source
  // QPS/budget caps belong to the scheduler that selects due targets.) Fixtures
  // spend nothing and are exempt.
  if (!provider.isFixture) {
    const src = rawDb.prepare(
      `SELECT s.active, s.authorization_expires_at FROM monitor_targets t
         JOIN authorized_sources s ON s.id = t.authorized_source_id AND s.tenant_id = t.tenant_id
        WHERE t.id=? AND t.tenant_id=?`,
    ).get(target.id, target.tenantId) as any;
    if (!src || !Number(src.active)) throw new Error("RADAR_SOURCE_INACTIVE: target is not backed by an active authorized source");
    if (src.authorization_expires_at && (parseIso(src.authorization_expires_at) ?? 0) < Date.now()) {
      throw new Error("RADAR_SOURCE_EXPIRED: authorization window has ended");
    }
  }
  const obs = await provider.check(target);
  const attemptKey = `${target.provider}:${target.providerTargetKey}:${obs.providerObservedAtMs}:${obs.evidenceHash.slice(0, 12)}`;
  return ingestObservation(target, obs, attemptKey, rule);
}

function iso(ms: number): string { return new Date(ms).toISOString(); }
function parseIso(s: string | null | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(s.endsWith("Z") ? s : s + "Z");
  return Number.isNaN(ms) ? (Number.isNaN(Date.parse(s)) ? null : Date.parse(s)) : ms;
}
