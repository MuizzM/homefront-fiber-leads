# Homefront Fiber Leads agent guide

## Mission

Maintain the Home Front Solutions field-sales platform without weakening tenant isolation, customer privacy, provider safeguards, financial controls, or deployment safety.

## Repository map

- `client/src/`: React field and management interfaces.
- `server/`: Express APIs, scanner orchestration, calling, commissions, onboarding, and persistence.
- `shared/`: types and logic shared by browser and server.
- `tests/`: Vitest unit, integration, and RTL coverage; Playwright lives in `tests/e2e/`.
- `migrations/`: forward-only SQLite migrations.
- `scripts/` and `deploy/`: operational and deployment tooling.
- `docs/`: architecture, compliance, scanner, and operations references.

Read the closest relevant documentation before editing a subsystem. Prefer `rg` and targeted reads over broad file dumps.

## Standard workflow

1. Inspect the current branch, working tree, applicable instructions, and relevant tests.
2. Reproduce or trace the behavior before proposing a fix.
3. For cross-cutting, security-sensitive, migration, scanner, or deployment work, create and maintain an ExecPlan using `.agent/PLANS.md`.
4. Make the smallest coherent change. Keep unrelated files untouched.
5. Add regression coverage that fails without the fix.
6. Run `$homefront-verify-change` at the appropriate level.
7. Review the final diff for secrets, generated data, tenant leaks, unbounded work, and accidental production effects.
8. Summarize behavior, files, validation, risks, and any manual follow-up.

## Commands

- Install: `npm ci`
- Development: `npm run dev`
- Type checks: `npm run check` and `npm run check:fast`
- Full tests: `npm test`
- Targeted tests: `npx vitest run <test paths>`
- Production build: `npm run build`
- Deployment guard: `bash tests/deployment-safety.sh`
- Harness validation: `npm run harness:check`

Never weaken, skip, or delete a quality gate merely to make CI green.

## Non-negotiable invariants

- Scope ordinary users, reads, writes, streams, caches, and background jobs to the authenticated tenant. Cross-tenant access requires the immutable super-admin marker and explicit tests.
- Enforce authorization on the server. UI hiding is not authorization.
- Treat applicant identity files, customer addresses, phone numbers, location history, commissions, and credentials as sensitive data. Do not log or expose them unnecessarily.
- Keep scanner concurrency, budgets, retries, queues, and provider calls bounded. Fail closed on ambiguous authorization, bot challenges, CAPTCHA, or provider-policy responses. Do not build evasion or bypass behavior.
- Preserve calling-hour, consent, DNC, attribution, and audit requirements documented in `docs/`.
- Make migrations forward-only, restart-safe, and covered by migration/restore tests. Never delete or rewrite production data without explicit user approval and a verified backup path.
- Do not deploy, rotate secrets, alter production infrastructure, or run paid scans unless the user explicitly asks for that action.
- Never commit secrets, real customer exports, production databases, signed URLs, or local data directories.

## Skills

- Use `$homefront-verify-change` after code or harness changes.
- Use `$impeccable` for explicit frontend design, critique, audit, polish, responsive, or UI hardening work.
- Use `$homefront-review-pr` for cross-cutting PR review.
- Use `$homefront-scanner-safety` for Kinetic/Decodo, market discovery, fresh-fiber, new-build, or scan-budget work.
- Use `$homefront-database-change` for schema, migration, backup, restore, or tenant-scoped persistence work.

## Delegation

For independent read-heavy work, delegate in parallel and wait for all results. Use `code_mapper` to trace execution, `security_reviewer` for trust boundaries, `test_reviewer` for coverage, and `product_guard` for field-sales behavior and compliance. Keep one writer responsible for implementation and integration to avoid conflicting edits.

## Code review rules

Report concrete correctness, security, privacy, data-loss, financial, provider-policy, and missing-test risks. Ignore style-only preferences unless they conceal a defect.

- Flag any tenant-scoped query, event, cache, file, or background task that lacks an enforced tenant boundary.
- Flag scanner paths that make retries, concurrency, spend, geographic scope, or provider interaction unbounded or that treat a challenge as permission to continue.
- Flag commission, assignment, lead-status, calling, or onboarding changes that can silently change business outcomes without tests.
- Flag destructive migrations, deployments without exact-SHA/backup protections, and secrets or personal data in code or logs.
- Require regression tests for behavior changes and explicit validation evidence in the PR description.
