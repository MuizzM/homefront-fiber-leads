# Scan Operations

## Admission and throughput

Authorized scan routes do not have a starts-per-hour quota. JWT role checks,
tenant isolation, subscription policy, request validation, and cost controls
still apply. Every address-level provider request enters one process-wide FIFO:

```
area/city/nightly jobs -> shared provider queue -> Kinetic availability check
                              |          |
                         in-flight     short conclusive
                         dedupe        result cache
```

`SCAN_PROVIDER_CONCURRENCY` controls simultaneous upstream checks, not how many
scans an operator may start. Keep it conservative because every scan shares the
same provider identity and rolling allowance. The default is 8; the accepted
range is 1–64. Monitor `GET /api/scanner/state` for active work, queue depth,
cache hits, dedupes, average wait, duration, and errors before increasing it.

`SCAN_RESULT_CACHE_MS` defaults to five minutes. Only conclusive results are
cached. A timeout, authentication failure, throttle, challenge, malformed
response, or unknown status remains `RECHECK` and can never become a cached No.

## Unified field-box scan

There is no Quick/Deep decision in the field map. Committing a drawn box starts
`POST /api/scan/area` immediately, and every request uses the same server-owned
strategy:

1. Query OpenStreetMap and the local GIS pool.
2. For an ordinary neighborhood-sized box, concurrently sample Mapbox at no
   more than `0.0012°` spacing (about 130 m, with up to five nearby addresses per
   sample) so new streets missing from OSM are still found.
3. Union and normalize all candidates before checking availability through the
   registered, approved evidence adapter. Without one, retain every rooftop as
   `verification_required`; never manufacture a fresh/no-service answer.

The automatic Mapbox augmentation is enabled only when its dense plan is at or
below `AREA_AUTO_GRID_POINTS` (default 900) and `MAPBOX_TOKEN` is configured.
Larger boxes invisibly use mapped sources rather than coarsening the grid into a
less trustworthy sweep or creating unbounded geocoding spend. This makes a
tight subdivision box as thorough as the former Deep path while avoiding a mode
prompt and keeping large-area work bounded.

The field-map discovery worker uses this augmentation directly; it does not
depend on the legacy `/api/scan/area` path. Mapbox requests use conservative
bounded concurrency, a minimum source interval, discovery-cache deduplication,
and immediate stop behavior on access denial or rate limiting.

Address discovery and provider qualification are separate trust boundaries.
Mapbox, OSM, GIS, and approved uploads locate rooftops but do not prove Kinetic
availability, freshness, or customer billing state. Qualification uses only a
registered `KineticEvidenceSourceAdapter`. Decodo may be stable transport inside
a reviewed adapter for a permitted contract; it is not evidence and is never
used to bypass authentication, challenges, or rate controls.

The client polls incrementally and appends qualifying rows to one clustered
GeoJSON source. It reports checked addresses, fresh matches, and leads dropped.
The selection rectangle is cleared on completion, provider error, start error,
or cancellation, so another box can be drawn immediately without a cooldown.

## Result contract

The business answer is deliberately small:

- `PRIMARY FLIP / provisional`: a persisted unavailable observation later
  becomes serviceable fiber with billing status `N`.
- `CONFIRMED FRESH / knockable`: that primary flip also has recent independent
  address-level FTTP/FTTH/fiber evidence.
- `NO / Not fresh fiber`: the provider returned a conclusive answer that does
  not satisfy all three signals.
- `RECHECK / Couldn't verify`: the provider did not return trustworthy evidence.

A first-seen live address is a baseline, not fresh. Only `CONFIRMED FRESH`
creates or refreshes a rep-facing map lead; provisional results remain visible
to managers with their confidence. Target identity, snapshot uniqueness, the
projector, and outbox keys make retries idempotent.

## Failure and recovery

- Provider requests are queued globally, so starting another job cannot create
  another independent concurrency burst.
- Identical in-flight address checks share one promise.
- Existing bounded retries use jittered exponential backoff for transient
  network failures and typed 403 backpressure.
- A 401 refresh is attempted once inside the same queue slot.
- Mobile polling never overlaps. After two missed progress responses the map
  displays a reconnecting warning while the server job continues.
- Budgeted market runs are stored in `scan_runs` / `scan_run_targets` and resume
  after a process restart. Legacy area/city jobs remain visible for the life of
  the server process; use budgeted runs for long-running market sweeps that must
  survive a deployment.

## Observability

Provider queue events are emitted as one-line structured JSON. Street addresses
are not logged; a short SHA-256 key correlates queued, started, completed, cache,
dedupe, and failure events. Availability evidence remains in the database under
tenant controls.

Useful endpoints:

- `GET /api/scanner/state` — live queue and legacy worker metrics.
- `GET /api/scan/engine-status` — adaptive congestion-window metrics.
- `GET /api/scan/:jobId?since=N` — incremental field-scan progress.
- `GET /api/scan/runs/:id` — resumable market-run progress and cost.

## Upstream authorization and terms

Use an officially licensed API, partner integration, or written authorization
for automated availability checks. Kinetic's online terms incorporate its
Acceptable Use Policy and other click-through/product terms, and those terms can
change. Review the agreement attached to the credentials in use:

The repository does not ship a consumer-form adapter or assume a Kinetic URL,
token, device identifier, request schema, response schema, or enumerable ID.
Register a reviewed `KineticEvidenceSourceAdapter` only after the exact contract
and authorization are documented. Until then the runtime remains offline and
field scans return rooftop inventory marked for verification.

- https://www.gokinetic.com/about/legal/terms-and-conditions
- https://www.gokinetic.com/about/legal/kinetic-online-terms
- https://www.gokinetic.com/about/legal/Acceptable-Use-Policy

This implementation deliberately does not rotate identities, spoof users, solve
CAPTCHAs, or bypass a bot wall. A challenge or access denial is a non-answer and
must be surfaced as `RECHECK`. If volume exceeds the authorized channel, obtain
a licensed bulk endpoint rather than increasing concurrency or rotating proxies.
