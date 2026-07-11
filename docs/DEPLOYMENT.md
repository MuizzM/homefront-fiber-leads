# HomeFront Fiber — Production Deployment (Hetzner + Docker Compose)

Canonical guide for deploying to **portal.homefrontsolutionsllc.com** on Hetzner
Cloud with Docker Compose + Caddy. This is the container path; the bare-metal
systemd alternative is [DEPLOY_HETZNER.md](../DEPLOY_HETZNER.md), the Railway/
Litestream path is [DEPLOY.md](../DEPLOY.md), and the cross-cutting ops notes are
[INFRASTRUCTURE.md](../INFRASTRUCTURE.md).

> **Nothing here has been executed against live Hetzner** — these are the exact
> files, commands, and checks. Run them on the server; don't assume success.

## 1. Architecture

```
Internet ──443──▶ Caddy (TLS, HTTP→HTTPS, gzip/zstd, security headers)
                    └─ internal net ─▶ app (Express: SPA + API, one Node process)
                                          └─ volume app-data:/data
                                               ├─ data.db (SQLite, WAL)
                                               └─ uploads/ (headshots, licenses)
```

- **One app container** — the Express server serves the built SPA *and* the API
  from the same process (it is not split), so there is no separate frontend
  container and no `api.` host is required.
- **No Redis / no separate worker** — there are no queues; sessions live in
  SQLite; the only background job (nightly scan) runs in-process and is **off by
  default** (`ENABLE_NIGHTLY_SCAN`). If you later externalize the worker, add a
  second service running the same image with a worker entrypoint.
- **One stateful volume** (`app-data`) holds the DB *and* uploads (the app puts
  both under `DATA_DIR=/data`). Back this up — a Hetzner snapshot alone is not a
  substitute (see §6).

## 2. Region & OS

- **Region:** Hetzner **Ashburn (US-East)** or **Hillsboro (US-West)** — the reps
  and data are US-based (NC). Pick the closer of the two to the sales region.
- **OS:** **Ubuntu 24.04 LTS** (current LTS; not an EOL release).
- **Size:** **CX22** (2 vCPU / 4 GB) is ample for low-thousands of reps on SQLite;
  resize up later without re-architecting.

## 3. Server setup (once)

```bash
ssh root@SERVER_IP
apt update && apt -y upgrade

# Non-root deploy user with your key
adduser --disabled-password --gecos "" deploy && usermod -aG sudo deploy
install -d -m700 -o deploy -g deploy /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/ && chown deploy:deploy /home/deploy/.ssh/authorized_keys

# Docker Engine + compose plugin
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy

# Harden SSH (only AFTER you've confirmed key login as deploy works)
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

# Automatic security updates + brute-force protection
apt -y install unattended-upgrades fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades
```

**Hetzner Cloud Firewall** (in the console, attached to the server) — this is the
real network boundary, not just `ufw`:
- Inbound **TCP 80, 443** from `0.0.0.0/0` (+ UDP 443 for HTTP/3).
- Inbound **TCP 22** restricted to your admin IP(s) only.
- **No** inbound rules for 5000 / any DB / Docker — the app is internal-only.

## 4. First deploy

```bash
ssh deploy@SERVER_IP
sudo install -d -o deploy -g deploy /srv/homefront && cd /srv/homefront
git clone https://github.com/MuizzM/homefront-fiber-leads.git .

# Secrets — copy the template and fill REAL values (never commit .env)
cp .env.example .env && nano .env      # .env.example documents every variable
#   set APP_ORIGIN=https://portal.homefrontsolutionsllc.com, SMTP (port 465),
#   MAPBOX_*, SUPER_ADMIN_EMAILS, SCANNER_SUBMIT_SECRET (openssl rand -hex 32)

# DNS must already resolve (see docs/DNS.md) so Caddy can get a certificate.
scripts/deploy.sh                      # builds SHA image, backs up, up, health-gates
```

Verify: `curl -fsS https://portal.homefrontsolutionsllc.com/api/health` →
`{"ok":true,...}`. First-run admin: request an OTP for a `SUPER_ADMIN_EMAILS`
address on the login page.

## 5. Releases, rollback

- **Deploy:** `scripts/deploy.sh [sha]` — immutable SHA tag, pre-deploy backup,
  health-gated cutover, auto-rollback on health failure. CI/CD does this via
  [.github/workflows/deploy.yml](../.github/workflows/deploy.yml)
  (staging → approval → prod).
- **Roll back code:** `scripts/rollback.sh` (redeploys the previous SHA).
- **Roll back data:** `scripts/restore.sh <backup> --apply` (see the runbook).
- Migrations run on boot and are **additive/idempotent only**; destructive schema
  changes are a manual, approval-gated procedure (INCIDENT_RUNBOOK.md).

## 6. Backups & DR

Two options — pick one (Litestream is stronger):
- **Litestream (continuous):** already wired in the image (`deploy/start.sh`).
  Set `LITESTREAM_BUCKET` + S3/B2 creds in `.env`; every write streams offsite,
  and a fresh volume auto-restores on boot. **RPO ≈ seconds, RTO ≈ minutes.**
- **Nightly snapshots:** `scripts/backup.sh` (WAL-safe `.backup` → integrity
  check → age-encrypt → gzip → retention prune) from cron; offsite via rclone.
  **RPO ≤ 24h.** Restore/verify with `scripts/restore.sh`.

Back up **all five**, not just the DB: `app-data` volume (DB + uploads), `.env`
(config — store in a password manager, encrypted), audit logs (inside the DB),
and the Docker/compose files (in git). **Run a monthly restore drill** into
staging. Take a **pre-deploy backup** (deploy.sh does) and a **Hetzner snapshot
before infra changes** (snapshot ≠ app backup).

## 7. Monitoring (wire these — external, ~30–60 min total)

- Point an uptime monitor (BetterStack/UptimeRobot) at `/api/health`; alert on
  `ok:false`/5xx. Also watch disk/CPU/memory (Hetzner metrics or node_exporter).
- Add **Sentry** (`@sentry/node` in the error handler, `@sentry/react` in
  `main.tsx`) — DSN via env.
- Logs are structured with request IDs to stdout → `docker compose logs -f` or
  ship the journal to Loki/Datadog.
- The **admin health view** already exists at `/#/diagnostics` (capability-gated,
  no secrets).

## Manual steps still required (not doable in-repo)

1. Provision the Hetzner server + Cloud Firewall (§2–3).
2. Create the DNS A record (docs/DNS.md) **before** first deploy.
3. Fill `.env` with real, rotated secrets on the server.
4. Add the GitHub Environments (`staging`, `production` + reviewers) and the SSH
   secrets for `deploy.yml`.
5. Stand up a `staging` server + `homefront-staging.service`/compose for the
   pipeline's staging stage.
6. Wire Sentry + an uptime monitor (§7).
7. Enable HSTS only after HTTPS is verified (Caddyfile note + helmet).
8. **Marketing site "Portal" tab** (separate codebase — `homefrontsolutionsllc.com`,
   NOT this repo): point its Portal nav link to
   `https://portal.homefrontsolutionsllc.com`. Do this only AFTER the portal's
   HTTPS health check passes, so the button never lands on a broken cert.
