# Oxlint burn-down, junk removal, and snappiness pass

## Outcome

`npm run lint` reports zero findings for every rule class where a fix is a real
correction (not documentation debt): all anti-slop error rules except the four
explicitly-deferred migrations, and all oxlint built-in warnings. Tracked junk
files, unused dependencies, and dead code are gone. Client bundle gets any
verified low-risk snappiness win (code splitting / heavy-import deferral).
Typecheck, tests, and build stay green.

## Context

- Branch `claude/oxlint-anti-slop` in worktree `.claude/worktrees/oxlint-anti-slop`,
  based on `origin/rep-knocking-workflow` at 00069aa.
- Commit 23d9ca9 (2026-08-27) already vendored anti-slop under
  `tools/oxlint/anti-slop/`, added `.oxlintrc.json`, `npm run lint`
  (rebuilds plugin via `tools/oxlint/build-plugin.mjs` because Node 20 cannot
  strip TS), oxlint+@oxlint/plugins ^1.80.0. It fixed nothing and did not touch CI.
- Current findings: 7,873 total. Fix-now population (~350): no-chained-type-assertions 43,
  no-widen-then-assert 1, no-reflect-get 2, no-object-parameters 3, no-unknown-returns 25,
  no-conditional-empty-object-spread 72, unicorn/no-useless-fallback-in-spread 90,
  eslint/no-unused-vars 46, no-new-array 10, no-unused-expressions 6,
  prefer-string-starts-ends-with 4, no-useless-spread 2, no-useless-escape 2,
  no-misleading-character-class 2, no-dupe-keys 1, oxc/erasing-op 1.
- Deferred migrations (~6,900, stay at error, unfixed): require-safety-comment 5,122,
  no-runtime-typeof 813, no-known-value-widening 685 (triage: fix the deletable-annotation
  subset if mechanical), no-unknown-parameters 349, no-unsafe-dictionary-type 290,
  no-module-mocking 178 (test scaffolding — rewiring mocks is its own project),
  no-shape-in-symbol-names 126 (renames).
- Read-only audit workflow wf_dafd85f5-ad2 is surveying junk files, unused deps,
  dead code, client/server perf; removals get an adversarial verify pass.
- Untracked files in the MAIN tree (rockwell-*.ts, probe-*.ts, script/*.json,
  script/import-rowan.ts) are another live session's same-day work — NOT touched.
  Local-only `verify-*.ts` at root are git-excluded scratch — NOT in this worktree.

## Safety invariants

- One writer (this session); audit agents are read-only.
- No rule suppressed, downgraded, or worked around with casts; a wrong-for-repo
  rule gets edited in its own file in tools/oxlint/anti-slop with a reason.
- No behavior change without a covering test; scanner/, commission, tenant-scope
  logic only touched for provably-equivalent mechanical fixes.
- No deploy, no push to default branch, no production data. PR only.
- Tests run with pristine DATA_DIR (mktemp) per repo memory.

## Milestones

1. Audit workflow completes; apply verified junk-file, dep, dead-code removals. — commit "junk"
2. Fix the fix-now lint population to zero, file-by-file batches; `npm run lint`
   confirms per-rule zero. — commit "lint fixes"
3. Apply verified client-perf wins (code splitting etc.), measure build before/after
   (`npm run build`, compare dist sizes). — commit "perf"
4. Verify: `npm run check`, `npm run check:fast`, `DATA_DIR=$(mktemp -d) npm test`,
   `npm run build`, `bash tests/deployment-safety.sh`, `npm run harness:check`.
5. Update this plan, push branch, open draft PR against rep-knocking-workflow.

## Progress

- 2026-08-27 23:05 worktree created, npm ci done, lint baseline captured (7,873).
- 2026-08-27 23:10 audit workflow launched (wf_dafd85f5-ad2).

## Decisions

- Do NOT mass-add 5,122 SAFETY comments: a generated justification is the exact
  slop the rule exists to prevent. Left at error as visible migration debt.
- Do NOT wire lint into CI while migrations remain — same reasoning as 23d9ca9.
- Test-file module mocks (178) untouched: rewiring the mock strategy is a test
  architecture change, not junk removal.

## Discoveries

- (running)

## Validation

- Exact commands in Milestone 4; record outputs here before PR.

## Recovery

- Each milestone is its own commit on claude/oxlint-anti-slop; revert commit-wise.
- Worktree is isolated; main tree untouched. Re-run `npm run lint` for ground truth.

## Result

- (pending)
