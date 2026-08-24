# Scan Operations

## Admission and throughput

Authorized scan routes do not have a starts-per-hour quota. JWT role checks,
tenant isolation, subscription policy, request validation, and cost controls
still apply. Every address-level provider request enters one distributed
priority queue backed by the shared application database:

```
manual/lasso/coming-soon/city jobs -> shared provider queue -> Kinetic check
                              |          |
                         in-flight     short conclusive
                         dedupe        result cache
```

`SCAN_GLOBAL_CONCURRENCY` is the authoritative simultaneous-search ceiling
across every application instance and token. It defaults to 50 and is clamped
to 50. `SCAN_PROVIDER_CONCURRENCY` caps local queue waiters. All instances must
share the same `DATA_DIR` database for distributed admission. Monitor
`GET /api/scanner/state` for active work, queue depth, cache hits, dedupes,
average wait, duration, and errors.

`SCAN_RESULT_CACHE_MS` defaults to five minutes. Only conclusive results are
cached. A timeout, authentication failure, throttle, challenge, malformed
response, or unknown status remains `RECHECK` and can never become a cached No.

`SCAN_PROVIDER_REQUESTS_PER_MINUTE` is the database-backed aggregate rolling
minute request-start ceiling. Its code default is 30,000 (server/scanner.ts),
so in practice `SCAN_GLOBAL_CONCURRENCY` is the binding throttle; set the
per-minute knob explicitly when a provider agreement names a rate. `KFS_TOKEN_POOL_MAX` enables
up to 100 server-memory token slots, and `KFS_TOKEN_MAX_CHECKS` defaults to 100
different normalized address hashes per token lifecycle (10,000 maximum cohort
capacity);
`KFS_TOKEN_POOL_WARM_MIN` defaults to two, so the server does not mint hundreds
of unused tokens. READY tokens are leased by lowest checks-used, then lowest
in-flight count and round-robin sequence, and refreshed
60 seconds before expiry with per-slot single-flight locks. A pool-wide refresh
semaphore (default two) also prevents simultaneous slot expirations from
stampeding the token endpoint. Manual checks have the highest priority, followed
by lasso, Coming Soon/recheck, market, and city.
A 429 writes a global pause until `Retry-After` while retaining work. A 403
globally halts provider work and requires the explicit admin recovery action.

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

## Once only: an answered door is never bought twice

`SCAN_ONCE_ONLY` (default on, `@shared/scanPolicy`) is the scanning law. A
target that carries a conclusive provider answer (`last_scanned_at IS NOT
NULL`) is never bought again by a bulk producer. It is enforced inside
`claimRunTargets` (`server/scanIntelStore.ts`), the one chokepoint every
producer funnels through, so no selector can bypass it by writing its own SQL.

Why: measured on the production-shaped copy, 55,503 of 78,058 NC Kinetic
checks (71%) were repeats of addresses already answered - one address was
bought 65 times - and they produced zero Kinetic fiber. Every one of the 25
negative-to-fiber flips in all recorded history was a Frontier door in Durham.
Meanwhile 311,933 NC doors have never been checked once. A re-check is not
competing with nothing; it is competing with a door we have never touched.

Exemption is decided by ONE predicate, `isRecheckExemptKind`
(`@shared/scanPolicy`), which the claim guard asks directly and from which
`dedupSkipSecondsForRun` derives its zero. Do not add a second place that
decides this. Exempt kinds:

- **Rep actions.** Kinds containing manual / lasso / bbox / area / field. A
  rep's tap always re-verifies.
- **Change detection.** recheck / rescan / nightly / scheduled / monitor /
  watch - which is how the coming ledger collects on a promise on its due date,
  and why the confirm tier is named `fresh_sweep_confirm_recheck` (as
  `fresh_sweep_confirm` it skipped 100% of its own targets).
- **Frontier runs**, because a recent Kinetic verdict says nothing about
  Frontier serviceability.

