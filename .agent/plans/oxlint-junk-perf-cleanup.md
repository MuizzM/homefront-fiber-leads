# Oxlint burn-down, junk removal, and snappiness pass

## Outcome

Delivered on branch `claude/oxlint-anti-slop` (worktree `.claude/worktrees/oxlint-anti-slop`),
five commits on top of `origin/rep-knocking-workflow` @ 00069aa:

1. `dde7a26` lint burn-down - every finding whose fix is a correction
2. `f594883` four per-request costs removed + two live-behaviour fixes
3. `a87943b` production image 220 MB -> 91 MB, four never-real artifacts deleted
4. `ac64784` a test that could not fail replaced with the one it should have been
5. (this commit) lossless image re-encode + plan record

Measured results:

- production `npm ci --omit=dev` node_modules: **220 MB -> 91 MB** (-59%)
- PWA/mail/PDF images: 474 KB -> 438 KB, pixel-identical (asserted, not assumed)
- per request removed: a 188 KB JSON re-read+re-parse, an 8s-timeout Census
  fetch, and an MD5 ETag over every no-store JSON body (worst case: 25,000 map
  pins per pan)
- one silent live-behaviour bug fixed: the scan SSE stream was being buffered by
  our own compression() middleware

## Context

- Commit 23d9ca9 (2026-08-27) vendored anti-slop under `tools/oxlint/anti-slop/`,
  added `.oxlintrc.json` and `npm run lint` (which rebuilds the plugin each run
  because Node 20 cannot strip TS), and deliberately fixed nothing.
- Baseline was 7,873 findings. This branch removed the population where a fix is
  a real correction and left the migrations visible as errors.

## Safety invariants held

- One writer (this session). Sub-agents were read-only auditors and verifiers.
- No rule suppressed, downgraded, or worked around with a cast. Two rules that
  are wrong here were left failing WITH recorded reasons rather than obeyed.
- No behaviour change without covering tests; both perf fixes with observable
  behaviour were confirmed to fail with the fix reverted.
- No deploy, no push to default, no production data touched.

## Lint: before -> after

| rule | before | after | note |
|---|---|---|---|
| require-safety-comment-for-type-assertion | 5,122 | 5,071 | deferred migration |
| no-runtime-typeof | 813 | 814 | deferred migration |
| no-known-value-widening | 685 | 682 | deferred migration |
| no-unknown-parameters | 349 | 350 | deferred migration |
| no-unsafe-dictionary-type | 290 | 289 | deferred migration |
| no-module-mocking | 179 | 179 | test architecture |
| no-shape-in-symbol-names | 126 | 126 | renames |
| no-conditional-empty-object-spread | 72 | 72 | not started |
| no-useless-fallback-in-spread | 90 | 3 | autofix |
| no-unused-vars | 46 | 17 | prod all clear; rest are tests |
| no-chained-type-assertions | 43 | 23 | all 20 production sites fixed |
| no-unknown-returns | 25 | 8 | |
| no-new-array | 10 | 10 | KEPT - see Decisions |
| no-unused-expressions | 6 | 1 | |
| no-useless-spread | 2 | 2 | KEPT - see Decisions |
| no-object-parameters | 3 | 2 | KEPT - see Decisions |
| erasing-op / no-dupe-keys / no-widen-then-assert | 3 | 0 | were real defects |

## Decisions

- **No mass SAFETY comments.** 5,071 generated justifications is exactly the
  low-evidence writing that rule exists to catch. Left as visible error debt.
- **Lint stays out of CI** until the migrations land, same reasoning as 23d9ca9.
- **`new Array(n).fill(x)` kept** against unicorn/no-new-array. Measured: 6.5ms
  vs 107.3ms for the rule's form (2,000 elements x 2,000 iterations). 16x slower
  in geometry hot paths is not an improvement.
