# Production release and browser measurements — 2026-09-05

## Deployed audit release

Audited commit `266c7bb8d7d1ca214d721713f9cd6d9fc25b495a` was merged in
[PR #213](https://github.com/MuizzM/homefront-fiber-leads/pull/213) and deployed
through [run 33982231000](https://github.com/MuizzM/homefront-fiber-leads/actions/runs/33982231000).
[Exact-SHA CI](https://github.com/MuizzM/homefront-fiber-leads/actions/runs/33981308074)
passed 630 test files / 7,837 tests, both TypeScript checks, the production build
and safety gates. Public health returned healthy / DB up after deployment.
The live HTML fingerprint `77538232daf0` and entry `index-DHYhpM4n.js` matched
the verified build. Previous release: `c7fbd4dfe6efd6bc2f174bab99ac74d95dc43944`.

## Browser method

The signed-in production app was checked in the Codex in-app browser at 1280×900
and 390×844. Checks were read-only: navigation, reloads, DOM readiness, Retry on
a failed list read, and visual inspection. No customer/financial actions or scan
starts were used. Screenshots containing production addresses are not committed.

Timings use the automation host's clock around navigation and visible DOM
readiness. Performance/Navigation Timing APIs are unavailable in this browser
interface. These are **observed readiness timings including tool overhead**, not
LCP, INP, FCP, or a field-device benchmark. Cached data can render before a
background refresh completes. No cache clearing or network/CPU throttling was
available. Initial route visits may also benefit from prefetching.

Click-driven samples clustered around 3.2 seconds regardless of route and are
excluded from app latency conclusions because of action-tool overhead. Direct
same-document hash navigation provided the measurements below. Early route checks
timed out before the active route changed; subsequent navigation worked. A native
location prompt was suspected but not directly verified.

## Warm route readiness

Three direct visits per route; milliseconds, median (range).

| Route / ready criterion | Desktop | Mobile |
| --- | ---: | ---: |
| Dashboard / KPI tiles visible | 129 (126–135) | 129 (123–151) |
| Leads / rows visible | 124 (124–125) | 133 (125–142) |
| Map / controls visible | 169 (123–182) | 119 (118–127) |
| Schedule / summary visible | First observed visit: 245 | 122 (122–123) |

Mobile checks found no document-level horizontal overflow, active-page alerts,
or remaining skeletons on these warm visits. Schedule rows and navigation fit
the mobile viewport. The map eventually showed satellite imagery and pins with
no boot, pin-read, retry, or stale-viewport indicators; tile/pin completion was
visually verified separately and **not** timed as controls readiness.

## Full reloads with warm browser cache

| Route | Observations in milliseconds |
| --- | --- |
| Dashboard / loaded KPI tiles | 2,236; 389; 351 |
| Leads / rows | 20,212 deadline missed; 331; 4,681 |
| Leads / focused repeat | 336; 290; 15,164 deadline missed |
| Map / controls | 557; 477; 433 |

The first map reload immediately after deployment took 2,808 ms to controls.
The focused slow Leads repeat had 72 skeleton elements and zero rows at 15.2s;
it subsequently displayed “Lead data could not be loaded”. Retry eventually
restored 100 rows. Recovery's exact completion time was not captured. The error
was distinguishable from an empty list. These slow samples must not be hidden
behind the fast warm medians. A separate public HTTP health sample also timed
out at its 15-second deadline during this period.

## Server evidence and resulting follow-up

The existing read-only [production perf report](https://github.com/MuizzM/homefront-fiber-leads/actions/runs/33982893049)
covered **17:53:28–18:04:19 UTC**, including these test visits. Among 18 completed
Leads requests, p50 was 10.96 ms and p95 was 19,692.95 ms. HTTP-serving process
event-loop stalls reached 46,942.7 ms. These are short-window server measurements,
not representative fleet percentiles or browser paint times.

Synchronous writes to invitation tokens, scanner claim preparation, governor
state, bandwidth accounting and metrics coincided with the stalls. Capacity
showed approximately 5.7 GiB available memory, 20% root disk use, and no active
memory/I/O pressure. The application's configured SQLite busy timeout was
120,000 ms; throwaway connection pragma defaults in the report are not its tuning.

Two behavior-preserving corrections were identified:

1. Leads also requests the onboarding pipeline. It rewrote identical deterministic
   invitation tokens on every read, acquiring the writer lock unnecessarily and
   blocking other requests on the same HTTP worker. Equal private hash/expiry
   values now return without an UPDATE; actual renewal, legacy repair, and signing
   secret changes retain persistence.
2. Stale statistics after a large scanner queue drains can select a full historical
   ledger scan for three skip UPDATEs inside an immediate transaction. A synthetic
   500,003-row fixture measured 17–18 ms unpinned versus 0.014–0.032 ms using the
   existing run/state index. The statements now explicitly use that index. No
   predicate, ordering, transaction, budget, or provider behavior changes. The
   **production query plan was not collected**, so live improvement still requires
   measurement after this follow-up release.

Both regressions fail against the prior implementation. The follow-up full local
gate passed **631 files / 7,843 tests**, both TypeScript compilers, the build,
harness and deployment guards. Local Docker Compose config validation is
unavailable; CI retains that check. Independent code/security review found no
blockers. Follow-up deployment and live remeasurement are recorded in
`.agent/plans/production-stall-fix.md`.

## Follow-up deployed and checked

[PR #214](https://github.com/MuizzM/homefront-fiber-leads/pull/214) merged the
corrections. [Exact-SHA CI](https://github.com/MuizzM/homefront-fiber-leads/actions/runs/33983496070)
passed 631 files / 7,843 tests and the full gate for
`8e828435a958dbf4b149d2f48af1c8243b8f1bf5`.
[Deployment run 33984552292](https://github.com/MuizzM/homefront-fiber-leads/actions/runs/33984552292)
reported that exact commit healthy at **18:38:26 UTC**, retaining 266c7bb as the
rollback image. Client assets remain identical because these corrections affect
only the server.

A second baseline [server report](https://github.com/MuizzM/homefront-fiber-leads/actions/runs/33983833159),
18:12:14–18:22:14 UTC, confirmed the original stalls persisted beyond startup:
HTTP-serving loops reached 51,137 ms and 125 slow scanner claim transactions had
p95 3,947.5 ms. This window had no Leads requests and cannot supply a second
Leads latency percentile.

Initial post-follow-up desktop reloads used the same warm-cache method:

| Ready criterion | Samples (ms) | Median (ms) |
| --- | --- | ---: |
| Leads rows | 454, 411, 453 | 453 |
| Dashboard KPI tiles | 413, 297, 391 | 391 |
| Map controls | 323, 545, 446 | 446 |

All nine criteria completed; Leads showed 100 rows without an error. One
dashboard sample still had nine skeletons outside the loaded KPI tiles, so this
is not a claim that every secondary panel had loaded. Mobile navigation checks
for Dashboard, Leads, Schedule and Map completed in 267, 468, 237 and 124 ms,
respectively, with no document overflow, active-page alerts, remaining skeletons
or map error indicators. Five separate public HTTP health probes returned 200 /
healthy / DB up in 114–245 ms (median 132 ms); these are not browser timings.

A later three-reload Leads check completed in **723, 501 and 472 ms**, all with
100 rows, no skeletons and no read error. Combined, the six Leads reloads were
**411–723 ms** (median 463 ms), with no recurrence of the earlier deadline misses.

The [post-follow-up server report](https://github.com/MuizzM/homefront-fiber-leads/actions/runs/33984789707)
covered **18:38:15–18:40:34 UTC**. Ten per-process/minute event-loop observations
had a worst maximum of **175.4 ms**, versus up to **51,137 ms** in the later
baseline. The recurring slow scanner-claim, governor and bandwidth statements
were absent from the slow-statement output. Four recorded Leads requests had
p50 20.81 ms and maximum/p95 30.72 ms, with no errors; the small count does not
establish a fleet latency guarantee. This collection ended before the later
three-reload check. A startup backfill still logged one 1.63-second statement;
the runtime loop samples do not include every startup operation.

The follow-up window is shorter than the baseline and includes test traffic.
It supports that the reproduced long runtime stalls did not recur during these
checks, not a claim that all workloads or cold field devices have been measured.
The browser viewport was restored and the authenticated session retained.

## Limits and separate operations follow-up

This pass does not establish that every integration or all real devices are fast.
Governor/accounting stalls did not recur in the short follow-up window; sustained
field monitoring remains useful for longer-running workloads.
The normal code-only deploy used `with_backup=false`; no schema changed. Release
review found a pre-existing failure-trap ordering defect in the optional offline
backup path of `scripts/deploy.sh`, which was not exercised and needs a separate
operations fix. The normal deployment health/rollback path succeeded.
