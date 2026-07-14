# Fresh Fiber Moat Operations

Observed and verified: 2026-07-14. This runbook describes the evidence boundary,
operating cadence, and remaining production constraints for the NC/SC monitor.

## 1. Closed gaps

- The former 820-place Census inventory was planning metadata but could be
  scheduled as if every place were a Kinetic market. Only official-directory or
  official-announcement markets are now `auto_scan_eligible`.
- The carrier directory's “other high-speed internet” places were previously
  absent from the change detector. They are now explicit
  `verified_legacy_service` targets: useful places to watch for the next upgrade,
  but never represented as evidence that fiber is currently available.
- A single Kinetic answer could create a lead. Kinetic-only flips are now
  provisional; the isolated confirmation gate is the sole path into `leads`.
- Generic independent “available” observations could corroborate fiber. Evidence
  must now be recent, non-future, independently sourced, address-level, and
  explicitly FTTP/FTTH/fiber.
- Baseline-live results could be called fresh. Fresh now requires a persisted,
  conclusive unavailable-to-available transition.
- Replayed run targets could duplicate history. Snapshot identity is unique by
  tenant, run, and target; lead and alert projection are also idempotent.
- Alert delivery lacked tenant leases and durable retry state. The outbox is now
  tenant-scoped, leased, exponentially retried, and poison messages park after
  eight attempts.
- One newly checked door could postpone a whole city. Unscanned inventory is due
  immediately; otherwise the oldest checked address drives market cadence.
- Block rate, conclusive rate, throughput, provider latency, inventory coverage,
  and detection-to-alert p50/p95 are exposed to the command dashboard.

## 2. Evidence-backed NC/SC target map

The active catalog contains 132 normalized physical markets: 108 in North
Carolina and 24 in South Carolina. The evidence tiers must not be conflated:

- 63 current-fiber or officially announced fiber targets: 54 NC and 9 SC.
- 69 carrier-listed “other high-speed internet” change-watch targets: 54 NC and
  15 SC. These prove Kinetic territory presence only, not fiber availability.

The catalog normalizes the duplicate Mt Pleasant/Mount Pleasant label, folds
China Grove-Landis and St Matthews aliases into their physical markets, and
keeps Landrum only in its correct state, South Carolina. Hemby Bridge is included
as an announced expansion target from the official Q4 build release; it is not
misrepresented as currently listed in the carrier directory's fiber subsection.

Current-fiber or announced targets — North Carolina (54): Aberdeen, Albemarle,
Badin, Broadway, Cameron, Charlotte, China Grove, Columbus, Concord, Cornelius,
Davidson, Denton, Gold Hill, Granite Quarry, Harrisburg, Huntersville, Indian
Trail, Kannapolis, King, Landis, Lewisville, Lexington, Linwood, Marshville,
Marvin, Matthews, Midland, Mint Hill, Monroe, Mooresville, Morven, Mount Pleasant,
New London, Norwood, Oakboro, Peachland, Pfafftown, Pinebluff, Polkton, Richfield,
Rockwell, Rural Hall, Salisbury, Sanford, Stallings, Stanfield, Thomasville,
Tryon, Wadesboro, Waxhaw, Weddington, Wingate, Winston-Salem, and Hemby Bridge.

Current-fiber targets — South Carolina (9): Cameron, Campobello, Inman, Kershaw,
Landrum, Lexington, Saint Matthews, Spartanburg, and West Columbia.

Other-high-speed change-watch — North Carolina (54): Ansonville, Lilesville,
McFarlan, Bear Creek, Goldston, Moncure, Hayesville, Southmont, Welcome, Bethania,
Clemmons, Old Town, Stanleyville, Tobaccoville, High Point, Lillington, Olivia,
Raeford, Olin, Statesville, Troutman, Lemon Springs, Otto, Scaly Mountain,
Carthage, Jackson Springs, Pinehurst, Southern Pines, Green Creek, Lynn, Mill
Spring, Saluda, Randleman, Hoffman, Marston, Red Springs, Cleveland, Faith, Mount
Ulla, Rutherfordton, Gibson, Laurinburg, Laurel Hill, Wagram, Locust, Misenheimer,
Germanton, Pinnacle, Westfield, Lake Park, Mineral Springs, New Salem, Wesley
Chapel, and New Hill.

Other-high-speed change-watch — South Carolina (15): Creston, Fort Motte,
Jefferson, Bethune, Camden, Liberty Hill, Westville, Heath Springs, Gilbert,
Swansea, Elloree, North, Orangeburg, Gramling, and Wellford.

