# MP Box scan: Tenured / Fresh Fiber filters, persisted history, incremental scanning

Branch `claude/planner-upkeep-first`. Opened 2026-08-23.

## What "MP Box" turned out to be

The term appears nowhere in the codebase - zero matches for `mp box`, `mpbox`,
`mp_box` across server, client, shared, docs and plans. Confirmed with the
operator that it means the **map area/box scan**: draw a box on the map, scan
the addresses inside it. That is `POST /api/scan/area` (+ `/area-estimate`),
`server/bboxScan.ts` (`validateScanBbox`), address enumeration through Overpass
+ GIS + a capped Mapbox grid, then a Kinetic qualification pass.

## The definitions, taken from the project rather than invented

| term | where it is defined | meaning used here |
| --- | --- | --- |
| **Tenured** | `shared/buyerScore.ts:159-160`, persisted as `scan_targets.last_fiber_status='tenured_fiber'` / `is_tenured` | Kinetic's `householdSegmentType === "TENURED"`. Per the operator's decision the filter means ALL tenured doors, regardless of billing. |
| **Fresh Fiber** | `server/freshFiberProjector.ts:299`, `docs/FRESH_FIBER_MOAT.md` | `seg === "NEW FIBER" && billing === "N" && fiberAvailable === true` - the exact predicate the lead projector publishes on. |

Neither threshold needed inventing. What IS configurable and newly introduced:

| knob | default | why |
| --- | --- | --- |
| `MPBOX_CACHE_TTL_HOURS` | 336 (14 days) | How long a classification stays trustworthy. Chosen because the observed provider flip window in this codebase is 2-14 days; shorter re-buys answers for nothing, longer risks serving a stale verdict. |
| `CLASSIFIER_VERSION` | `mpbox-1` | Not an env var on purpose. It is a code fact: bumping it invalidates every cached classification, which is only correct when the RULES changed. |

## Phase 1 findings

**The scan had no persistence at all.** `server/routes.ts:968` holds
`const scanJobs = new Map<string, ScanJob>()`; a box scan mints
`scan_${Date.now()}`, keeps results in a JS array, and streams them over SSE.
Nothing reached SQLite, so a restart lost the history, an interrupted scan could
not resume, and no statistic outlived the process.

**Historical coverage** (26,057 completed Kinetic scans on the production-shaped
copy). Both classifications are fully derivable from what was already stored -
there is no "cannot determine" population for either:

| classification | matched | did not match | cannot determine |
| --- | ---: | ---: | ---: |
| Tenured | 9,558 | 16,499 | 0 |
| Fresh Fiber | 5,261 | 20,000 | 0 |

Data-quality gaps that do exist: `last_customer_segment` is missing or
`'unknown'` on **23,309 of 26,057 (89%)**, and `last_billing_status` is NULL on
7,175 - all of them non-fiber rows, so no Fresh Fiber verdict depends on one.
`last_fiber_status` and `last_is_new_fiber` are 100% populated.

**Existing run bookkeeping is nearly empty**: of 556,529 `scan_runs`, **0** carry
a checkpoint (the column exists and has never been used) and only **80** report
a fiber count.

## SQLite target

Read through the application's own connection, not the shell:

```
sqlite_version 3.49.2   journal_mode wal   foreign_keys 1   synchronous 1
busy_timeout 15000      page_size 4096     auto_vacuum 0    temp_store 2
```

## Schema: extend, do not duplicate

`scan_runs` already has a stable TEXT id, status, started/completed timestamps,
bbox, totals and `current_checkpoint`. It becomes the run header, plus four
columns: `classifier_version`, `filter_snapshot`, `stats_json`, `duration_ms`.

`scan_run_targets` (803,448 rows) is deliberately **not** reused for per-record
results. It belongs to the other producer pipeline and is on a hot path; adding
classification columns there would be write amplification for a feature that
does not need it.

Two new tables: `mpbox_scan_results` (per run x record, PK `(scan_id,
target_id)` - which is what makes a resumed run idempotent) and
`record_scan_state` (the cross-run cache, PK `target_id`).

