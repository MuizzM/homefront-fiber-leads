# Field Map, Pay, and Metrics Integrity

## Outcome

The production field map keeps lead details and every outcome control readable and reachable on phone, tablet, and desktop. A saved rep outcome remains the single durable trigger for commission and metrics changes. Pay stays authoritative, Metrics never presents legacy or failed data as accurate money/zero activity, and automated coverage proves the map-to-pay-to-metrics behavior without altering a real production lead.

## Context

The portal is a React/TanStack Query client with an Express/Postgres backend. The relevant client surfaces are `client/src/pages/MapView.tsx`, `client/src/components/LeadKnockSheet.tsx`, `client/src/components/lead-sheet/OutcomeButton.tsx`, `client/src/pages/Layout.tsx`, `client/src/pages/MyCommission.tsx`, and `client/src/components/metrics/`. Durable outcome reconciliation lives in `client/src/features/knocking/savedKnockReconciliation.ts`. Authoritative commission statements are produced by `server/commissionService.ts`; operational metrics roll up asynchronously through `server/repMetricsAggregator.ts`, `server/repMetricsRoutes.ts`, and `server/repMetricsStore.ts`.

Live browser review found the tablet lead sheet hidden beneath the 264 px persistent sidebar, dark outcome labels with insufficient contrast, and a closed phone drawer that remained available to assistive technology. Code/test review found that metrics and payout-account request failures can masquerade as valid empty state, the map E2E helper uses a retired auth transport, Metrics displays money from a legacy table rather than authoritative commission statements, and team/hourly metric aggregation has correctness defects.

## Safety invariants

- Do not mark or otherwise modify a real production lead merely to test the flow.
- Do not bypass provider controls, run paid scans, rotate proxies, or change scanner/provider behavior.
- Preserve organization and representative tenant isolation on all reads and writes.
- Preserve integer-cent, server-authoritative commission calculations and idempotent sale/reversal behavior.
- Preserve the asynchronous metrics rollup; do not add raw aggregation to the request path.
- Never show a transport/server failure as a legitimate zero, empty, ready, or paid state.
- No database migration, secret change, or destructive production operation is part of this plan.
- Push/deploy only after the repository's full verifier passes; deploy the exact reviewed SHA.

## Milestones

1. Fix verified map UI defects and add focused RTL coverage.
   - Files: `client/src/pages/Layout.tsx`, `client/src/components/LeadKnockSheet.tsx`, `client/src/components/lead-sheet/OutcomeButton.tsx`, corresponding `tests/rtl/` files.
   - Verify: `npx vitest run tests/rtl/LayoutNavReachability.test.tsx tests/rtl/LeadKnockSheet.test.tsx`.
2. Make data-state UI truthful.
   - Add shared metrics error/retry handling for My, Team, Territory, and Reports.
   - Make payout-account errors visible and fail closed.
   - Remove or replace Metrics money cards backed by the legacy financial table; Pay remains the only financial source of truth.
   - Verify focused RTL tests for loading, error/retry, genuine zero, and payout readiness.
3. Repair accuracy and refresh paths.
   - Fix team stock aggregation across representatives.
   - Fix hourly aggregation to use organization-local periods and ignore superseded outcomes.
   - Poll metrics at a bounded cadence consistent with the asynchronous rollup.
   - Repair the Playwright auth helper and add isolated integration coverage for sold, reversal, pay, and metrics refresh.
4. Validate, publish, and inspect production.
   - Run `npm run check:fast` and `bash scripts/agent-verify.sh full`.
   - Run the Impeccable detector on changed UI files.
   - Commit intentionally, push `rep-knocking-workflow`, wait for exact-SHA CI, deploy that SHA, and verify desktop/tablet/mobile browser states without mutating real lead data.

## Progress

- [x] 2026-08-19: Audited live map, lead sheet, Leads, My Commission, and Metrics on desktop/tablet/mobile.
- [x] 2026-08-19: Confirmed tablet sidebar overlap, outcome contrast, closed-drawer accessibility, stale/error-state, legacy-money, and aggregation defects.
- [x] 2026-08-20: Completed Milestone 1 map geometry, contrast, icon, DnK, focus, scrolling, and drawer fixes; 77 focused tests pass.
- [x] 2026-08-20: Completed Milestone 2 error/retry, payout fail-closed, metrics polling, and authoritative-pay-source UI; 78 surrounding tests and type check pass.
- [x] 2026-08-20: Completed Milestone 3 team/hourly aggregation, date-only commission, callback-cohort, bounded refresh, stable idempotency, DnK hard-stop, and repaired browser-auth coverage.
- [ ] 2026-08-20: Milestone 4 verification is complete; exact-SHA CI, deployment, and live recheck remain.

## Decisions

- Verify lead marking with an isolated test database or mocked browser flow, not a real Concord production record.
- Treat `My Commission`/weekly statements as the financial source of truth. Metrics will not present legacy commission-table totals as authoritative pay.
- Use bounded background refetching for Metrics rather than immediate post-save refetch, because the metrics rollup is intentionally asynchronous and normally completes after the saved knock.
- Keep the map's existing visual language; make targeted hierarchy, geometry, contrast, and accessibility fixes rather than redesigning the workflow.

## Discoveries

- The sidebar becomes persistent at `md` (768 px), while the lead sheet docks only at `lg` (1024 px), creating a 768–1023 px overlap range.
- The status palette already provides dark-surface colors, but outcome buttons ignored them.
- The current map Playwright helper writes `window.name`; production auth reads `localStorage["hfs.sid"]` and `localStorage["hfs.sid.until"]`.
- Saved knock reconciliation invalidates commission and payout queries but Metrics is asynchronous and had no polling.
- Authoritative pay arithmetic tests pass; the defect is Metrics presenting values from the legacy `commissions` table.
- Appointment completion cannot be expressed truthfully as completed-in-period divided by created-in-period; the UI now presents the two counts independently and treats the percentage as unavailable.
- Date-only commission order dates must compare to the organization metric date, not timestamp boundaries.

## Validation

- Focused RTL tests for sheet geometry, button contrast, drawer inertness, metrics/payout errors, and genuine empty states.
- Server/unit tests for two-representative utilization aggregation, organization-timezone hourly buckets, superseded outcomes, sold/reversal idempotency, and commission statement agreement.
- Playwright/local browser coverage for pin to card and outcome success/failure using isolated data.
- `npm run check:fast`.
- `bash scripts/agent-verify.sh full`.
- Impeccable detector returns no newly introduced high-confidence UI anti-patterns.
- Post-deploy tablet screenshot proves the lead sheet begins to the right of the sidebar; mobile screenshot proves controls remain readable and reachable.

Completed locally on 2026-08-20: `npm run check:fast` passed; the Impeccable detector returned `[]`; `bash scripts/agent-verify.sh full` passed 533 files / 6,851 tests and the production build; `git diff --check` passed. No real production lead was changed.

## Recovery

All milestones are ordinary source changes with no migration. If focused tests fail, revert only the current milestone's diff and keep the prior verified milestone. If CI fails, do not deploy; repair and push a new SHA. If deployment health checks fail, use the existing deployment workflow's rollback/redeploy mechanism to return to the last known-good SHA. Because no live test lead is modified, there is no production data repair step.

## Result

Implementation and local verification are complete. Publication and the post-deploy production recheck are pending.
