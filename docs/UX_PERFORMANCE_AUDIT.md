# Performance and recovery audit — 2026-09-05

Base: `a01db653a6849d76e7ce9e97da4ca8a9ddc29f1a`.
Branch: `codex/ux-performance-audit`.

This pass follows `docs/CLEANUP_PERFORMANCE.md`. It reduces verified work in
startup, route changes, photos, schedules, map reads, ranking, leaderboards and
imports, and fixes misleading error states in lead and commission workflows.
It adds no dependencies, migrations, provider calls, secrets or integration removals.

## Main modules and usage

| Module | Active callers and contract | Audit result |
| --- | --- | --- |
| `App.tsx`, `auth.tsx`, `queryClient.ts` | All authenticated pages, OTP login, persisted/offline data | Remove anonymous status round trip; bounded recovery; invalidate old-scope reads, retries and mutation callbacks |
| `KeepAliveStages.tsx`, `routePrefetch.ts` | Main navigation and retained screens | Refresh returning/shell observers only; honor Data Saver/offline/2G before speculative code downloads |
| `AuthedImg.tsx`, `PhotoLightbox.tsx` | Property details and map lead-photo strip | Fetch near-visible thumbnails; eager selected photo; release object URLs |
| `FollowUps.tsx` | Appointments, callbacks, shared outcome sheet | Linear day grouping, 50 rows per section/page, full totals and access to every appointment |
| `routes.ts`, `storage.ts`, `leadRanking.ts` | Today/Dashboard/Leaderboard and map viewport requests | Bounded SQL work, stable preset caching, count-first dense windows, correct lens validators, symmetric neighbor counting |
| `leadImportRoutes.ts` | CSV/XLSX preview and import | One authoritative roster/scope calculation; retain only the first 5,000 normalized rows while counting all rows |
| Team, CommissionConsole, OverrideConfigCard, MyCommission, EarningsToday | Plans, closeout, payouts, adjustments, reserve/override earnings | Explicit failed/offline states, guarded saves, preserved and identity-bound drafts |
| Leads, MapView | Lead editing, history and selection of existing doors | Failed edit recovery; history retry; visible loading/error/cancel for uncached selected doors |

Auth/mail, CRM, payments/commissions, maps/geocoding and scanner integrations
remain active. Their public routes, environment names and business rules are
preserved. This audit did not establish an unused integration to remove.
Earlier dead-export and environment cleanup remains documented in the prior report.

## Measured improvements

Measurements below use synthetic local data and compare the base implementation
with the changed implementation. They are not production latency, browser LCP,
or a guarantee for every device or workload. Stable work counts are stronger
signals than individual timing samples.

| Workload | Before | After |
| --- | ---: | ---: |
| Anonymous sign-in bootstrap | Waits for 1 status request | 0 status requests |
| Return to A with stale hidden B | A and B both refetch | A refetches; B waits for its own return |
| Offscreen 24-photo strip | 24 authenticated file requests on mount | 0 before visibility; only revealed photos fetch |
| 2,000 callbacks in one section | 26,044 DOM elements | Fewer than 700 DOM elements; 50 appointment rows |
| Today leaderboard, 500,012 knocks | 131.3 ms | 0.39 ms |
| Seven-day leaderboard, same fixture | 130.2 ms | 3.00 ms |
| Tenant all-time leaderboard | 137.0 ms | 38.4 ms |
| Dense map window, 73,530 eligible pins | 188.7 ms | 8.17 ms |
| Team-lead import roster, 1,000 members | 958 roster + 96 member reads | 1 roster + 0 member reads |
| Dense ranking, 3,000 points | 202.0 ms | 127.5 ms |
| 8 MiB CSV with 270,599 short rows | 255.6 MiB process peak RSS | 229.3 MiB process peak RSS |

Leaderboard/map timings use warmups and median samples against in-memory SQLite.
Ranking alternates baseline/current order; all 34 exact-neighbor fixtures agree.
The schedule used React Profiler/jsdom: the individual 2,000-row mount sample
was 468 → 46 ms, but this is not a measured browser interaction time.
The import roster timing was 871.8 → 1.29 ms in a narrower synthetic roster;
query counts are the meaningful result. CSV RSS includes process/compiler and
fixture overhead, not just parser allocations.

Small cases can pay a little overhead: the 492-pin map measured 2.74 → 2.79 ms;
spread-out ranking measured 2.81 → 3.67 ms. Ordinary 5,000-row CSV imports and
wide-field files did not improve meaningfully. CSV parsing still builds its
original grid; the change eliminates additional copies of rows never retained.

### Download size

The production build's initial static JavaScript closure changed from 133,034 to
135,256 gzip bytes (+2,222 bytes, 1.7%). This pass does not claim a smaller initial
bundle: it removes startup waiting and wasted work and adds recovery safeguards.
Heavy routes remain lazy. The measurement follows emitted static imports only,
excludes dynamic imports, and sums gzip bytes per emitted file.

## Recovery behavior

- Status checks have an eight-second deadline. Network/5xx/malformed responses
  preserve an existing session and its offline snapshot. A successful complete
  status response can still revoke access. With no usable snapshot, the user
  gets Retry and Sign in again instead of an endless startup screen.
- Sign-in requests have a twenty-second deadline. Offline/5xx/rate-limit errors
  retain typed codes; explicit invalid-code responses clear them. Cooldowns use
  elapsed wall time, and requesting a code prevents duplicate submits or editing
  the email underneath the request. Copy does not falsely promise delivery.
