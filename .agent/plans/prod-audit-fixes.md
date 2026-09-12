# Prod audit fixes (2026-08-31 browser sweep)

## Outcome

Every defect from the 2026-08-31 read-only prod portal sweep is fixed in code with regression coverage:

- Dashboard "Assigned" tile shows the assigned count (199-class number), not total leads.
- Billing usage card renders one coherent set of numbers from `/api/billing/access` (no more "13,277 of 1,500" beside a 3% bar and "488,230 left"); Trial chip only when the tenant is actually trialing.
- Reports "Yield by team" agrees with the carrier/product/program cards (same window, same definitions) and attributes rows to reps/teams instead of bucketing everything under "Unassigned" (or the table is explicitly labeled if the difference is intentional).
- Coaching Insights lists at most one card per (rule, rep) — the newest window — and the header claim matches the data; the long-gap rule no longer fires with 0s active field time.
- Clock sessions: runaway sessions auto-close at a hard cap; orphaned sessions can't render as rep "Unknown" in "currently in field"; "in field" definitions agree across Dashboard / Live Ops / Field Hours.
- Login Activity excludes diagnostic probe identities (`*.diag@example.com`, `nobody.diagnostic.probe@`).
- Payroll "Needs review" queue excludes fixture/test reps (guard by convention), TEST rep can't reappear.
- byTerritory stats group case-insensitively with a canonical display form (Concord/CONCORD merge).
- Copy fixes: Today alerts-banner platform-aware + "Home Front"; My Documents admin state; Today seatless notice; Live Field Activity header title; "Coming soon 1,000+" when capped; downline-overrides no-op hint; Leaderboard collapses zero-sale tail.

## Context

Worktree: /Applications/homefront-fiber-full.worktrees/prod-audit-fixes, branch `claude/prod-audit-fixes` off `rep-knocking-workflow` @ 88ffb0d.
Audit evidence: session notes + memory `prod-ui-audit-2026-08-31`. Pinned via prod API: `/api/stats` {assigned:199, total:78754}; `/api/billing/access` {usagePct:3, creditsRemaining:488230, state:"trial"}.
Six Explore agents are mapping exact file:line sites (dashboard/today, billing, reports/areas/leaderboard, coaching insights, clock/live-ops, login/payroll/territory misc).

## Safety invariants

- No prod data mutations from this work; data cleanups (delete TEST rep row, close the orphaned session, merge territory rows) ship as code guards + read-layer normalization, NOT destructive migrations. Any migration must be forward-only and restart-safe.
- Commission MATH is untouched — only display, queue filtering (fixture reps), and labels. If a fix would change payout outcomes, stop and ask.
- Tenant scoping preserved on every touched query.
- No new unbounded work in request paths; auto-close piggybacks an existing timer/job or bounded on-read pass.

## Milestones

1. Mapping complete (6 Explore agents) — file:line for every fix site.
2. P0 client wiring: Dashboard tile, Billing card + Trial chip. Tests pin field mapping.
3. P1 server: login-attempts probe filter; payroll fixture guard; coaching dedup + header + gap guard; clock auto-close cap + Unknown attribution + in-field reconciliation; byTerritory canonicalization; Reports team attribution/window fix.
4. P2 client copy/UX: Today banner + seatless notice; MyDocuments admin state; Live Field Activity title; Coming soon cap label; downline no-op hint; Leaderboard zero-tail collapse; Areas window labels.
5. Verification: `npm run check`, targeted `npx vitest run` per touched area, full `DATA_DIR=$(mktemp -d) npm test`, final diff review.

## Progress

