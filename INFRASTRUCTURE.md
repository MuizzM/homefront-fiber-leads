# HomeFront Fiber — Infrastructure & Operations

Companion to [DEPLOY_HETZNER.md](DEPLOY_HETZNER.md) (single-box deploy). This file
records the architecture, what is enforced **in code**, and the exact steps for
the pieces that require external hosting/DevOps and therefore cannot be completed
inside the dev environment.

## 1. Architecture (12-factor)

| Concern | Implementation |
|---|---|
| Frontend | React 18 + Vite SPA, served as static `dist/public` |
| Backend | Express + TypeScript (`dist/index.cjs`), stateless except the DB |
| Database | SQLite (better-sqlite3) in WAL mode; one file, `DB_PATH` |
| Auth | OTP email → server session (`x-session-id`); CSRF double-submit (`x-csrf-token == x-session-id`) |
| Authorization | Capability model (`shared/capabilities.ts`) enforced by `requireCapability` server-side |
| File storage | Local (rep application uploads); move to S3-compatible for multi-node |
| Maps/location | Mapbox token served only via `GET /api/config/map` (never bundled); distance computed server-side |
| Email | Nodemailer over SMTP 465 (implicit TLS) |
| Background jobs | In-process cron (`server/cron-scanner.ts`), gated OFF by `ENABLE_NIGHTLY_SCAN` |
| Config | Environment variables only (`.env`), never committed |

All secrets live in `.env` (server-side). The client bundle contains **no**
secrets; a response sanitizer (`server/index.ts` `BLOCKED_FIELDS`) strips
`passwordHash`, tokens, SMTP/proxy/Kinetic creds, and vendor URLs from every API
response as defense-in-depth.

## 2. Environments (dev / staging / prod)

Same artifact, different `.env`. Recommended split:

| Var | dev | staging | prod |
|---|---|---|---|
| `NODE_ENV` | development | production | production |
| `APP_ORIGIN` | http://localhost:5000 | https://staging.homefrontsolutionsllc.com | https://homefrontsolutionsllc.com |
| `DB_PATH` | ./data.db | /srv/homefront/staging.db | /srv/homefront/data.db |
| `ENABLE_NIGHTLY_SCAN` | (unset) | (unset) | your call |

**To create staging (external):** provision a second systemd unit
`homefront-staging.service` on the same or a separate host with its own `.env`
and port, and a Caddy block for `staging.homefrontsolutionsllc.com`. The CI
`deploy-staging` job (`.github/workflows/ci.yml`) targets it after tests pass.

## 3. What is enforced in code (done)

- **Auth/RBAC:** every protected route runs `requireAuth`/`requireCapability`;
  reps are force-scoped server-side (leads, clock repId, leaderboard/team PII
  projection, knock credit). GPS distance + verification verdict are computed
  server-side and are un-forgeable (client verdict fields are omitted from the
  insert schema).
- **Sessions:** 7-day expiry checked on every read; expired sessions purged every
  6h; `POST /api/auth/logout` (this device) and `POST /api/auth/logout-all`
  (revoke all sessions, audited).
- **Account protection:** 30-min lockout after repeated failed OTP attempts;
  per-IP + per-email rate limits on auth.
- **CSRF / headers:** double-submit token; helmet CSP + HSTS (2y) + frameguard;
  CORS allowlist driven by `APP_ORIGIN`.
- **Audit:** immutable `activity_log`, `activity_overrides` (verdict changes),
  `territory_events`, `lead_events` — covering location activity, overrides,
  assignments, settings changes, exports, logout-all, admin actions.
- **Idempotency:** offline knock queue dedupes on `client_id` (partial unique
  index) — retries never double-log a knock or its commission.
- **Data integrity:** parameterized SQL everywhere; WAL; hot-path indexes on
  users(email), sessions(user), leads(assigned_rep/tenant/status), knock_log
  (lead/rep/verification/knocked_at), activity_log(at/user), clock/pings/commissions.
- **Observability:** per-request `x-request-id` (correlation id in every log line
  and response header); `GET /api/health` (version + uptime + DB probe, no
  secrets); `GET /api/diagnostics` (capability-gated health view).

## 4. Backups & disaster recovery (scripts provided; scheduling is external)

- **`scripts/backup.sh`** — WAL-safe `.backup` snapshot → integrity check →
  age-encrypt (`AGE_RECIPIENT`) → gzip → retention prune. **Encryption is
  required for prod** (location + PII).
- **`scripts/restore.sh`** — decrypt → restore into a scratch copy → integrity
  check + sanity counts → only with `--apply` swaps into place, stopping the
  service and health-checking after. **Test restores, don't assume.**

**To schedule (external):**
```
# /etc/cron.d/homefront-backup   (nightly 03:15 UTC)
15 3 * * *  deploy  AGE_RECIPIENT=age1... DB_PATH=/srv/homefront/data.db BACKUP_DIR=/srv/homefront/backups /srv/homefront/scripts/backup.sh >> /var/log/homefront-backup.log 2>&1
```
Then add an **offsite** step (rclone → Hetzner Storage Box / S3) inside
`backup.sh` where marked, and run a **monthly restore drill** with `restore.sh`
into staging. For continuous replication instead of nightly, run **Litestream**
against `data.db` to S3.

## 5. Items requiring external hosting / DevOps (NOT doable in-repo)

Prioritized; each is a concrete next step, not a fake.

1. **Rotate the leaked secrets** (Gmail app pw, Mapbox, Decodo, Kinetic Basic,
   SCANNER_SECRET) — they've been in shared docs. Rotate, store server-side only.
2. **TLS + HTTPS everywhere** — Caddy auto-Let's Encrypt per DEPLOY_HETZNER.md.
   Secure cookies are N/A today (auth is header-based, not cookie-based).
3. **Error tracking** — add Sentry (`@sentry/node` in `server/index.ts` error
   handler + `@sentry/react` in `client/src/main.tsx`). DSN via env. ~30 min.
4. **Uptime monitoring + alerts** — point an external monitor (BetterStack /
   UptimeRobot / Pingdom) at `/api/health`; alert on `ok:false` or 5xx. Wire a
   Slack/email webhook for CI failures and health flaps.
5. **Log shipping / OpenTelemetry** — the app logs structured lines with request
   ids; ship stdout via the systemd journal to Loki/Datadog, or add an OTEL SDK
   exporter in `server/index.ts` for traces.
6. **Staging environment** — second unit + Caddy vhost (§2); the CI deploy job is
   already gated on green tests.
7. **Feature flags** — add a `feature_flags` row set in `app_settings` (the KV
   table already exists) + a `useFlag()` client hook for gradual/risky rollouts.
8. **Horizontal scaling** — SQLite is single-node. To scale out, migrate to
   Postgres (Drizzle already abstracts most queries; the raw `rawDb.prepare`
   sites in `storage.ts` are the porting work) and move sessions + rate-limit
   state to Redis. Single-box vertical scaling is fine to low-thousands of reps.
9. **Object storage** — move rep-application uploads to S3-compatible storage
   before running more than one backend node.

## 6. Release process

`.github/workflows/ci.yml` runs type-check (tsc + tsgo), unit/component tests,
and a production build on every push/PR. `master` pushes gate a staging deploy
(add the SSH secret + required reviewers in the GitHub `staging` environment).
Promotion to prod = re-run the deploy step against the prod host after a staging
smoke test (`curl /api/health`), with `restore.sh`-based rollback available.
