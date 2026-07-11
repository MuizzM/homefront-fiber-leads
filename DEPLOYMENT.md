# Deployment — portal.homefrontsolutionsllc.com

**The canonical, step-by-step guide is [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**
(Hetzner + Docker Compose + Caddy auto-HTTPS). Also:

- **[docs/DNS.md](docs/DNS.md)** — the one `A` record to add (and the Microsoft-365
  mail records to leave untouched).
- **[docs/INCIDENT_RUNBOOK.md](docs/INCIDENT_RUNBOOK.md)** — rollback, restore, DR.
- **[.env.example](.env.example)** — every environment variable, documented.

This file is a one-screen orientation; when they disagree, `docs/` wins.

---

## The shape

One Node process serves the API **and** the built React SPA on port 5000. State
is one SQLite file + `uploads/` on a Docker volume (`/data`), streamed offsite by
Litestream. Caddy is the only thing bound to host ports (80/443) and terminates
TLS; the app is reachable only on the internal Docker network.

```
homefrontsolutionsllc.com / www   → public marketing site (unchanged, NOT here)
portal.homefrontsolutionsllc.com  → this app, on the Hetzner box behind Caddy
```

## Deploy / roll back

```bash
scripts/deploy.sh          # immutable SHA image · pre-deploy backup · health-gated · auto-rollback
scripts/rollback.sh        # redeploy the previous SHA
scripts/restore.sh <bk>    # roll back DATA from a backup (see the runbook)
```

Migrations run in-process at boot and are **additive/idempotent only** (`CREATE …
IF NOT EXISTS`, duplicate-column-swallowing `ALTER`s) — no separate migration
step, safe on every boot. Destructive schema changes are a manual, approval-gated
procedure (runbook).

## Environment variables (names only — real values live in `.env` on the server)

| Group | Vars | Without them |
|---|---|---|
| Core | `NODE_ENV=production` · `PORT` · `DATA_DIR=/data` · `APP_ORIGIN` · `TRUST_PROXY=1` · `SUPER_ADMIN_EMAILS` | `APP_ORIGIN` unset ⇒ empty CORS allowlist ⇒ browser blocked |
| Login (OTP email) | `SMTP_HOST/PORT/USER/PASS` · `MAIL_FROM` · `MAIL_ADMIN` | no email ⇒ **no one can sign in** |
| Field map | `MAPBOX_PUBLIC_TOKEN` (pk, url-restricted) · `MAPBOX_TOKEN` (secret, server-only) | map returns 503 |
| Scanning (moat) | `KFS_AUTH_URL` · `KFS_AUTH_BASIC` · `PROXY_URL` · `SCANNER_SUBMIT_SECRET` | scanning disabled |
| Backups | `LITESTREAM_BUCKET` + S3/B2 creds | runs, but **no continuous backup** (logged loudly) |
| Nightly scan (opt-in) | `ENABLE_NIGHTLY_SCAN` · `NIGHTLY_*` | off by default (spends proxy $ when on) |

## Health

`GET /api/health` — no auth, DB round-trip, returns `{ ok, version, db, uptimeSec }`
or **503** on a wedged handle. Caddy/uptime-monitor gate on it. `SIGTERM` drains
in-flight requests and checkpoints SQLite before exit (10 s hard cap).

## Pre-cutover checklist

- [ ] `npm run check` · `npm test` · `npm run build` green (CI gate).
- [ ] DNS `A portal → server IP` resolves **before** first deploy (Caddy ACME needs it).
- [ ] `.env` on the server: `APP_ORIGIN` = the real HTTPS origin, SMTP verified, both Mapbox tokens set, `LITESTREAM_BUCKET` + creds set and a restore rehearsed.
- [ ] First boot: logs show migrations applied + a tenant line + `serving on port …`; `curl https://portal…/api/health` → 200.
- [ ] Smoke: OTP login → Today loads → log one outcome → it persists.
- [ ] Only then: point the marketing site's **Portal** tab at `https://portal.homefrontsolutionsllc.com`.
