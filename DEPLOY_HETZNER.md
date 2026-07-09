# Deploying HomeFront Fiber to Hetzner → homefrontsolutionsllc.com

A standalone, HTTPS, auto-renewing production deploy on a single Hetzner Cloud VPS.
Node app runs under systemd on `127.0.0.1:5000`; Caddy terminates TLS and reverse-proxies.

---

## 0. Before you touch a server: ROTATE EVERY SECRET

The credentials in the build brief have been shared in plaintext repeatedly. Treat all
of them as compromised. Do NOT deploy with the old values.

- **Gmail app password** (`SMTP_PASS`) — revoke at https://myaccount.google.com/apppasswords, generate a new one.
- **Mapbox token** (`MAPBOX_TOKEN`) — rotate at https://account.mapbox.com/access-tokens/ and scope it to URL `https://homefrontsolutionsllc.com/*`.
- **`SCANNER_SECRET`** — regenerate: `openssl rand -hex 32`.
- **Kinetic Basic / Decodo proxy** — only needed if you run the scanner. Leave both unset for a CRM-only deploy (see §7).

---

## 1. Create the server

1. Hetzner Cloud console → **New Project** → **Add Server**.
2. Location: a US region (e.g. Ashburn) — closest to your reps and Mapbox edge.
3. Image: **Ubuntu 24.04**.
4. Type: **CX22** (2 vCPU / 4 GB) is ample; scale up later if needed.
5. Add your **SSH key** (don't use password login).
6. Create. Note the **public IPv4**, e.g. `203.0.113.10`.

---

## 2. DNS — point the domain at the box

At your domain registrar for `homefrontsolutionsllc.com`, create:

| Type | Name | Value            | TTL  |
|------|------|------------------|------|
| A    | `@`  | `203.0.113.10`   | 3600 |
| A    | `www`| `203.0.113.10`   | 3600 |

Verify before continuing (propagation can take minutes):

```bash
dig +short homefrontsolutionsllc.com     # → 203.0.113.10
```

---

## 3. First login & base hardening

```bash
ssh root@203.0.113.10

# Patch
apt update && apt -y upgrade

# Create a non-root deploy user
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh

# Firewall: only SSH + HTTP/HTTPS
ufw allow OpenSSH
ufw allow 80,443/tcp
ufw --force enable

# Disable root SSH + password auth
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

# Automatic security updates
apt -y install unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades
```

Reconnect as `deploy` for everything below:

```bash
ssh deploy@203.0.113.10
```

---

## 4. Install Node 20 + build toolchain

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt -y install nodejs build-essential python3   # build-essential/python3 for better-sqlite3 native build
node -v   # v20.x
```

---

## 5. Get the code & build

```bash
sudo mkdir -p /srv/homefront && sudo chown deploy:deploy /srv/homefront
cd /srv/homefront
git clone https://github.com/MuizzM/homefront-fiber-leads.git .

npm ci
npm run build            # → dist/index.cjs (+ dist/public)
```

Create the production env file (root-readable only):

```bash
umask 077
cat > /srv/homefront/.env <<'EOF'
NODE_ENV=production
PORT=5000
APP_ORIGIN=https://homefrontsolutionsllc.com
DB_PATH=/srv/homefront/data.db

# Auth / access
SUPER_ADMIN_EMAILS=you@homefrontsolutionsllc.com
SCANNER_SECRET=<paste `openssl rand -hex 32`>

# Mapbox (served to frontend only via /api/config/map)
MAPBOX_TOKEN=<new rotated pk. token>

# SMTP for OTP login emails
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@homefrontsolutionsllc.com
SMTP_PASS=<new rotated app password>

# Scanner stays OFF unless you deliberately enable it (see §7).
# ENABLE_NIGHTLY_SCAN is intentionally omitted → defaults disabled.
EOF
chmod 600 /srv/homefront/.env
```

> The CORS allowlist and CSP `frame-ancestors` are now driven purely by `APP_ORIGIN`
> (+ optional `EXTRA_ORIGINS` / `EMBED_ANCESTORS`). With just `APP_ORIGIN` set, the app
> only accepts its own origin — no third-party host is trusted.

---

## 6. Run it under systemd

```bash
sudo tee /etc/systemd/system/homefront.service >/dev/null <<'EOF'
[Unit]
Description=HomeFront Fiber
After=network.target

[Service]
Type=simple
User=deploy
WorkingDirectory=/srv/homefront
EnvironmentFile=/srv/homefront/.env
ExecStart=/usr/bin/node dist/index.cjs
Restart=always
RestartSec=3
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/homefront
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now homefront
sudo systemctl status homefront --no-pager
curl -s localhost:5000/api/config/map -H "x-session-id: x" | head   # 401 = app is up
```

### TLS + reverse proxy with Caddy (auto Let's Encrypt, auto-renew)

```bash
sudo apt -y install debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt -y install caddy

sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
homefrontsolutionsllc.com, www.homefrontsolutionsllc.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:5000
}
EOF

sudo systemctl reload caddy
```

Caddy fetches and renews the certificate automatically. Visit
**https://homefrontsolutionsllc.com** → you should get the login screen.
Request an OTP for your `SUPER_ADMIN_EMAILS` address and log in.

---

## 7. Scanner: intentionally left OFF

This runbook deploys the CRM only. The nightly Kinetic scan is gated by
`ENABLE_NIGHTLY_SCAN` (defaults **off**) and the app never touches the residential
proxy unless `PROXY_URL` is set. I have not included steps to enable either, and I'd
keep them off. If you choose to turn that on, that configuration is yours to add.

---

## 8. Backups (the DB is a single file)

```bash
# Nightly local snapshot, keep 14 days
sudo tee /etc/cron.daily/homefront-backup >/dev/null <<'EOF'
#!/bin/bash
set -e
d=/srv/homefront/backups; mkdir -p "$d"
sqlite3 /srv/homefront/data.db ".backup '$d/data-$(date +%F).db'"
find "$d" -name 'data-*.db' -mtime +14 -delete
EOF
sudo chmod +x /etc/cron.daily/homefront-backup
sudo apt -y install sqlite3
```

For offsite durability, sync `/srv/homefront/backups` to Hetzner Storage Box or S3, or
run Litestream against `data.db` for continuous replication.

---

## 9. Redeploy on new commits

```bash
cd /srv/homefront
git pull origin master
npm ci
npm run build
sudo systemctl restart homefront
```

(Consider a `deploy.sh` wrapping these four lines, and a GitHub Actions runner later.)

---

## Post-deploy checklist

- [ ] All secrets rotated (Gmail, Mapbox, SCANNER_SECRET) — old values dead.
- [ ] `https://homefrontsolutionsllc.com` serves over TLS, `http://` redirects to `https://`.
- [ ] OTP email arrives; super-admin can log in.
- [ ] `ufw status` shows only 22/80/443.
- [ ] `systemctl status homefront caddy` both active; survive `sudo reboot`.
- [ ] Nightly backup cron present; test-restore one snapshot.
- [ ] Mapbox token is URL-restricted to the domain.
- [ ] Scanner remains disabled (`ENABLE_NIGHTLY_SCAN` unset, `PROXY_URL` unset).