- Shared GETs and their body readers have a thirty-second deadline. Query aborts
  reach the transport. Independent Response clones retain the public API.
  Normal writes keep their existing retry policy and uncertain outcomes are
  not presented as guaranteed failures to save.
- Session/scope changes discard stale query results, private stage state and
  old mutation callbacks. An already-started server write is not reversed.
  Internal assignment retry delays stop when their originating scope ends.
- A failed plan/config/payout read cannot be submitted as a default value.
  Plan edits survive refetches; untouched cached fields can update from fresh
  data. Adjustment drafts reset between reps, statements and weeks.
- Partial closeout identifies blocked/failed reps and keeps a retry path.
  Earnings, reserve, overrides and history failures are no longer silently zero,
  empty, disabled or absent. Cold offline loading is distinguished from $0 or
  no scheduled appointments on the changed surfaces.
- Failed optimistic lead edits restore their draft without replacing a newer
  edit session. An uncached selected map door has loading, retry and cancel.
- Schedule paging focuses and reveals the first appointment on the new page,
  instead of leaving the user at the bottom of the next fifty rows.
- Failed downline override configuration reads block both pointer and Enter-key
  submissions. Retry preserves edited rates while refreshing untouched values.

## Preserved invariants

Ranged leaderboard queries retain Today totals and inspect later corrections
outside the selected range. Tenant ownership remains tied to the existing member
join. Rolling presets reuse a result for at most the existing ten-second TTL;
custom cutoffs stay exact, write epochs invalidate, and org midnight changes keys.

Dense `nosample=1` map requests count with the same scope/tag/lens predicates
before hydration. The capped hydration/recount fallback remains for concurrent
inserts. Legacy sampled maps retain their order and deterministic sampling.
All/latest/Kinetic 2026 conditional responses now use distinct validators.

Import permissions are resolved once per request from the same authoritative
roster. Missing linkage fails closed; inactive, outside-team and other-tenant
members remain excluded. No cross-request permission cache was introduced.
Ranking preserves exact displayed neighbor counts, including beyond score saturation.

## Verification

Targeted tests cover the changed network/auth, clone/cancellation, retry-scope,
photo visibility/lifecycle, navigation ownership, large-list paging, financial
errors/drafts, lead edits and backend read contracts. The backend additions use
fresh temporary SQLite databases and loopback HTTP, not production data.

Independent read-only code, security, backend/test and product reviews were
performed. Their findings were reproduced and addressed, including the late
internal retry after a session switch and cold-offline monetary placeholders.

Run the complete repository gate:

```sh
DATA_DIR=$(mktemp -d /tmp/homefront-ux-verify.XXXXXX) \
VITEST_MAX_THREADS=4 VITEST_MAX_FORKS=4 \
bash scripts/agent-verify.sh full
```

The first complete test run passed 7,819 tests and failed the push-registration
wire test because its partial Response stub lacked the newly exercised body
methods. The fixture now uses a real Response; its existing session/CSRF and
registration assertions are unchanged and pass.

Final gate result: **630 test files and 7,837 tests passed**, including the final
browser-discovered corrections. Harness validation, deployment controls, both
TypeScript checks (`tsc`, `tsgo`) and the production build passed. The build
contains no source maps. `git diff --check` passed. Docker Compose is unavailable locally;
its configuration-validation subcheck is skipped by the existing guard. The
remaining deployment controls run normally.

The Mac was initially locked; browser access subsequently became available.
The built app was inspected through the in-app browser with a loopback-only
synthetic API at 390 × 844 and 1280 × 900. No production credentials or data
were used. The fixture blocks external connections and device permissions.

Browser checks covered retained email/code after sign-in failures, session
status retry into the schedule, 123-appointment paging through the final row,
focus/scroll after paging, plan read failures, partial closeout messages and
payout/config recovery. The inspected schedule and financial pages had no
document-level horizontal overflow. Financial controls remained disabled when
their required reads failed. The final override guard was confirmed again in
the rebuilt browser app and is covered by RTL.

Browser testing found the pager's missing focus/scroll restoration and an
unguarded override settings card; both were corrected. A fixture-only location
permission prompt initially blocked schedule interactions; explicitly disabling
geolocation in the fixture resolved it. Actual GPS/device permission flows,
live provider integrations and production/device performance are not claimed.
No production OTPs, customer messages, payouts, scans or deployments were run
for this audit.

## Remaining measured limits and follow-ups

- Binary downloads on very slow connections can reach the new GET deadline;
  they show a recoverable failure. Consider progress-aware transfer deadlines
  if field measurements demonstrate legitimate long downloads.
- Large source-file encryption/JSON and CSV/XLSX parsing still include synchronous
  work. The import normalization improvement is not streaming parsing.
- Super-admin tenant/billing aggregation and the full-map cache's byte footprint
  remain areas for workload-driven measurement; this pass does not claim those
  paths are fully optimized.
- Actual field-device coverage remains separate from the local browser fixture.
  Production p50/p95, event-loop delay and memory should be compared using existing telemetry after
  an authorized release; local fixtures cannot establish those numbers.
- No new `TODO: verify usage` markers or speculative integration deletions were
  introduced. Prior retained-usage items remain in `docs/CLEANUP_PERFORMANCE.md`.
