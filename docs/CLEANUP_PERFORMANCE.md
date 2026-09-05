# Cleanup and performance review — 2026-09-05

Base: `88ffb0d49d060b7b54047b8d6c84b8d2aaf71b7b`.
Branch: `codex/cleanup-performance`. The refactor introduces no production data
changes, schema migrations, provider calls, secret rotation or dependency
changes. Shipping was subsequently authorized; release status is recorded in
the pull request and production workflow run.

## Repository and integration map

| Surface | Entry points and ownership |
| --- | --- |
| Browser | `client/index.html` → `client/src/main.tsx` → `App.tsx`; hash routes, persistent query cache, bounded retained route stages, PWA |
| Server/workers | `server/index.ts`, `server/routes.ts`; process/worker roles, migrations, scheduler and domain route registration |
| Leads/territories | `server/storage.ts`, lead/import routes, territory assignments; `Leads`, `MapView`, `Areas` and lead sheets |
| Auth/tenancy | `server/auth*`, storage/session and capability checks; `client/src/lib/auth.tsx`, shared capabilities/permissions |
| Commissions/payments | `commissionService`, commission/override/hourly/reserve stores, `payoutStore`, `payoutRoutes`, billing and Stripe Connect |
| Onboarding | Public applications/invites, `onboarding*`, W-9/PDF generation, signature/document routes, SMTP/Resend |
| Calling/contacts | `server/calling/*`, Telnyx, Tracerfy skip trace/DNC, consent and authorization records |
| Provider orders/CRM workflows | PerfectVision imports, vendor order matching/status, recovery and messaging routes |
| Maps/discovery | Lazy MapLibre, Mapbox/Nominatim geocoding, address sources, Kinetic/Decodo adapters and scanner queues |
| Training/incentives | Academy/training, campaign/earnings/referral/mileage modules and associated routes |
| Operations/CLI | Existing package scripts; `script/build.ts` bundles server and six maintenance/sidecar entry points; `scripts/`, `deploy/`, GitHub workflows and Litestream |
| Marketing | Public join form and onboarding capture. No standalone marketing/SEO application is part of this repository. |

Active Stripe billing/Connect, SMTP/Resend, Gusto verification, Telnyx, Tracerfy,
Mapbox/Nominatim, PerfectVision, Kinetic/Decodo and Litestream integrations remain.
Plaid appears as a future option in prose, not a removable client dependency.
Dynamic env readers, deployment-only envs, external webhooks, public invite links
and operational CLIs were included in the manual review.

## Usage inventory

Run after `npm ci`:

```sh
node script/audit-usage.cjs /tmp/homefront-usage.json
```

The JSON contains each file's imports, exports and reference locations, incoming
imports, literal dynamic imports, env-read locations, computed-import candidates
and registered route declarations. Environment values are excluded. Generated
inventory stays outside the repository and production bundle.

The original audit covered 1,458 source/test/tool modules and 5,421 exports; the
final audit covers 1,461 modules and 5,403 exports. The difference is 20 removed
exports and two new used helpers, plus two regression-test files and the audit
tool. All 294 client TypeScript modules were reachable. All 699 literal
route/middleware declarations retain the same file, method and path.

This is conservative static analysis: namespace imports may consume any export,
lexical identifiers can share names, computed imports/env aliases require manual
review, and external HTTP callers cannot be inferred from frontend imports.
Missing callers are candidates, not automatic permission to delete endpoints.

## Removed code and configuration

| Area | Removed unused internal exports |
| --- | --- |
| Client auth/training/prefetch | `getSessionId`, `readTrainingCorpus`, `__resetTrainingCorpusForTests`, `__resetPrefetchForTests` |
| Client map/discovery | `discoveryStageLabel`, `TERRITORY_TAP_SLOP_PX`, `DISPLAY_STATES` |
| Server academy/schema | `getActivityState`, `resetGuardedActionSchemaCache` |
| Order matching/provider constants | `SUGGEST_CONFIDENCE`, `SOURCE_REPORT_ID` (the actual report URL/provenance remains) |
| Shared display/unused predicates | `describeOverrideBasis`, `EARNING_LABEL`, `hadEffect`, `describeCampaign`, `ACTIVE_CASE_STATUSES`, `needsAttention`, `REASON_TO_TEMPLATE_KIND`, `IN_FLIGHT_STATUSES`, `REJECTION_MESSAGES` |

Removed unused scanner icon metadata/imports and imports made redundant by the
export deletions. No complete production file, registered API, documented CLI or
dependency was proven safe to remove; none was deleted.

Removed obsolete `.env.example` entries `CONTACT_PROVIDER_HOST_ALLOWLIST`,
`CONTACT_PROVIDER_SECRET_ENV_ALLOWLIST`, `CONTACT_PROVIDER_SECRET_BINDINGS_JSON`
and `CONTACT_PROVIDER_TIMEOUT_MS`. Their generic adapter was already replaced by
Tracerfy (`server/calling/routes.ts` documents the replacement). Updated
`CALLING_COMPLIANCE.md` to describe the existing Tracerfy credential and tenant
contract controls. Provider history, audit tables, active credentials and routes
remain. No live API key was deleted or modified.