Exemption used to be inferred from "the dedup window is zero", which coupled
the law to an unrelated knob: `SCAN_DEDUP_RECHECK_HOURS=0` silently switched
once-only off for every producer. It no longer does.

`NEIGHBORHOOD_SWEEP_RESCAN_NEGATIVES=on` restores the 21-day flip watch inside
hot cells (those runs go out as `fresh_sweep_flood_recheck`, an exempt kind, or
the law would drop every one of their targets); `SCAN_ONCE_ONLY=off` restores
the old 18-hour window everywhere. Neither needs a code change. Revisit when a market's unscanned pool is
exhausted - that, not the flip rate, is what makes a re-check worth buying.

## The coming ledger: doors the provider says will turn on

Both carriers state future service, and until 2026-08-22 the code read none of
it (`server/comingLedger.ts`, `shared/futureService.ts`):

- **Kinetic** sends `broadbandService.{futureQual, technologyType:
  "FUTURE_QUAL_EXTENDED", futureTechnologyType, estimatedCompletionDt}`. The
  date is a month, e.g. `"NOV-2026"`, or the undated sentinel `"Future Fiber
  Build Planned"`. Measured over 22,242 stored bodies (`fiber_checks.result`):
  476 NC doors with a real month - Harrisburg FEB-2027 (131), Indian Trail
  MAR-2027 (125), Monroe NOV-2026, China Grove, Marshville, Broadway - and 488
  more undated. Every one of those doors is filed today as a terminal negative
  (copper or no_service), which is exactly why the once-only law must exempt
  them.
- **Frontier** sends `isFutureFiberEligible`, `fiberBuildOutStatus: "PENDING"`
  and `futureServiceDate` (a full date): 168 pending builds, 164 dated.

A future answer opens a row in `coming_soon_watchlist` carrying
`promised_date`, `date_source` (`provider`, never invented), `date_path` (the
exact payload path, so the claim is auditable), `provider_quote`, `signals` and
a computed `band` / `due_at`. A settled, live or already-sold answer CLOSES the
row so it stops consuming the one re-check lane.

Scheduling (`nextRecheckAt`): a date already passed or within
`COMING_SOON_HOT_WINDOW_DAYS` (14) is `hot` and re-checked every
`COMING_SOON_HOT_HOURS` (6); a further-out date is not polled at all until its
window opens; an undated promise rides the observed flip window (days 2-14
after first sight) and then relaxes to `COMING_SOON_WATCH_HOURS` (24).

An UNDATED promise ("Future Fiber Build Planned") is re-read every
`COMING_LEDGER_UNDATED_DAYS` (30), not on the daily watch band: the undated
population polled daily would cost roughly 24,000 checks a month, far more than
the once-only law saves. A promise is expired only once its OWN date has passed
and nobody honoured it - measuring staleness by last-touch alone would kill a
FEB-2027 build in November, because a far-future promise is deliberately left
untouched until its window opens.

A promise the provider keeps restating after its date has passed is written off
as `overdue` once it has been collected on `COMING_LEDGER_OVERDUE_CHECKS` times
(default 4; `overdue_checks` counts them). Without that counter the one lane
permitted to re-buy an answered door would spin on it every six hours forever,
and the exception would have eaten the law it is an exception to.

Two dates, never conflated: `first_seen_at` is when a scan FOUND the promise
and `promised_date` is when the provider says it turns on. The backfill stamps
the original `fiber_checks.checked_at`, not the time the row was written, so a
July find is not reported as today's discovery (and does not fall inside the
2-14 day flip window by accident). `comingSummary` returns both: `nextDates`
(turn-on months) beside `foundOn` (discovery days).

`backfillFromStoredEvidence` mines promises out of bodies already paid for -
one shot per process, ~2 s over 22k rows. Measured: **1,327 doors recovered,
525 with a stated month, for zero provider spend.**

