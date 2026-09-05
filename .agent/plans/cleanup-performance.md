# Conservative cleanup and performance refactor

## Outcome

Remove verified unused implementation and configuration, reduce measured loading
and request costs, and leave a reviewable diff without changing public APIs,
documented tools, integrations, or field-sales behavior.

## Context

Fresh clone of `MuizzM/homefront-fiber-leads`, branch
`codex/cleanup-performance`. The existing local checkout contains unrelated work
and is untouched. Entry points are `client/src/main.tsx`, `server/index.ts`,
`script/build.ts`, package scripts, bundled maintenance scripts, and deployment
workflows. `docs/architecture/domain-map.md` describes domain ownership.
Previous cleanup evidence lives in `.agent/plans/oxlint-junk-perf-cleanup.md`.

## Safety invariants

- Preserve tenant scope, authorization, calling policy and financial controls.
- Preserve route registration and documented/operational entry points even if
  static imports do not reach them.
- No outbound communications, scans, secret rotation, database cleanup, or
  schema changes. Following the user's explicit shipping authorization, release
  only through the existing exact-SHA, CI-gated production workflow.
- Keep uncertain usage and annotate concrete remaining candidates.
- One implementation writer; parallel auditors are read-only.

## Milestones

1. Map imports, exports, environments, integrations and external entry points;
   establish build/type-check and relevant test baselines.
2. Remove proven dead implementation in coherent slices.
3. Optimize measured load/request bottlenecks with behavioral regressions tests.
4. Run `bash scripts/agent-verify.sh full`, review the diff and publish findings
   in `docs/CLEANUP_PERFORMANCE.md` with a machine-readable usage inventory.

## Progress

- [x] 2026-09-05: Clone isolated, branch created, repository instructions read.
- [x] 2026-09-05: Dependencies installed; read-only audits dispatched.
- [x] Usage inventory and baseline measurements complete.
- [x] Dead-code removal and performance changes complete.
- [x] Full verification and independent final review complete.
- [x] User authorized shipping the reviewed change ("yes ship it").
- [ ] Merge the reviewed change, pass remote CI for the release SHA, deploy
  through the production workflow, and verify public health/release identity.

## Decisions

- The requested ponytail skill was not found in installed skill directories.
  Apply code-simplification, performance-optimization and required repository
  verification/review skills instead.
- Do not remove deliberately unwired features documented by earlier audits
  solely because they lack production callers.
- Do not add external dependencies.
- Preserve all 699 registered route/middleware declarations and all active
  integrations. Remove only the 20 verified unused exports and four obsolete
  generic contact-provider environment examples.
- Keep six uncertain usage cases with explicit comments and report follow-up.

## Discoveries

- Existing client already has route splitting, idle prefetch, a lazy map library,
  precompressed assets and a service-worker update flow. Preserve those paths.
- Existing lint migration debt is documented by the prior cleanup plan.
- The full suite exposed two time-sensitive sweep fixture failures, reproduced
  unchanged at the base revision. Anchor fixtures to the current clock without
  changing production predicates, retry windows or assertions.
- Existing reversed-payout preview eligibility differs from payment execution;
  characterize and preserve it rather than change financial policy here.

## Validation

Use production bundle sizes for deterministic loading measurements, realistic
fixtures/query counts for backend changes, existing Vitest coverage and focused
new regression tests. Full repository gate includes harness, deployment guard,
both TypeScript checkers, Vitest and production build. Live external workflows
require configured services and are not exercised locally.

Final full gate passed: harness and deployment guard, both TypeScript checkers,
618 Vitest files / 7,744 tests, and production build. The deployment guard skipped
only Docker Compose config validation because Compose is unavailable. Independent
code, security, product and test reviews found no remaining material regressions.

Measured first Scan Tools additional JavaScript decreased 57.3% gzip; initial app
JavaScript is essentially unchanged. Fifty commission plans now require two
queries instead of 51; 1,200 payout preview rows require one status-enrichment
query instead of 2,400. Reusing the hierarchy index reduced isolated traversal
median time from 476.9 ms to 2.07 ms. Hidden map/watchlist schedules are paused.
Full scope, measurement limits and retained usage questions are in the report.

## Recovery

Changes affect only this clone. Revert individual implementation slices or the
branch diff to recover; no live data or infrastructure recovery is needed.

## Result

Implementation and local verification complete on `codex/cleanup-performance`.
Shipping is authorized and in progress; remote CI and deployment evidence will
be recorded with the pull request and workflow run. No dependency changes. The
reproducible usage-audit script is included; its generated inventory stays outside
the repository. Review report: `docs/CLEANUP_PERFORMANCE.md`.