Primary evidence:

- Kinetic NC fiber directory: https://www.gokinetic.com/locations/nc
- Kinetic SC fiber directory: https://www.gokinetic.com/locations/sc
- Q1 2026 NC build release: https://investor.uniti.com/news-releases/news-release-details/north-carolina-benefits-7800-new-kinetic-fiber-builds
- Q4 2025 NC build release: https://investor.uniti.com/news-releases/news-release-details/north-carolina-benefits-7600-new-kinetic-fiber-builds/

`state_fiber_markets` retains the broader Census inventory for research, but
unverified places have `auto_scan_eligible=0`. `market_evidence` records the
source, evidence tier, observed time, and content hash for every eligible market.
The weekly directory watcher reads both the explicit fiber subsection and the
full state location index. It may promote a legacy market when the publisher
moves it into the fiber subsection, but a partial response never removes a known
market. Address inventory is harvested per market; empty/failed coverage is
explicit and retried with backoff rather than silently treated as complete.

## 3. Hardened scan engine

The durable path is:

```
verified market -> address inventory -> ranked scan_run_targets
                -> atomic claim -> shared provider queue -> snapshot/diff
                -> independent evidence gate -> lead/outbox/map
```

- Runs and targets are durable, budgeted, atomically claimed, resumable, and
  periodically reaped after stale heartbeats.
- One provider queue supplies bounded concurrency, in-flight de-duplication, a
  bounded conclusive-result cache, AIMD backpressure, measured latency, and
  exponential retry for transient failures.
- Authentication failures, challenges, throttles, malformed responses, and
  timeouts are inconclusive. They never become “no service.”
- Live state scanning requires both `ENABLE_STATE_MONITORING=true` and
  `STATE_MONITOR_LIVE=true`; daily and per-market budgets are hard limits.
- Requests use one stable, authorized provider identity and a descriptive user
  agent. The system does not rotate identities or headers, solve CAPTCHA, or
  bypass a provider challenge.
- Legacy Kinetic/CNS producers normalize their observations through
  `persistKineticObservation`; they do not publish leads. That adapter writes the
  evidence history and invokes `projectConfirmedFreshLeads`, the sole operational
  fresh-lead projector.
- Database insert/update triggers fail closed if any path tries to label a lead
  as new fiber without a source scan target, confirmation timestamp,
  `cross_verified` confidence, the `fresh_fiber_confirmed` tag, and at least two
  recorded source identifiers. This is defense in depth beneath route logic.

The current SQLite queue is durable and safe for concurrent workers within one
application host. It is not a horizontally distributed queue; see risks below.

## 4. Fresh confirmation law

A door becomes an operational lead only when all conditions hold:

1. A persisted, conclusive historical snapshot proves fiber was unavailable.
2. A later conclusive Kinetic snapshot proves fiber is currently available,
   creating an unavailable-to-fiber transition rather than a baseline-live hit.
3. The provider signals `new_opportunity` / no active service.
4. A distinct licensed or field source reports address-level availability.
5. The independent technology is explicitly fiber, FTTP, or FTTH.
6. Evidence is no earlier than seven days before detection, no later than 31 days
   after detection, and no more than five minutes in the future.

Otherwise the record remains provisional, rejected, or regressed with
machine-readable reasons. Cable, unknown technology, stale evidence, future
evidence, baseline availability, current inconclusive results, and
existing-customer signals cannot enter the knock list.

Accepted independent-source identifiers are `fcc_bdc_licensed`,
`carrier_partner_feed`, `third_party_licensed`, and `field_verification`.
Admin-authenticated records enter through `POST /api/monitor/corroboration`;
repeated evidence hashes are ignored, and importing evidence retries projection
immediately without duplicating a lead. The FCC data is useful corroboration but
is not a same-day event feed. Exact address/BSL joins require authorized access
to the Location Fabric.

## 5. Alert and map behavior

Confirmed new-opportunity points are clustered within 250 meters and ranked by
density, recency, and confirmation count. The stable cluster revision hashes
sorted target IDs and first-detected timestamps, so retries do not create a new
event.

- Webhook delivery includes an idempotency key and an internal cluster map link.
- Email delivery uses the existing SMTP/Resend configuration.
- The lead map cache is invalidated immediately after projection. Confirmed points
  carry `fresh_fiber_confirmed` and `cross_verified`, render with a GPU halo, and
  contribute to a confirmed-fresh cluster ring.
- A tenant-scoped server event invalidates connected field maps immediately; it
  contains no lead data, and clients refetch through normal role scoping. A
  conditional 60-second poll remains the mobile reconnect fallback.
