# Deploying the HomeFront portal to Railway (→ portal.homefrontsolutionsllc.com)

Stateful Node app (Express + SQLite + file uploads) → it needs one always-on
instance with a **persistent volume**. Railway builds the included `Dockerfile`
(which also runs **Litestream** for continuous off-site database backup) and
reads `railway.json` for the health check + restart policy.

## 1. Push the code to GitHub
```bash
git add -A && git commit -m "portal"
git push -u origin main
```
`.env`, `data.db*`, `uploads/`, `node_modules/` are gitignored — secrets and
local data stay off GitHub.

## 2. Create the service on Railway
1. https://railway.app → **New Project → Deploy from GitHub repo** → pick this repo.
2. Railway detects the `Dockerfile` and `railway.json` automatically.
3. Service → **Settings → Volumes → Add volume**, mount path **`/data`** (1–5 GB).
   This holds `data.db` + `uploads/` across every redeploy.

## 3. Set environment variables (service → Variables)
Copy values from your local `.env` (`.env.example` documents each one):

| Variable | Value / note |
|---|---|
| `DATA_DIR` | `/data` (must match the volume mount) |
| `APP_ORIGIN` | `https://portal.homefrontsolutionsllc.com` |
| `MAPBOX_PUBLIC_TOKEN` | pk.… map token — **domain-restrict it, see §6** |
| `MAPBOX_TOKEN` | sk.… geocoding token (server-only; optional if you don't run Mapbox harvests) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | email for login codes — Resend SMTP works: host `smtp.resend.com`, user `resend`, pass = API key |
| `SUPER_ADMIN_EMAILS` | your admin email(s), comma-separated |
| `KFS_AUTOMATION_AUTHORIZED` | Enables the confirmed Kinetic token/search contract; defaults to disabled |
| `SCANNER_SUBMIT_SECRET` / `PROXY_URL` | scanner + Decodo proxy (from local .env) |
| `ENABLE_NIGHTLY_SCAN` | leave **unset** (nightly scan stays OFF — proxy costs money) |
| `LITESTREAM_BUCKET` / `LITESTREAM_ENDPOINT` / `LITESTREAM_ACCESS_KEY_ID` / `LITESTREAM_SECRET_ACCESS_KEY` | backups — see §5 |

`NODE_ENV=production` and `TRUST_PROXY` (defaults to `1` in production) are
already handled; `PORT` is injected by Railway.

Deploy runs automatically. The health check `/api/health` gates each deploy —
a broken build never replaces the live one.

## 4. First-run admin setup
The production database starts **empty**. Open the app → first-run setup →
create the admin account with the email from `SUPER_ADMIN_EMAILS`.
To migrate your local data instead, see §8.

## 5. Turn on backups (do this before real data goes in)
1. Backblaze B2 → create bucket `hfs-portal-backup` (private).
2. Create an **application key** scoped to that bucket.
3. Set the four `LITESTREAM_*` variables in Railway (endpoint looks like
   `https://s3.us-east-005.backblazeb2.com` — shown on the bucket page).
4. Redeploy. Logs should show `[start] Litestream enabled`.

From then on every change streams to B2 (~pennies/month). **Disaster recovery
is automatic**: a fresh/empty volume restores itself from B2 on boot
(`litestream restore -if-db-not-exists`). Point-in-time restore window: 72h.

## 6. Lock down the Mapbox token 🔒
Mapbox dashboard → the `pk.` token → **URL restrictions** →
`https://portal.homefrontsolutionsllc.com` (and your Railway `*.up.railway.app`
URL while testing). Scope: `styles:read` + `tiles:read` only — never geocoding.
This is the #1 cost safeguard: a leaked restricted token is useless elsewhere.

## 7. Attach the portal subdomain
1. Railway service → **Settings → Networking → Custom Domain** →
   `portal.homefrontsolutionsllc.com`. Railway shows a CNAME target.
2. At your DNS: **CNAME** · name `portal` · value `<target>.up.railway.app`.
3. HTTPS is issued automatically once DNS propagates.

Then add the button on the main site:
```html
<a href="https://portal.homefrontsolutionsllc.com">Portal →</a>
```

## 8. (Optional) Migrate existing local data
Easiest path: enable backups first (§5), then from this folder replicate your
local DB straight into the bucket once:
```bash
litestream replicate -config deploy/litestream.yml   # run briefly, Ctrl-C
```
…or ask and I'll walk the exact copy for your setup. A fresh deploy with an
empty volume then restores that data automatically.

## Redeploys
Every push to `main` auto-deploys. `/data` (database + uploads) and the B2
replica persist — no data is lost, and a failed health check keeps the old
version serving.