- 2026-08-31: worktree created, npm ci done, mapping agents launched.
- 2026-08-31 (later): all 6 maps returned; all fixes implemented:
  - Dashboard.tsx binds Assigned to stats.assigned (dispositioned still total - prospect).
  - PushSetupCard denied copy branches on isIOS; "HomeFront" matches manifest short_name.
  - Today.tsx: hasSeat gate (teamMemberId) — no-seat notice replaces glance band + clock affordances.
  - Layout.tsx: /metrics/live title clause (inlined; Metrics chunk is lazy).
  - shared/billing.ts creditsCap(); billingStore BillingSummary.creditsAvailable; Billing.tsx + BillingOps.tsx denominate by it.
  - coachingInsights longInactivity guard (activeSeconds<=0, gap>=active).
  - repMetricsRoutes readInsights: ROW_NUMBER newest-window-per-(rep,rule); dismissal filtered outside the partition.
  - repMetricsAggregator: retire superseded windows after upsert, dismissal carried forward.
  - CoachingBoard header derives claimed range from payload.
  - storage.closeRunawayClockSessions(cap) + idx_clock_sessions_open; hourly sweep in index.ts (skip-trace-reaper pattern) clearing live state + notifying + audit-logging; /api/clock/sessions repName null (client renders Rep #id).
  - storage login-attempt reads exclude %.diag@example.com / %.probe@example.com under tenant scope (super-admin unscoped view unchanged).
  - commissionService PLAN_NOT_ACCEPTED requires rep.active.
  - MyDocuments admin/manager branch (Rep Onboarding pointer, no logout CTA).
  - comingSoonWatchlist returns total+truncated; WatchlistResult type; Leads chip "N+", FiberIntelligence Watching=total.
  - OverrideConfigCard zero-amount warning.
  - Leaderboard idle-tail collapse (rank precomputed on full board; self-row never hidden).
  - /api/stats byTerritory + getLeadFacets group case-insensitively; displayCityCasing in shared/addressKey.ts (mixed-case kept, single-case title-cased; states uppercased).
  - Reports: team label "No team lead assigned" + tenant guard on join + provenance caption; Areas knocked/sold title hints.

## Validation (actual)

- `npm run check` (tsc): clean, twice (mid-work and after all edits).
- Targeted: 171 tests across Leaderboard/coaching/billing/BillingOps/rep-metrics/commission/falsehoods/LeadsOptimistic — pass.
- New regression tests: coaching gap guard x2 (unit), board dedup + dismissal (rep-metrics-api), PLAN_NOT_ACCEPTED inactive guard (commission-service), creditsAvailable (billing-store), closeRunawayClockSessions / login-probe filter / facets dedupe (tests/integration/prod-audit-regressions.test.ts) — all pass.
- Full `DATA_DIR=$(mktemp -d) npm test`: run 1 → 7738/7741 (ops-queues midnight-window flake at the 23:59 date rollover + 2 more); run 2 → 7740/7741 (db-backup-verify-stream 5s timeout under double-suite CPU contention; tests wall-clock 698s vs 346s). Both files pass solo (24/24) on a quiet machine — failures environmental, union of runs fully green. Matches the repo's known CI-time-flakes pattern.

## Follow-ups deliberately NOT done (business-rule changes needing a decision)

- Reports 33-vs-15 root causes: vendor-order rep attribution (`useVendor` per-rep gate, repMetricsStore.ts:310) and installed-only-via-confirm-install. Labeled honestly instead.
- Trial state on a paid plan: `state:"trial"` is genuine data (no expiry job, stripe dark); needs a product decision (expiry job or manual `POST /api/billing/state`).
- TEST - HFS Automation rep: prod DATA — offboard/deactivate via Team page; the new active-guard then drops it from Needs review. No deletion from here.
- Out-of-market strays (Harrison AR, Saint Marys PA, MONROE IA): import-side footprint gate, separate slice.
- dbPrune retention for rep_coaching_insights: growth is now bounded by write-time retirement; standalone prune not added.

## Decisions

- Read-layer canonicalization for territories (case-insensitive grouping, canonical display) instead of a data migration — avoids destructive rewrite of ~919k rows; ingest-side normalization added for new writes only.
- Fixture-rep guard keyed on name prefix `TEST - ` (matches "TEST - HFS Automation 2026-08-27"); excluded from payroll queues and needs-review, not deleted.

## Discoveries

(pending mapping results)

## Validation

- Per-fix regression tests (server: vitest; client: RTL where harness exists).
- `npm run check`; `DATA_DIR=$(mktemp -d) npm test` (pristine DATA_DIR per repo memory).

## Recovery

Worktree is isolated; `git -C /Applications/homefront-fiber-full.worktrees/prod-audit-fixes checkout -- .` reverts. Branch can be deleted without touching rep-knocking-workflow. No data operations to roll back.

## Result

(pending)
