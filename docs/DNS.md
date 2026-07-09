# DNS Configuration — portal.homefrontsolutionsllc.com

> ⚠️ **Email records are OFF-LIMITS.** Do **not** touch, edit, or delete `MX`,
> `SPF` (`TXT v=spf1…`), `DKIM`, `DMARC`, `autodiscover`, or any Microsoft 365 or
> Resend records. This deployment only **adds a web host record** for a
> subdomain, which cannot affect mail delivery for the apex domain. If your DNS
> UI ever asks to "replace" or "overwrite" an existing record, stop — you should
> only be **adding** the records below.

## Records to ADD (web app only)

| Type | Name / Host | Value | TTL | Notes |
|------|-------------|-------|-----|-------|
| `A` | `portal` | `SERVER_IPv4` (Hetzner) | 3600 | The only required record. Points the app subdomain at the server. |
| `AAAA` | `portal` | `SERVER_IPv6` | 3600 | **Only if** IPv6 is fully configured on the server AND tested. Omit otherwise — a broken AAAA causes intermittent failures. |
| `A` | `api` | `SERVER_IPv4` | 3600 | **Optional / not needed.** The app serves the API and SPA from one host. Add only if you split the API later. |

`SERVER_IPv4` / `SERVER_IPv6` are placeholders — use your actual Hetzner server
IPs (do not invent them).

## Records to LEAVE UNTOUCHED (email — Microsoft 365 + Resend)

These already exist on the apex `homefrontsolutionsllc.com` and must not change:

- `MX` → Microsoft 365 (`*.mail.protection.outlook.com`).
- `TXT` SPF (`v=spf1 include:spf.protection.outlook.com include:… -all`) — do not
  edit even if adding a sender; SPF is a single record, mis-editing breaks mail.
- `CNAME`/`TXT` for DKIM (`selector1._domainkey`, `selector2._domainkey`, Resend
  `resend._domainkey` / `send`), `autodiscover`, and any `DMARC` (`_dmarc TXT`).

Adding an `A` record on the `portal` subdomain does not interact with any of
these — apex mail routing and subdomain web hosting are independent.

## HTTPS / TLS

- **Automatic** — Caddy obtains and renews a Let's Encrypt certificate for
  `portal.homefrontsolutionsllc.com` on first boot. **Prerequisite:** the `A`
  record above must resolve *before* you run `scripts/deploy.sh`, or the ACME
  HTTP-01 challenge fails.
- **HTTP→HTTPS redirect** is automatic in Caddy.
- **HSTS** — leave disabled until you've confirmed HTTPS works end-to-end, then
  enable it in the Caddyfile (and/or keep the app's helmet HSTS). See the
  Caddyfile note.

## Verify (after adding the A record)

```bash
dig +short portal.homefrontsolutionsllc.com          # → your server IPv4
dig +short MX homefrontsolutionsllc.com               # → UNCHANGED M365 record
curl -fsS https://portal.homefrontsolutionsllc.com/api/health   # → {"ok":true,...}
```

Confirm the MX line is identical to what it was before you started — that's your
proof email routing is untouched.
