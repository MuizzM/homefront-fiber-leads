# Portal-wide UI polish

## Outcome

Every authenticated portal route inherits clearer, safer shared chrome: mobile navigation is grouped and state-aware, the PWA update prompt never blocks primary navigation and can be dismissed, shared empty/page/list primitives handle real content without silent truncation, and high-use field tabs keep long links and filter rails usable on a phone.

The completed release is committed to the default branch, passes CI for the exact immutable SHA, deploys through the approval-gated production workflow, and is verified on `portal.homefrontsolutionsllc.com` without changing scanner, tenant, financial, authentication, or persistence behavior.

## Context

- The React/Tailwind client lives in `client/src/` and routes through `client/src/pages/Layout.tsx`.
- Shared visual grammar lives in `client/src/components/ui/page-scaffold.tsx`, `EmptyState.tsx`, `ErrorState.tsx`, `BottomTabs.tsx`, and `index.css`.
- The live signed-in rep workflow was inspected at desktop size and at 390x844 on Today, Leads, Training, Leaderboard, Mileage, Referrals, and My Documents.
- Existing visual authority is `docs/DESIGN_SYSTEM.md`; this is a refinement, not a redesign.

## Safety invariants

- No server, scanner, provider, tenant, commission, authentication, or persistence behavior changes.
- Navigation visibility continues to use the existing role/capability gates.
- Production deployment is now explicitly authorized by the user, but only through `.github/workflows/deploy.yml` for the exact green commit on the default branch; no manual host mutation or quality-gate bypass is allowed.
- Existing Home Front colors, typography, route behavior, and field terminology remain intact.

## Milestones

1. Fix universal chrome and shared primitives.
   - Files: `Layout.tsx`, `UpdatePrompt.tsx`, `EmptyState.tsx`, `page-scaffold.tsx`.
   - Verify with targeted RTL tests and the existing navigation/token guards.
2. Fix verified mobile defects in high-use field surfaces.
   - Files: `Referrals.tsx`, `Leaderboard.tsx`, and only directly related shared styling/tests.
   - Verify at 390px plus targeted tests.
3. Run the project verification workflow, build, detector, and one final desktop/mobile inspection.
4. Commit the intentional UI/test/plan files, push `rep-knocking-workflow`, wait for exact-SHA CI success, dispatch the production workflow, and verify the live release.

## Progress

- [x] 2026-08-19: Read repository UI guidance and selected the UI Skills/Impeccable/accessibility context.
- [x] 2026-08-19: Inspected the live signed-in rep workflow at desktop and 390x844.
- [x] 2026-08-19: Implemented shared-system fixes across navigation, update handling, empty states, shared page/list primitives, referral links, filters, metrics, and training tabs.
- [x] 2026-08-19: Added focused RTL and static regression coverage for every changed interaction.
- [x] 2026-08-19: Completed full validation and restored the browser after desktop/mobile review.
- [x] 2026-08-19: Applied the second shared polish pass to the commission tab, app-wide recovery state, viewport shell, and decorative navigation icon semantics.
- [ ] Commit and push the complete release to `rep-knocking-workflow`.
- [ ] Wait for CI on the exact SHA, deploy through the production workflow, and verify production.

## Decisions

- Preserve the existing design system instead of introducing a new visual direction.
- Fix shared causes before leaf pages because the request covers every tab.
- Keep the mobile five-destination bottom bar; it is already capability-gated and field-appropriate.
- Group the More sheet by the same information architecture as the desktop sidebar rather than presenting one unstructured tile wall.

## Discoveries

- `UpdatePrompt` claims to support dismissal but renders no dismiss control and overlaps both content and the floating bottom navigation on a 390px viewport.
- `EmptyState` requires an icon but never renders it, despite its documented contract.
- The flat mobile More grid loses group context and active state; this becomes especially costly for manager/admin roles with many routes.
- Long titles and referral URLs expose preventable truncation/wrapping problems on narrow screens.

## Validation

- Targeted RTL: update prompt, empty state, page scaffold, navigation reachability, referral presentation.
- `npm run check:fast`
- `npm test`
- `npm run build`
- `npm run harness:check`
- `bash tests/deployment-safety.sh`
- `node /Users/muizzmuhammad/.codex/skills/impeccable/scripts/detect.mjs --json <changed UI targets>`
- Live desktop/mobile screenshot and keyboard/state review.

## Recovery

- Changes are isolated to client presentation and tests. Revert individual files if a milestone fails.
- No migration or data write needs rollback. If production verification fails, use the repository's exact-SHA rollback path and record the failed release SHA.

## Result

Implementation is complete locally and awaiting the final post-polish verification, exact-SHA commit, CI, deployment, and live verification. No server behavior, scanner policy, tenant scope, financial logic, authentication, or persistence code is in the release.