## Performance evidence

| Change | Before | After | Scope |
| --- | --- | --- | --- |
| First Scan Tools visit, additional JS over the loaded app | 28,611 B gzip | 12,220 B gzip (57.3% less) | Includes static dependency closure; City stays eager, USA/Kinetic load on selection |
| Scan Tools route chunk | 19,622 B gzip | 6,913 B gzip | The launcher remains interactive during deferred loads |
| Initial app JS dependency closure | 133,089 B gzip | 133,034 B gzip | Essentially unchanged; no overall cold-load claim |
| Plan/version lookup, 50 plans | 51 SQL queries | 2 SQL queries | Same full rows and ordering; empty tenants need one query |
| Payout-preview status enrichment, 1,200 rows with statement IDs | 2,400 single-row queries | 1 query | Only requested account/payout statuses, both joins tenant-scoped; empty input needs none |
| Current assignment acceptance | Extra lookup per rep | Reuse already-read assignment | Acceptance stays attached to the selected effective assignment |
| Hierarchy lookup, 20 overviews × 1,000 members | 476.9 ms median | 2.07 ms median | Five alternating local samples after warm-up; roster index built once per overview |
| Hidden Leads watchlist | 30-second polling | Paused while stage hidden | Role gate and cached data retained; existing stage revalidation refreshes on return |
| Hidden map distance refresh | 45-second GPS schedule | Paused while stage hidden | In-flight callbacks ignored after hide; immediate fresh fix on return |

The hierarchy benchmark isolates roster traversal, not total endpoint latency.
Bundle measurements use the same production Vite configuration and gzip method
on both revisions. They measure transfer bytes, not mobile Core Web Vitals.
No production traffic or physical-device GPS profiling was performed.

The existing speculative-download policy now also covers App's idle warming:
offline, Data Saver and 2G do not start unused route downloads; 3G route warming
and the stricter map-library gate retain their existing policy.

No data cache or additional infrastructure was introduced. Financial statements
still recompute/freeze through the existing service, and payment POST execution
retains its fresh reads and reconcile-before-transfer sequence. Scanner tab
boundaries are keyed so selecting a pending chunk immediately cleans up the old
tool's effects, preserving the existing reconnect-on-return behavior.

## Verification

- The first full run passed 617 files and 7,741 tests; two existing sweep tests
  failed because their fixed August 22 fixture aged out of SQLite's real-time
  retry window. The untouched base revision reproduced both exact failures.
- Anchored the sweep fixture clock to `Date.now()`, preserving every assertion,
  retry limit and production predicate. The sweep, commission and hierarchy
  follow-up run passed 112 tests.
- Regression coverage checks independent old/new read-model output, tenant
  isolation, empty/large inputs, query counts, actual payout HTTP response,
  scanner tab cleanup, hidden-work wiring, acceptance and hierarchy hop limits.
- Independent code, security, test and product reviews found no material
  regressions. The test review's hop-limit and acceptance gaps were addressed.
- Final full gate passed: harness checks, deployment guard (with the Compose
  exception below), both TypeScript checkers, all 618 test files / 7,744 tests,
  and the production client/server/maintenance build. Command:

```sh
DATA_DIR=$(mktemp -d) VITEST_MAX_THREADS=4 VITEST_MAX_FORKS=4 \
  bash scripts/agent-verify.sh full
```

Docker Compose is unavailable locally, so its config-validation subcheck is
skipped by the existing deployment guard. Existing lint migration debt is
documented in `.agent/plans/oxlint-junk-perf-cleanup.md`; lint is not part of the
repository's full gate and is not claimed clean. Playwright/live-service checks
were not run; the E2E configuration also expects a separate sibling marketing
app unless given an existing test environment.

## Retained usage questions and follow-up

`// TODO: verify usage` comments identify these retained cases:

- `server/streetOpportunity.ts`: tested scoring rules, no production caller.
- `server/leadDedupAudit.ts`: documented operational audit, no runtime caller.
- `server/mpboxScanEngine.ts`: reads/UI exist; this producer has no caller.
- `shared/commissionMoney.ts`: tested independent money-state contract.
- `shared/territoryFilter.ts`: its word-prefix behavior differs from Areas'
  current substring filtering; adopting it would change behavior.
- `server/secretScrub.ts`: `SCANNER_SUBMIT_SECRET` is still documented, but no
  active verifier was found. Preserve legacy redaction and setup compatibility
  until the external bookmarklet contract is confirmed.

Dormant feature/lifecycle helpers, explicitly compatible exports and licensing
guidance remain, including announcement hooks, optional campaign/install UI,
certification/history helpers, consent locking and source-file retention tools.
Their intended feature/operational obligations warrant a separate decision.

One existing financial display inconsistency was characterized, not changed:
a FINALIZED statement with a reversed payout can appear eligible in preview
totals while displaying a needs-attention label; payment POST skips it. Resolve
that preview policy separately from the behavior-preserving batching change.

Further measured work should investigate super-admin aggregate batching and
large encrypted import-file I/O. Territory/location filtering and commission
recomputation require their own workload profiles and behavior coverage. This
diff does not claim that every remaining bottleneck or type/lint debt is gone.
