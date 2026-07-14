# Kinetic evidence scanner

The field-map scanner includes the confirmed Kinetic token and address-search
contract in `server/scanner.ts`, guarded by `KFS_AUTOMATION_AUTHORIZED`. Tokens
remain in server memory and refresh from their returned expiry. The separate
evidence command center still defaults to `offline` until its configured mode
and runtime adapter match. Decodo is transport rather than evidence and is not
used for CAPTCHA avoidance, authorization bypass, or continued access after
denial.

## Evidence modes

- `approved_api`: available only when a reviewed adapter for an approved contract is registered server-side.
- `authorized_public_lookup`: additionally requires an administrator to confirm the exact automated use is permitted.
- `authorized_import`: ingests strict CSV or JSON records from an approved source.
- `manual_verification`: records a signed-in reviewer’s evidence and note.
- `offline`: performs no live requests while preserving the dashboard, imports, evidence history, map, transitions, exports, and lead workflow.

Changing the configured mode does not create a live adapter. The configured mode and registered runtime adapter must match before qualification or recheck calls are allowed.

## Live-source safety boundary

Future approved/public adapters implement `KineticEvidenceSourceAdapter`. One gateway provides:

- one stable server-side source identity;
- maximum concurrency of one;
- in-flight request deduplication;
- successful-result caching;
- configurable minimum delay;
- immediate circuit opening on 401/403 denial or CAPTCHA/challenge;
- circuit opening after three rate-limit responses;
- no state mutation for denial, challenge, rate limit, transport failure, or inconclusive evidence.

The command-center gateway does not invent additional endpoints or identifiers;
the confirmed field-scanner contract is isolated in `server/scanner.ts`.

## Approved imports

`POST /api/kinetic-scanner/imports` accepts either:

- JSON: `{ "format":"json", "sourceName":"…", "records":[…] }`
- CSV: `{ "format":"csv", "sourceName":"…", "content":"…" }`

Required evidence fields are `address`, `city`, `state`, `zip`, `observedAt`, `technologyType`, `isLive`, and `sourceName` (the envelope supplies `sourceName`). Optional fields are `unit`, `evidenceId`, `sourceReference`, `latitude`, `longitude`, `maximumQualification`, `isComingSoon`, and `isCopperUpgradeCandidate`. Unknown fields are rejected. Each record stores its evidence mode, source, source evidence ID, observation time, parser version, SHA-256 response hash, and raw approved payload.

CSV headers use snake case: `address`, `city`, `state`, `zip`, `observed_at`, `technology_type`, `is_live`, plus the optional equivalents documented in the UI. Boolean values are limited to true/false, 1/0, yes/no, or blank for inconclusive.

The authenticated webhook-import route uses the same strict JSON records and audit ledger. It is not an unauthenticated public webhook and therefore does not invent a secret-delivery contract.

## Manual verification

`POST /api/kinetic-scanner/manual-verifications` requires an authenticated manager/admin, a complete postal address, observation time, explicit or inconclusive availability, technology when known, and a reviewer note. The actor ID is included in the source provenance.

## Fresh-fiber truth

“Fresh” remains a transition claim:

1. First conclusive fiber-live evidence is `BASELINE_FIBER`, never fresh.
2. Earlier conclusive non-fiber evidence establishes a baseline.
3. Later explicit fiber-live evidence opens `CANDIDATE_FRESH` with an interval-censored detection window.
4. A separate later positive record promotes it to `VERIFIED_FRESH` (default two confirmations).
5. Inconclusive, denied, challenged, throttled, future-dated, malformed, or replayed evidence does not advance truth.
6. A later conclusive non-fiber result marks the episode `REGRESSED`.

## Map and operations

The map continues to consume one slim clustered GeoJSON source and calls `setData()` as imported/manual/approved evidence arrives. Durable import batches, evidence records, observations, transition episodes, provider health, job items, audit events, contacts, exports, and lead conversion remain tenant-scoped.

Sequential range scanning is disabled because no permitted enumeration contract currently exists. Sequential ID and Kinetic Address ID remain nullable passive fields that may be displayed only if a future approved source explicitly supplies them.
