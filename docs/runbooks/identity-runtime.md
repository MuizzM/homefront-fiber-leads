# Identity runtime foundation

The identity branch uses Node 24.20.0, better-sqlite3 13.0.3 (SQLite 3.53.4), and Node 24 types. `.node-version`, `package.json`, CI and both Docker stages must agree. Use Node 24.20.0 locally before `npm ci`; do not share `node_modules` with a worktree using another runtime.

This precedes protocol implementation. Node 20 is outside its supported lifecycle; Node 24 is LTS ([release](https://nodejs.org/en/blog/release/v24.20.0)). The SQLite driver major changes the native implementation to Node-API and packages platform binaries, removing the install-time compile/download step ([v13 notes](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0), [pinned release](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.3)). A successful dependency install alone does not prove that the native addon loads.

## Validation

Run:

```sh
npm ci
bash scripts/agent-verify.sh full
node script/runtime-smoke.cjs
docker build --target runtime --tag homefront-runtime-smoke .
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,nosuid,noexec,size=64m,mode=1777 \
  --entrypoint node homefront-runtime-smoke script/runtime-smoke.cjs
```

The smoke uses disposable synthetic data, never imports the application, and exercises the native binary, WAL contention, transaction rollback, foreign keys, binary payloads, Drizzle's raw-row mode, JSON, RTree, native backup, readonly `VACUUM INTO`, a fresh process and a worker thread. CI runs it in the actual Linux production image as a required workflow job. Local macOS smoke success is not Linux image evidence.

HTTP-only streaming tests use Vitest's Node environment so native `fetch` and `AbortController` come from the same runtime. Security assertions still inspect bytes on real sockets. The stranded-run regression checks the physical outer scan as well as the old correlated-subquery wording; SQLite 3.53 flattens the old `EXISTS` into a join but still scans terminal runs. The current queued-set query must retain its list-driven rowid seeks.

## Dependency advisories

The lockfile updates `qs` to 6.16.0 and `browserslist` to 4.28.9 within existing parent ranges. These fix current parser/denial-of-service advisories without changing Express, Babel or Autoprefixer majors. The remaining moderate UUID advisory is transitive through Telnyx and peermetrics. Installed source uses only zero-argument v4 calls; the advisory concerns buffered v3/v5/v6. No affected call site was found in those installed bundles. Keep this bounded exception visible; do not apply npm's suggested Telnyx downgrade or assume that overriding a separate UUID package rewrites Telnyx's bundled code. Recheck when the calling SDK changes. [UUID maintainer advisory](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq)

## Deployment and recovery

- Preserve the dependency on reliability PR #232 and its exact-SHA verification.
- Require the full CI workflow, including Linux image smoke, before release.
- Verify an encrypted production backup and a restore using the new runtime against a staging copy. The smoke's tiny fixture does not replace a representative restore.
- Confirm SQLite extension/module requirements and measured query plans on the staging workload before applying the runtime to production.
- Complete the already required seven-day staging soak, then the 48-hour 10% canary before later rollout steps. The staging host must be identified first.
- Preserve the previous verified image. A rollback uses the existing deployment/backup procedure; do not run an older engine against a database changed by a later migration without validating compatibility and the recovery path.

No live infrastructure or database is changed by this branch's local validation. SSO, SCIM, MFA, and enterprise identity administration are separate milestones in `.agent/plans/enterprise-identity.md`.

## Session and live-data foundation

The companion authority changes keep the seven-day sliding and thirty-day absolute session defaults. Authentication resolves session/user/organization with one indexed join. Reads and delayed recovery actions reject absolute expiry even if an idle-expiry column remains in the future. Session renewal stays coalesced, avoids waiting on a contended writer and uses compare-and-set against the captured lifetime. Auth status no longer opportunistically deletes rows.

Authenticated SSE responses re-read current session and account authority before each frame or heartbeat. Deletion, deactivation, account scope changes, organization suspension and expiry stop further payloads. Passive streaming does not extend the session. Timers/listeners release on request or response close. A response including its next frame is limited to 512 KiB of pending output; overload destroys the socket. Inspector, fiber operations and discovery share diagnostic connection caps (defaults: five per user, one hundred per process, thirty-minute hard duration). Existing stream-specific caps remain.

`scope_authority_version` contains one monotonically advanced metadata version. Transactional, restart-safe triggers on team members, territories and tenants advance it inside the existing writer transaction; lead/scanner event writes do not. Territory and tenant-config caches, lead stream visibility, and full-map response/ETag caches compare the version. Cached permissions are not reused or published inside a transaction because rolled-back version values can recur. Missing authority schema is an error, never permission to reuse stale data. This adds a constant-size indexed read, not a roster/territory scan on every frame. The singleton conservatively invalidates all tenants' metadata caches after a permission metadata write.

The SQL map predicate now honors explicit territory assignee lists, including empty lists, just as hydrated lead access does. Legacy missing/invalid/non-array lists retain their prior primary-owner fallback. Inspector snapshots, timelines and live events require tenant-owned scan runs; unscoped events are platform-only. Infrastructure health and shared-queue controls require the immutable platform marker. Tenant admins retain their scoped inspector and ordinary run controls. Inspector snapshots aggregate first-seen times in the same SELECT and probe run ownership by primary key rather than enumerating tenant run history.

The metadata migration adds only a singleton row and triggers; it does not rewrite account, territory or customer data. Existing backups/restore procedures remain required. Restore regression fixtures verify preserved versions and working triggers after backup/reopen; production-size restore and staging load evidence are still pending. This foundation does not implement enterprise SSO, SCIM, MFA enrollment, approval workflows or concurrent-device policy.