`reconcileNowActiveWatches` closes watches whose target is really NEW FIBER
with an active account. The old code admitted those as "coming soon"
(`availabilitySnapshot.ts` `lifecycleSignalOf`), which is why 294 of 330 live
watches were doors somebody had already bought, and none ever flipped.
Measured on the copy: 325 closed on first run.

## The account pin: doors that already have service

When the household is already on the provider's books the answer carries the
account: `address.localAccountNumber`, `accountTier` ("Tier 2" on 706 doors),
`accountSubTier`, `billingSystem` ("CAMS"). Measured over the stored bodies,
1,084 checks across 959 distinct accounts - never read, so a rep could not tell
an existing customer from a cold prospect.

`server/customerAccount.ts` records them on `scan_targets`
(`account_number`, `account_tier`, `account_sub_tier`, `billing_system`,
`account_seen_at`) and the lead sheet shows an "Account" fact with the tier and
a masked tail. The number is customer data: it is never written to a log line
(the event carries the tier and a boolean) and never leaves the server whole -
`maskAccountNumber` yields a four-digit tail. An answer with no account never clears a
stored one, because one silent answer is not evidence a household cancelled.

## Planner statistics (why scans were slow)

`ANALYZE` used to run once, latched by `analyze_done`, so a long-lived install
kept whatever statistics existed the first time. Measured on a
production-shaped copy (application build SQLite 3.49.2): `sqlite_stat1` held
stats for exactly ONE `scan_targets` index and their value was `0 0 0 0`. The
planner therefore chose a tenant-prefixed index and walked all 919k rows for a
24-hour count the range index answers immediately.

Plain `PRAGMA optimize` could not fix it: it only reconsiders tables the current
connection has queried, and the maintenance connection never touches
`scan_targets`. The `0x10002` mask lifts exactly that restriction, and since
SQLite 3.46.0 `PRAGMA optimize` bounds its own ANALYZE work - which is why it is
preferred over running a full `ANALYZE` on a schedule.

`optimizePlannerStats` (server/yieldRollups.ts) follows SQLite's documented
lifecycle for a long-lived connection: `PRAGMA optimize=0x10002` on the first
maintenance tick (and again every `ANALYZE_MAX_AGE_HOURS`, default 24), then
plain `PRAGMA optimize` on every tick after. It runs on the cluster primary,
which serves no HTTP, and never at open, so it cannot delay the health gate.
`ANALYZE_MAINTENANCE=off` disables it.

Measured on the 3.3 GB copy, with no query hints anywhere:

| | before stats | after |
| --- | ---: | ---: |
| `sweepSummary` (every manager poll) | 2,951 ms | 12 ms |
| `buildFrontier` (every cycle) | 2,697 ms | 494 ms |
| the first `0x10002` pass | | 13.8 s, once |
| every later `PRAGMA optimize` | | 0-5 ms |

Two query shapes in the sweep were also rewritten, because they were wrong
regardless of statistics: the pending-rows counter resolves its handful of run
ids before counting instead of joining 803k rows against an unindexed
`kind LIKE` (937 ms -> 82 ms), and the now-active reconciler drives from the
watchlist with a primary-key lookup per row rather than scanning every target
(2,476 ms -> 4 ms). No index is pinned with `INDEXED BY` or suppressed with a
unary `+`: statistics are fixed where they belong and the planner chooses.

## Neighborhood sweep

`NEIGHBORHOOD_SWEEP=on` (control worker only, `server/neighborhoodSweep.ts`)
is the statewide producer for one state (`NEIGHBORHOOD_SWEEP_STATE`, default
NC). It replaces "one or two checks per street" with a strict ladder per cycle
(`NEIGHBORHOOD_SWEEP_INTERVAL_MIN`, default 10). Every tier buys only doors no
other run holds, and `NEIGHBORHOOD_SWEEP_SEED_CITIES`
(default `broadway,wingate,rockwell`) sorts first inside every tier, so the
opening move is the operator's without starving the rest of the state. The
names are bound into the query, not escaped into it, and an empty list is
valid - it simply drops the boost:

