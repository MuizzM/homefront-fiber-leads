# Kinetic Scanner operations

The Kinetic Scanner uses only authorized provider endpoints. It does not bypass authentication, bot controls, account controls, or provider authorization. If the configured provider is unavailable, the scanner records the failure and fails closed instead of manufacturing an availability result.

## Provider contract

Configure `KINETIC_SEQUENTIAL_ENDPOINT` and `KINETIC_ADDRESS_ENDPOINT` for qualification by Sequential ID and Kinetic Address ID. Configure `KINETIC_SEARCH_ENDPOINT` only when the authorized provider contract exposes address search. All credentials remain server-side. `KINETIC_RESPONSE_MAPPING_JSON` maps documented provider fields into the normalized record while the immutable observation ledger retains the raw response and SHA-256 hash.

The adapter exposes four operations: health check, address search, address qualification, and the backward-compatible lookup operation used by scan workers. Responses are normalized only from explicitly configured fields.

## Fresh-fiber truth

“Fresh” is a transition claim, not a synonym for currently live:

1. The first conclusive fiber-live observation becomes `BASELINE_FIBER` and is never labeled fresh.
2. A conclusive non-fiber observation establishes the prior state.
3. A later explicit fiber-live result opens `CANDIDATE_FRESH` with an interval-censored detection window.
4. A repeated positive check promotes the episode to `VERIFIED_FRESH`. The required count defaults to two and is configured with `KINETIC_VERIFICATION_CONFIRMATIONS`.
5. Unknown technology, missing live status, errors, and schema drift never mutate serviceability truth.
6. A later conclusive non-fiber result marks the episode `REGRESSED`.

The UI intentionally distinguishes live baselines, candidates, verified transitions, and regressions. Only verified transitions should be used as the high-confidence fresh-lead signal. “First observed by HomeFront” is the supported provenance claim; the system does not claim market-first detection.

## Worker durability

Sequential scans checkpoint the current Sequential ID and create durable job-item records with lease, attempt, completion, and dead-letter state. On restart, active jobs resume from their checkpoint. Rechecks prioritize fresh candidates first, then regressions and known non-fiber addresses. Provider calls use bounded retries with exponential backoff and the configured request rate.

## Map delivery

`GET /api/kinetic-scanner/addresses/map` returns one slim clustered GeoJSON feed. The Mapbox client mounts once and calls `source.setData()` every time the polling query receives new data, so geocoded results appear during a running scan without rebuilding the map or resetting the rep’s viewport.

## Operational endpoints

- `GET /api/kinetic-scanner/ping` and `/provider-health`
- `POST /api/kinetic-scanner/search-addresses`
- `POST /api/kinetic-scanner/start-scan`, `/pause-scan`, `/resume-scan`, `/stop-scan`
- `POST /api/kinetic-scanner/start-recheck`, `/stop-recheck`
- `GET /api/kinetic-scanner/addresses`, `/addresses/map`, `/addresses/:id`
- `GET /api/kinetic-scanner/transitions`
- `GET /api/kinetic-scanner/jobs/:id/items`

All routes use the existing authenticated capability guards and tenant-scoped parameterized queries.