- If a confirmed point lies in exactly one active territory, it is assigned to
  that territory's rep automatically. No territory or overlapping territories
  remain in the manager dispatch pool; the system never guesses across teams.
- CSV exports neutralize spreadsheet formulas before quoting values.

## 6. Cadence and priority

- `critical`: 13 recently announced expansion markets, every 24 hours:
  Albemarle, Broadway, Concord, Granite Quarry, Hemby Bridge, Indian Trail,
  Kannapolis, Lexington, Morven, Pinebluff, Sanford, Tryon, and Wingate.
- `medium`: current-fiber or legacy Kinetic-service markets with Census
  population at least 25,000, every 168 hours (weekly).
- `low`: smaller/rural current-fiber markets and other-high-speed change-watch
  markets, every 336 hours (14 days).
- Unverified Census places: planning only, no automatic provider spend.
- Official location directories: checked weekly with conditional HTTP requests
  from one stable, descriptive identity. Announcements are polled separately;
  partial publisher responses never delete known markets.
- While coverage gaps remain, each scheduler tick harvests one verified market's
  address inventory without postponing an otherwise-due provider scan.

Within a market, never-scanned addresses run first, then the oldest checked and
highest-opportunity addresses. A scheduler tick starts at most one durable market
run, respects the shared billing gate, and will not overlap an existing run.

## 7. Verification run

The deterministic production-flow test creates four previously unavailable
addresses, flips three to Kinetic fiber, leaves one unavailable, then simulates a
crash replay of one target. It imports valid FCC-fiber evidence for two flipped
doors and cable evidence for the third.

Expected and observed:

- 4 logical checks -> 4 snapshots after replay, not 5.
- 3 Kinetic flips -> 3 provisional points and 0 leads before corroboration.
- 2 valid fiber confirmations -> exactly 2 confirmed leads.
- 1 cable corroboration -> remains provisional.
- 2 territory-matched leads -> visible to the assigned field rep.
- 1 stable cluster alert -> 1 webhook delivery with 2 addresses and an internal
  map link; repeating evidence and alert flush creates no duplicates.

Run the focused proof with:

```
npm test -- --run tests/integration/fresh-fiber-moat.test.ts
```

Operational reads:

- `GET /api/monitor/summary?days=7`
- `GET /api/monitor/operations?hours=24`
- `GET /api/monitor/markets?eligibility=verified`
- `GET /api/monitor/schedule`
- `GET /api/monitor/knock-list.csv?days=30`

## 8. Remaining risks and legal/terms notes

- Production currently uses SQLite and an in-process scheduler. Before running
  multiple application hosts, migrate run claiming and scheduling to PostgreSQL
  plus a queue/leader-election mechanism; a shared SQLite file is not a safe
  distributed deployment model.
- FCC corroboration is an authenticated import boundary, not an automated Fabric
  downloader. Automating it requires the organization's licensed Fabric/BDC
  entitlement, dataset-specific schema mapping, and provider-brand matching.
- Legacy global uniqueness on `scan_targets.address` and older lead-address
  indexes should be migrated to tenant + normalized-address identity before
  onboarding multiple scanning tenants at large scale.
- Email and webhook currently share one outbox row. A failure after one channel
  succeeds can retry that successful channel; receivers must honor the
  idempotency key until delivery is split per channel.
- Carrier directories prove market presence, not address serviceability. Only
  snapshots and the confirmation gate may make an address claim.
- Kinetic terms and automation permissions can change. Use a licensed API,
  partner feed, or written authorization for bulk checks. A block or CAPTCHA is a
  stop/backoff signal, not permission to evade controls. Do not rotate proxy
  identities, spoof headers, or bypass access controls.

Relevant official references:

- Kinetic legal terms: https://www.gokinetic.com/about/legal/terms-and-conditions
- Kinetic online terms: https://www.gokinetic.com/about/legal/kinetic-online-terms
- Kinetic Acceptable Use Policy: https://www.gokinetic.com/about/legal/Acceptable-Use-Policy
- FCC map contents: https://help.bdc.fcc.gov/hc/en-us/articles/13532984820379-What-s-on-the-National-Broadband-Map
- FCC map usage: https://help.bdc.fcc.gov/hc/en-us/articles/10467446103579-How-to-Use-the-FCC-s-National-Broadband-Map
- FCC Location Fabric access: https://help.bdc.fcc.gov/hc/en-us/articles/10419121200923-How-Entities-Can-Access-the-Location-Fabric