0. **Coming due** - collect on promises whose date has arrived
   (`NEIGHBORHOOD_SWEEP_COMING_PER_CYCLE`, 300). The only re-purchase.
1. **Confirm** - known NEW FIBER doors that never became leads.
2. **Street completion** - unscanned doors on a street that already produced
   fiber (`NEIGHBORHOOD_SWEEP_STREET_PER_CYCLE`, 1500). Of 403 NC streets with
   a hit, 264 came back 100% NEW FIBER and the p25 share is 72%, so this is the
   highest-yield check available; ~6,000 such doors exist statewide.
3. **Cell flood** - the rest of a hit cell, street by street.
4. **Probe** - cold cells, one door per street, ranked by neighbour spillover.

Then the original three moves in detail:

1. **Confirm**: re-check doors Kinetic already called NEW FIBER that never
   became leads (no conclusive snapshot, so the projector rejected them).
   Only doors the projector can publish qualify (NEW FIBER, billing N, no
   address review). Capped at `NEIGHBORHOOD_SWEEP_CONFIRM_FRACTION` (0.4) of
   the cycle and `NEIGHBORHOOD_SWEEP_CONFIRM_PER_CYCLE` (600) doors, at most
   once per `NEIGHBORHOOD_SWEEP_CONFIRM_RECHECK_DAYS` (7) per door and at most
   `NEIGHBORHOOD_SWEEP_CONFIRM_MAX_ATTEMPTS` (3) times per 90 days.
2. **Flood**: every 0.01 degree cell (`scan_targets.cell_lat/cell_lng`,
   about 1 km) that has ever produced a hit gets all of its UNSCANNED doors
   enqueued as one run, street by street. Its negatives are only included when
   `NEIGHBORHOOD_SWEEP_RESCAN_NEGATIVES=on`
   (`NEIGHBORHOOD_SWEEP_NEG_RECHECK_DAYS`, 21). Run id
   `nsweep_<tenant>_<cell>_<day>_f<n>`; one open run per cell, at most
   `NEIGHBORHOOD_SWEEP_MAX_FLOOD_RUNS` (12) new flood runs per cycle.
3. **Probe**: cold cells get one address per street (group testing), up to
   `NEIGHBORHOOD_SWEEP_PROBE_PER_CELL` (12), from the share of the cycle
   reserved by `NEIGHBORHOOD_SWEEP_PROBE_FRACTION` (0.25). All of a cycle's
   probes travel in one run (cells in rank order). A hit promotes the cell to
   a flood on the next cycle.

Cells are decided by `shared/neighborhoodSweep.ts`: empirical-Bayes hit rate
(prior from the city), spillover from the eight neighboring cells, official
evidence (announced build markets, FCC likely-2026 build addresses, coming
soon), and two sink rules: a cell with `NEIGHBORHOOD_SWEEP_SINK_CELL_SCANS`
(15) scans and nothing live, or a city with 200+ scans below 0.5% hits and
nothing live, is parked for `NEIGHBORHOOD_SWEEP_PARK_DAYS` (45), after which
it earns one re-probe (and re-parks if nothing changed). Cold cells outside
the footprint gate are parked unless evidence says otherwise.

Each cycle is sized to the measured drain (checks completed in the last hour
times the interval times `NEIGHBORHOOD_SWEEP_OVERSUBSCRIBE` 1.5, between
`NEIGHBORHOOD_SWEEP_FLOOR` 600 and `NEIGHBORHOOD_SWEEP_MAX_PER_CYCLE` 6000)
minus the producer's own queued rows; when its backlog is already twice a
cycle it enqueues nothing. Run kinds contain `fresh`, so they sit in the
DISCOVERY admission class with the 18 h bulk dedup.

