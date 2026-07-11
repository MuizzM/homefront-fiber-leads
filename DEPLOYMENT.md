# Deployment runbook — portal.homefrontsolutionsllc.com

Production is a single Node process (Express 5 + better‑sqlite3) that serves both the
API and the built React client on one port. State lives in one SQLite file on a
**persistent volume**, continuously replicated to object storage by Litestream.

> This is a runbook, not an automated deploy. Nothing here runs on its own — a human
> with credentials performs the steps.

---

## 1. Build & run

| Step | Command | Notes |
|------|---------|-------|
| Build | `npm run build` | Emits `dist/public/` (client) + `dist/index.cjs` (server). No source maps in `dist`. |
| Start (raw) | `npm start` → `node dist/index.cjs` | Direct run, **no backup**. |
| Start (prod) | `deploy/start.sh` | Restores `data.db` from Litestream if the volume is empty, then runs the app under `litestream replicate`. Container `CMD`. |

`Dockerfile` builds the image; `deploy/start.sh` is the entrypoint; `deploy/litestream.yml`
configures replication.

## 2. Boot sequence (server/index.ts)

1. `runMigrations()` — **idempotent + additive** (`CREATE TABLE IF NOT EXISTS` + duplicate‑column‑swallowing `ALTER`s). Safe to run on every boot. Creates the `tenants` table first, so a **fresh volume with no `db:push` boots correctly**.
2. `bootstrapDefaultTenant()` — creates the "Home Front Solutions" tenant by slug if missing and adopts unowned (`tenant_id IS NULL`) rows. System audit rows (`user_id IS NULL`) are left tenant‑less by design.
3. One‑time commission backfill + resume of any interrupted scan runs.
4. `listen()` on `PORT`, host `0.0.0.0`.
5. **Graceful shutdown**: `SIGTERM`/`SIGINT` drain the HTTP server, close SQLite (checkpoints WAL — clean for Litestream), then exit. Hard 10 s cap.

No separate migration step is required in the pipeline — migrations run in‑process at boot.

## 3. Environment variables

Names only — set the real values in the platform's secret store. **Never** commit secrets.

### Required — app won't work correctly without these
| Var | Purpose |
|-----|---------|
| `NODE_ENV=production` | Enables static serving, `trust proxy`, prod rate‑limit metering. |
| `PORT` | Platform‑assigned listen port. |
| `DATA_DIR` | Directory holding `data.db` — **must be a persistent volume** (default `/data`). |
| `APP_ORIGIN=https://portal.homefrontsolutionsllc.com` | Canonical origin. **If unset the CORS allowlist is empty** and browsers are blocked. |
| `SUPER_ADMIN_EMAILS` | Comma‑separated super‑admin emails (platform operator). |

### Required for login (OTP email)
`SMTP_HOST` · `SMTP_PORT` · `SMTP_USER` · `SMTP_PASS` · `MAIL_FROM` · `MAIL_ADMIN`
Without working SMTP, OTP codes can't be delivered → **no one can log in**. Verify a test send before cutover.

### Required for the field map
| Var | Purpose |
|-----|---------|
| `MAPBOX_PUBLIC_TOKEN` | Public `pk.*` token, **URL‑restricted to styles/tiles only** (never geocoding). Served to the browser at runtime via `/api/config/map` — not in the bundle. |
| `MAPBOX_TOKEN` | Secret geocoding token, **server‑side only**. |

If neither is set the map returns 503 and reps see no map. (Mapbox GL is now lazy‑loaded — the rep flow, login, and non‑map screens never download it.)

### Scanning (the moat) — Kinetic + Decodo proxy
`KFS_BASE_URL` · `KFS_AUTH_URL` · `KFS_AUTH_BASIC` · `PROXY_URL` · `PROXY_INSECURE_TLS`
Cost guardrails: `SCAN_USD_PER_GB` · `SCAN_BYTES_PER_CHECK` · `MAPBOX_HARVEST_CAP`.
See the "Mapbox cost guardrails" and "Decodo proxy & spend map" notes — geocoding fallbacks are intentionally **not** silent.

### Nightly auto‑scan (opt‑in — leave OFF unless intended)
`ENABLE_NIGHTLY_SCAN=true` · `NIGHTLY_BUDGET_MIN` · `NIGHTLY_SCAN_COUNT` · `NIGHTLY_SCAN_ENV`
Default is OFF (logged loudly). Turning it on spends proxy bandwidth.

### Backups (strongly recommended)
`LITESTREAM_BUCKET` (+ the bucket's credentials per `litestream.yml`). **If unset, `start.sh` runs with NO continuous backup** — the whole DB lives on one volume. Set this before real data lands.

### Ops tuning (optional)
`TRUST_PROXY` (default `1` in prod) · `API_RATE_LIMIT_MAX` (default `150`/15 min) · `EXTRA_ORIGINS` · `EMBED_ANCESTORS` · `DB_PATH` · `RADAR_LIVE` · `TRACERFY_API_KEY`.

## 4. Health check

`GET /api/health` — no auth, no secrets. Exercises the DB (`storage.getSession`) and returns
`{ ok, status, version, db, uptimeSec }`, or **503** if the SQLite handle is wedged. Point the
platform's deploy gate / uptime monitor at it.

## 5. Reverse proxy / TLS

- Terminate TLS at the platform edge; forward to the app port.
- Keep `X‑Forwarded‑For` intact — `trust proxy` + per‑IP rate limiting depend on it. Set `TRUST_PROXY=2` if a CDN sits in front of the load balancer.
- HSTS (2 yr, preload), CSP, and the secret‑stripping response sanitizer are enforced in‑app (`server/index.ts`); no extra proxy config needed.

## 6. Pre‑cutover checklist

- [ ] `npm run check` · `npm test` · `npm run build` all green (CI gate).
- [ ] `DATA_DIR` on a **persistent** volume; `LITESTREAM_BUCKET` set and a restore rehearsed.
- [ ] `APP_ORIGIN` = the real HTTPS origin; SMTP send verified; both Mapbox tokens set and scoped.
- [ ] `SUPER_ADMIN_EMAILS` correct; `ENABLE_NIGHTLY_SCAN` intentionally set (default OFF).
- [ ] First boot: confirm logs show `SQLite WAL + indexes applied`, a tenant bootstrap line, and `serving on port …`; then `GET /api/health` → 200.
- [ ] Smoke: OTP login as a rep → Today loads → log one outcome → confirm it persists.

## 7. Rollback

Images are immutable — redeploy the previous image. Migrations are additive‑only (no destructive
`DROP`/`ALTER … DROP`), so an older image runs against the newer DB safely. For data loss, restore
`data.db` from the Litestream replica onto a fresh volume and boot.
