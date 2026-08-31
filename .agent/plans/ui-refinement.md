# UI refinement, design-system completion, distribution readiness

Branch: `claude/ui-refinement` (cut from `claude/production-overhaul` @ 071a3cb).
Directive: complete the UI/UX follow-up, finish the design system, prepare
controlled distribution. NO broad backend rewrite; backend changes only for
verified UI-revealed correctness/contract/perf/reliability issues.

## Outcome

1. A structured UI audit of every user-facing route + shared interaction, each
   finding classified (critical usability / high-friction workflow /
   design-system inconsistency / accessibility / mobile-only / perceived-perf /
   cosmetic / intentional-but-unexplained) and prioritized.
2. Design system completed: token consolidation (color, type, spacing, radius,
   z-index, motion, touch targets), shared component state coverage, no new
   one-off values outside the system. docs/DESIGN_SYSTEM.md stays the source.
3. Assignment UI final pass: authoritative preview, structured result summary,
   persistent undo affordance, partial-outcome explanation, reassign vs assign
   distinction, mobile sheet parity - without touching the verified concurrency
   model.
4. Navigation/perceived-perf polish: no blank-page flashes, deterministic
   skeletons, context preservation, instant click acknowledgment.
5. Accessibility baseline: keyboard completion of core flows, focus states,
   icon-button names, dialog focus traps, announcements, reduced motion, zoom.
6. Distribution package: user-facing changelog, rollout classification,
   in-product guidance where behavior changed, observability verification,
   support/rollback materials.
7. Final report with the 10 required sections, evidence-backed claims only.

## Constraints (binding)

- Preserve: concurrency, authz, tenant isolation, idempotency,
  assignment-integrity, performance protections from the overhaul branch.
- Copy rules: hyphens only, no emojis, icons only in nav, light default.
- Design authority: docs/DESIGN_SYSTEM.md (blue=structure, gold=emphasis,
  semantic tokens, 11px/44px floors, `:root.dark` specificity, overlay token).
- Enforced by tests already: light-theme-token-coverage, type-and-tap-floors,
  page-header-consistency. Do not weaken gates.
- Shared worktree: stage explicit paths only.
- No merge/deploy/publish without explicit user authorization.

## Milestones

A. **Audit** (workflow fan-out, 12 mappers by surface cluster + cross-cuts,
   grounded in DESIGN_SYSTEM.md + directive schema) -> prioritized inventory.
   Browser verification of top findings on the dev fixture.
B. **Design-system completion**: token gaps (z-index scale, motion/reduced
   motion, focus ring, component heights, breakpoints doc), shared component
   state coverage (buttons/inputs/dialogs/toasts/empty/error/skeleton),
   PageHeader adoption where cheap, remaining raw-color call sites on light
   surfaces.
C. **Assignment UI final pass**: result summary panel, undo affordance
   persistence, partial-outcome breakdown, reassign distinction, scope-vs-
   viewport clarity, mobile sheet ergonomics, disabled-reason affordances.
D. **Screens + nav + mobile + a11y + perceived perf** fixes from audit,
   priority order, in slices with focused verification per slice.
E. **Distribution**: changelog (user + admin), rollout classification,
   in-product announcement (non-blocking), observability audit/wiring,
   support materials, rollback comms plan. Docs under docs/release/.
F. **Final**: quality-verification matrix (widths, keyboard, zoom, reduced
   motion, throttled network), agent-verify full, browser evidence, report.

## Progress

- 2026-08-30: Branch cut, plan written. Starting A (audit workflow).
- 2026-08-30: A DONE. 12-agent workflow audit, 143 findings (25 P1 / 84 P2 /
  34 P3), plus an observability/release-seam map (structuredLog, perf-report,
  announcement channel, flag pattern, undo-toast gap).
- 2026-08-31: B-F implemented in nine commits:
  1. d038378 foundation: useModalA11y across ~14 hand-rolled overlays,
     z-scale tokens, Button loading, Checkbox tap-expand + extended floors
     test, AlertDialog mobile parity, toaster tokens, sheet hideClose,
     shared theme store, nav naming/titles, login zoom.
  2. eec88e8 assignment flagship: AssignResultBar (persistent outcome +
     10-min undo), changed-hands pre-confirm line, save-area cap chips,
     honest disabled reasons, projection rewrite, hash-preserving URLs,
     filtered-badge honesty, notice priority, search Enter.
  3. a026e37 trust sweep: 17 false-empty/silent-failure surfaces.
  4. 6904f3c operator consoles: stopped/reconnecting/indeterminate honesty,
     scan reattach, calling confirms + field-level reasons, W-9 summary.
  5. 4231d23 perceived perf + token sweep: keepPreviousData on period
     switches, poll gates, remaining raw-palette sites, tap floors,
     pagination jump, truncation notes.
  6. b2bafb6 keyboard contracts: useRovingTabs on 5 surfaces, commission
     table semantics, error-center consumer, verification var() fix.
  7. 910003f distribution: client-error beacon (+ integration tests),
     diagnostics assignment-card honesty (+ tests), docs/release package,
     DESIGN_SYSTEM/BULK_ASSIGNMENT updates.
  8. a496c24 armed-confirm test pin (both tones).
- 2026-08-31: Browser verification on the .dev-verify fixture (mona.manager):
  lasso 45 doors -> chips + "33 change hands" -> pick Dana ("gains 34, 11
  already theirs, undo 10 min") -> Assign 45 -> result bar ("45 assigned ·
  22 changed hands · undo for 10 min") -> Undo -> "45 put back" receipt ->
  8s auto-dismiss -> server byOwner byte-exact restore {0:12,5:501,6:501,
  7:502}. Theme store sync (Profile toggle updates Layout label), mobile
  drawer (focus in, labeled backdrop, Escape closes), Today/tab-bar naming,
  zero console errors. Environmental note: the sandboxed pane needed a
  viewport emulation + a one-time inline setStyle kick before the google
  raster style would load - not a product defect (probe map loaded fine).

## Dispositions of deferred audit findings

- Bulk Status undo (#33, P2/L): needs a server undo seam for status writes -
  product decision; recorded in docs/release open items.
- KeepAliveStages re-show refetch ride-along (#126, P3/M): documented
  deliberate freshness trade in-code; left standing.
- Single-lead AssignRepModal combobox upgrade (#37 residue): current-owner
  marker + loading state shipped; the searchable picker at 40+ reps is
  recorded UI debt.
- PageHeader adoption (9/37 pages): treatment is test-enforced; the markup
  duplication remains open (pre-existing, unchanged risk).

## Decisions

- Audit is code-first (workflow mappers), then browser-verified for the
  findings that drive changes; contrast/floors claims must be measured, not
  reasoned (per DESIGN_SYSTEM.md).
- Dark mode IS officially supported (first-class per DESIGN_SYSTEM.md), so
  both themes are in scope for verification.
- No new telemetry infrastructure invention: verify/extend the existing
  structuredLog + slow-statement seams; client observability only through
  existing patterns.