On each cycle the sweep also cancels stale `running` runs of other producers
(`NEIGHBORHOOD_SWEEP_SUPERSEDE_KINDS`, heartbeat older than
`NEIGHBORHOOD_SWEEP_SUPERSEDE_HOURS` 24) and skips their queued tails in
2,000-row chunks, because `enqueueRunTargets` drops any target another running
run still holds. This is not housekeeping, it is the precondition for any work
at all: measured on the copy, dead runs held 249,045 never-scanned NC doors
(daily-diff), 20,222 (hot_market), 20,060 (address_discovery) and 207 of the
coming ledger's own promises (coming_soon_watch). The list is EXACT kind names -
the query uses `IN`, not `LIKE`, so `address_discovery` must be named
separately from `discovery`. `manual` and `lasso` are never included: a rep's
work is not ours to cancel. One pass clears up to 500 runs, so a deep backlog
drains over several cycles (measured: 107,383 doors unlocked on the first). With county E911 address points imported
(`POST /api/admin/address-points/import`), `NEIGHBORHOOD_SWEEP_E911` (on)
upserts every structure inside a cell about to flood so the flood is the whole
neighborhood, not the part OSM knew about; a cell is bridged at most
`NEIGHBORHOOD_SWEEP_E911_CELLS` (4) per cycle and once per
`NEIGHBORHOOD_SWEEP_E911_REBRIDGE_DAYS` (30).

Observability: `neighborhood_sweep.cycle` (one line per cycle),
`neighborhood_sweep.superseded`, the `sweep_cycles` table, and
`GET /api/sweep/state`. Managers read `GET /api/sweep/neighborhoods` (Fiber
Intelligence, Neighborhoods tab): cells ranked by fresh leads nobody has
knocked, with the flood run's progress. Admins may `POST /api/sweep/cycle` on
the control worker. The sweep publishes no leads itself; the engine and
`projectConfirmedFreshLeads` do, unchanged.

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
- A mint that never reached the provider at all (undici reports DNS, connect,
  TLS, reset and timeout failures alike as a bare "fetch failed") is not a
  denial and carries no 401/403, so the denial rotation cannot see it. After
  `KFS_MINT_ROTATE_AFTER_TRANSPORT_FAILURES` consecutive such failures (default
  2) the process hands over to the next sticky residential IP, the same way a
  spent IP is retired. Any mint that reaches the provider - a success, a denial,
  a challenge - resets the count. Before this, a run that landed on an
  unreachable residential IP retried the mint every few seconds indefinitely and
  wrote nothing; only killing the worker recovered it, because the sticky port
  offset is randomised per process (observed 2026-08-24 on `run_1_mt7hy05z`:
  26 consecutive mint failures at verified=610). `scan.token.mint_failed` now
  carries `kind` (`auth`, `transport`, or `answered`) and the error `cause`
  chain, which is what makes this diagnosable from the logs alone.
- A CAPTCHA or other non-JSON challenge remains a stop condition: it fails
  closed without rotating the session or changing the egress IP. The transport
  handover above fires only when nothing reached the provider.
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

The field scanner implements the confirmed token → address-search contract in
`server/scanner.ts`. With `KFS_AUTOMATION_AUTHORIZED=true`, it obtains a
short-lived token from `/_internal/precisely/token`, caches it in server memory,
refreshes 60 seconds before expiry, and sends bearer-authenticated requests to
`/api/v1/address/search` through the configured server-side transport. The
authorization gate remains off by
default, and failed/denied requests remain inconclusive rather than becoming a
fiber verdict.

- https://www.gokinetic.com/about/legal/terms-and-conditions
- https://www.gokinetic.com/about/legal/kinetic-online-terms
- https://www.gokinetic.com/about/legal/Acceptable-Use-Policy

This implementation deliberately does not rotate identities, spoof users, solve
CAPTCHAs, or bypass a bot wall. A challenge or access denial is a non-answer and
must be surfaced as `RECHECK`. If volume exceeds the authorized channel, obtain
a licensed bulk endpoint rather than increasing concurrency or rotating proxies.