- **The `[...survivors]` spread in dedupeLeads kept** against
  unicorn/no-useless-spread: the loop deletes from the map it iterates, so the
  spread is the snapshot that makes it safe. Comment added so it is not "fixed".
- **`logActivity(details?: object)` left alone.** Tried `Record<string, JsonValue>`;
  TypeScript gives implicit index signatures to type aliases and not interfaces,
  so 35 call sites passing serializable named interfaces failed. 35 assertions
  is worse than the loose parameter. Recorded in shared/json.ts.
- **Four "dead" modules NOT deleted** - see Discoveries.
- **29 dead exports NOT deleted** - verified dead, but several are the unmounted
  half of a live feature. Listed below for an owner decision.

## Discoveries

- **"No importer" is not the same as "junk" in this repo.** A dead-code sweep
  flagged four whole modules; reading their headers showed all four are
  deliberately-written and deliberately-unwired, each encoding knowledge the
  code alone does not:
  - `server/streetOpportunity.ts` - nine numbered rules, each recorded because
    the obvious approach was measured and found wrong.
  - `server/leadDedupAudit.ts` - why proximity auto-merge is dangerous, which a
    later incident confirmed when a merge deleted real doors.
  - `shared/commissionMoney.ts` - why commission money is a separate plane from
    order status (chargeback has no order-status equivalent).
  - `shared/territoryFilter.ts` - "who holds an area" consolidated after it cost
    two access leaks; RepPicker.tsx explicitly flags unifying it as a product
    decision, not a tidy-up.
- **The onboarding public projection was lying.** `toPublicRecord` asserted
  `as unknown as OnboardingDocumentRecord` while deliberately withholding
  `companySignerUserId`. Removing the cast made tsc report it immediately.
- **A test that could not fail** (`expect(Math.max(500, 0)).toBe(500)`) sat where
  cold-start coverage was supposed to be; its module-reload trick was broken too.
- **A branch wall proven in one direction only.** rep-metrics-api built managerB
  fixtures for peer-branch isolation and never asserted it. Now asserted, and
  the isolation turned out to be genuinely symmetric.

## Validation

All run from the worktree root:

- `npx tsgo --noEmit` - clean
- `DATA_DIR=$(mktemp -d) npm test` - 603 files, 7,613 tests, all passing
- `npm run build` - green; all 7 emitted bundles' require() specifiers resolve
  against a real `npm ci --omit=dev` tree
- `bash tests/deployment-safety.sh` - passed
- `npm run harness:check` - passed
- Both perf fixes with observable behaviour confirmed to FAIL with the fix
  reverted (SSE no-transform; W-9 explicit ETag)

## Recovery

Each slice is its own commit; revert commit-wise. The worktree is isolated and
the main checkout was never written to. `npm run lint` is ground truth for the
remaining counts.

## Result

Branch is ready for a PR against `rep-knocking-workflow`. Nothing deployed.

### Open items for the owner (not decided here)

1. **`shared/territoryFilter.ts`** - 245 lines, wired to nothing, while
   `Areas.tsx` filters inline with a DIFFERENT rule (substring vs word-start).
   RepPicker.tsx says unifying them is a product decision. Two clean options:
   wire Areas.tsx to the module, or delete module + test and accept the inline
   version. Leaving both is the only bad option.
2. **`server/mpboxScanEngine.ts`** - 305 lines with no production caller, so the
   MP Box panel can only replay old rows; nothing in this tree can start a scan.
   Either wire a producer or retire the feature.
3. **29 verified-dead exports** across 20 files. Safe to delete, but several are
   the unmounted client half of a live server feature - notably
   `applyLiveAnnouncement` / `useAnnouncementToasts` (TeamFeed.tsx), whose SSE
   plumbing and server emitter are both live and only the callback is missing.
   Deleting those abandons the feature; that is a product call.
4. **The lint migrations** (~6,900 findings) - the SAFETY-comment backlog is the
   big one and wants doing file-by-file with real justifications, after which
   lint can enter CI.