**One** new index: `idx_mpbox_results_filter (scan_id, is_tenured,
is_fresh_fiber)`. The filter query is always scoped to a run then narrowed by
zero, one or both flags, so every combination is served from a left-most prefix.
Separate per-flag indexes would be redundant prefixes and pure write cost.

## Design contract

Written before any layout change.

- **The screen's real job**: tell an operator what a box scan found, and let
  them narrow it to the doors worth walking.
- **Primary user**: an admin or manager running an area scan. Not a rep.
- **Primary action**: start a scan on the drawn box. It stays visually primary;
  filters are secondary and never outrank it.
- **Information hierarchy**: scan state and progress -> what was found (the
  counts) -> the filtered list of doors. Statistics exist to be acted on, not
  admired.
- **Permitted components**: only what `client/src/components/ui` already ships -
  `button`, `badge`, `checkbox`, `label`, `progress`, `alert`. No new primitive.
- **Filter behaviour**: Tenured and Fresh Fiber are independent toggles. Both
  selected means **AND** - the app has no prior filter-combination convention on
  this surface, and "tenured AND fresh" is what the pair reads as. Documented
  here because it is a decision, not an inevitability. A clear-all action is
  always present when any filter is on. State lives in the URL so a filtered
  view can be linked and restored.
- **Table behaviour**: the door list is a real table with a header row, wrapped
  in `overflow-x-auto` (tables overflow on mobile - UX guideline "Table
  Handling"). Keyset pagination, never offset. Cached rows are visually distinct
  from rows this run classified, because trusting a stale answer is the
  operator's call to make knowingly.
- **Responsive rules**: below `sm` the filter row wraps rather than clipping
  (guideline "Chip Collection Reflow" - never force chips into one clipped row),
  and the stat strip becomes two columns rather than a shrunken six.
- **Required states**: initial (no scan yet) / scanning / results / zero matches
  under filters / no historical scans / partial failure / complete failure /
  cancelled / resumed / success / insufficient historical data. Each is a
  distinct rendered branch, not a spinner standing in for all of them.
- **Rejected outright**: a card grid or bento dashboard; gradients, glass,
  glows; a decorative chart; the words "Overview" or "Insights"; any number that
  is not read from `mpbox_scan_results`; any control that does not perform a
  real action.

## Accessibility commitments

- The live region announces one atomic contextual status ("412 of 800 scanned,
  37 fresh fiber"), never a bare number, and never moves focus - guideline
  "Contextual Live Badge Updates".
- `aria-busy` on the results region while a scan runs.
- Filters are real `<label>`-wrapped checkboxes with visible text, so they are
  reachable and announced without extra ARIA.
- Visible focus rings retained everywhere; nothing relies on hover.
- Touch targets at least 44x44.

## Resources actually used

- `sqlite-engineering` (installed) - applied for the connection inspection,
  migration safety, bound parameters, index justification, transaction
  boundaries, and the `foreign_key_check` / `quick_check` gate.
- `ui-ux-pro-max` (installed) - queried for chip reflow, table overflow, empty
  states, live badge semantics, progress indication.
- `anti-ui-slop` - **NOT INSTALLED**. Substituted with this repo's own
  `docs/DESIGN_SYSTEM.md` (semantic tokens, the currentColor trap, the light
  default) and its house copy rules: no em dashes, no arrows, no emoji, icons
  only in the screen-switcher nav.
- Mobbin MCP - **NOT AVAILABLE**. Not installed and not present in the MCP
  registry. No Mobbin references are cited, because inventing them would be
  fabrication.

## Measurements

Query plans, on the 3.35 GB production-shaped copy:

| query | plan |
| --- | --- |
| records inside the box | `SEARCH scan_targets USING INDEX idx_scan_targets_cell (tenant_id=? AND cell_lat>? AND cell_lat<?)` + `USE TEMP B-TREE FOR ORDER BY` |
| prior state for an id set | `SEARCH record_scan_state USING INTEGER PRIMARY KEY (rowid=?)` |
| filter counts | `SEARCH mpbox_scan_results USING COVERING INDEX idx_mpbox_results_filter (scan_id=?)` |
| filtered keyset page | `SEARCH r USING INDEX sqlite_autoindex_mpbox_scan_results_1 (scan_id=? AND target_id>?)` + PK lookup on scan_targets |

The temp B-tree is accepted, not ignored: the box query orders by `id` for
deterministic resumption while the index is ordered by cell, so a sort is
unavoidable. It is bounded by the cell range and a hard LIMIT - 3,072 rows
sorted inside an 8 ms call. Dropping the ORDER BY would remove the sort and the
ability to resume deterministically, which is the worse trade.

First scan vs repeat, 2,000 records that carry a provider answer:

```
first    23 ms   classified 1502   cache-hit  24.9%
repeat   14 ms   classified    0   cache-hit 100%
identical answers: tenured 376/376, fresh 362/362, matched 738/738
filter counts agree with listResults exactly (376 = 376)
```

Migration on the same copy: **11 ms**, history preserved exactly (556,525 runs /
803,440 run-targets / 919,703 targets unchanged), `foreign_key_check` 0
violations, `quick_check` ok.

## Progress

- 2026-08-23: Phase 1 investigation, schema + migration, incremental engine,
  integration tests, measurements.
- 2026-08-23: filters + status panel built and mounted in the scan sheet; the
  repo's own design gates failed it twice (a hand-rolled bg-black/40 scrim, three
  sub-11px type values) and both were fixed with sanctioned tokens.
- 2026-08-23: publishLeads added - the step that makes a door walkable.

## What a live Rockwell scan established

2,285 never-scanned Kinetic doors, every one recorded, none dropped:

| | |
| --- | ---: |
| sellable NEW FIBER | **584** |
| tenured | 1,103 |
| dropped | 0 |
| elapsed | 15.7 min |

**Rockwell is two cities.** The first 400 doors produced 371 sellable; the next
1,200 produced 122. The rural church roads (Organ Church, Phaniel Church, Lower
Stone, Emanuel, Fisher, Cornelius, Sides) are a recent build-out nobody has
worked; the town core (Howard, Hilbert, Cannon, Link, Shinn) is saturated and
reads TENURED. A single city-level rate is the wrong unit - the street is.

Route list, ranked: Palmer Cir 21/22 (95%), Holshouser 19/28, Cornelius 19/26,
Lower Stone Church 17/37, Old Beatty Ford 16/46, Sam Euart 15/26, Organ Church
14/20, Fisher 14/23. China Grove Hwy is the trap: 53 doors for 11 sellable.

## What limits scanning, measured

Four experiments against the live API, verdicts read from the response BODY:

- **Tokens are portable.** Mint on IP-1, search from IP-2: 20/20. A whole
  earlier branch was built on the opposite belief and had to be unwound.
- **Where a token is minted buys nothing.** Minting from different residential
  IPs (35/60) versus direct (33/60) is a wash. So mint direct.
- **The cap is the (token, search-IP) PAIR at ~20 answers.** One token with
  fresh IPs: 33%. One IP with fresh tokens: 58%. Both fresh: **100%**.
- **The mint endpoint is its own shared rate limit.** That 100% figure is
  SEQUENTIAL. Eight lanes each minting on their own rotation (~5.6 mints/s)
  collapsed to 0.9 answers per pair. One paced minter feeding a pool restored
  12-15. In the final run 496 of 622 mints still failed - minting, not IPs, is
  now the binding constraint.

Decodo sticky ports are **10001-39999** (binary-searched; 40000 is the first
closed one). A base outside the range fails the CONNECTION, which reads exactly
like a provider denial - one run reported "870 denied" when nothing had left the
machine. The range is guarded in code now.

## Still not done

`/api/scan/area` still calls runAreaScan against the in-memory Map. The engine
can publish leads, but the live route does not use the engine yet.
