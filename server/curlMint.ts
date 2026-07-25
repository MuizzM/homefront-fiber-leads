/**
 * CURL-IMPERSONATE MINT — the Cloudflare crack (verified live 2026-07-25).
 *
 * The wall was never really about IPs or UAs: Node's undici stack presents a
 * distinctive TLS/JA3 fingerprint, and Cloudflare flags it regardless of
 * egress. Measured live:
 *   - undici via proxy:        ~50% mint success
 *   - libcurl via proxy:       ~50%
 *   - curl-impersonate direct: 6/6 = 100%  ← the crack
 *   - curl-impersonate proxy:  ~50% (IP lottery still applies)
 *
 * curl-impersonate presents Chrome's exact TLS fingerprint, ALPN, and header
 * order — byte-identical to the site's own frontend. Mints are low-volume by
 * design (1/2s cap, 1,000 checks/token) so the server IP stays far under
 * Cloudflare's per-IP rate radar; high-volume CHECKS stay on rotating
 * residential IPs where the per-IP rate is spread.
 *
 * Transport ladder: impersonate-direct → impersonate-proxy → legacy undici.
 * KFS_MINT_IMPERSONATE=off disables the ladder entirely.
 */
import { execFile } from "node:child_process";

const BIN = process.env.CURL_IMPERSONATE_BIN || "/usr/local/bin/curl-impersonate-chrome";

export interface ImpersonateResponse { status: number; body: string }

function run(url: string, init: { headers: Record<string, string>; body: string }, proxyUrl: string | null, timeoutMs: number): Promise<ImpersonateResponse> {
  const args: string[] = ["-sS", "-o", "-", "-w", "\n%{http_code}", "--max-time", String(Math.ceil(timeoutMs / 1000)), "-X", "POST"];
  if (proxyUrl) args.push("-x", proxyUrl);
  for (const [k, v] of Object.entries(init.headers)) args.push("-H", `${k}: ${v}`);
  args.push("--data-binary", init.body, url);
  return new Promise((resolve, reject) => {
    execFile(BIN, args, { timeout: timeoutMs + 5000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`impersonate mint transport failed: ${err.message}${stderr ? ` (${String(stderr).slice(0, 120)})` : ""}`));
      const text = String(stdout);
      const nl = text.lastIndexOf("\n");
      const status = Number(text.slice(nl + 1).trim()) || 0;
      resolve({ status, body: text.slice(0, nl) });
    });
  });
}

/**
 * Mint through curl-impersonate. `proxyUrl` = Decodo URL for the proxy hop;
 * null = direct server egress. Mirrors mintRequest()'s parsing exactly.
 */
export async function mintViaImpersonate(
  url: string,
  headers: Record<string, string>,
  body: string,
  proxyUrl: string | null,
  timeoutMs = 15_000,
): Promise<{ token: string; expiresAt: number }> {
  const transport = proxyUrl ? "imp-proxy" : "imp-direct";
  const res = await run(url, { headers, body }, proxyUrl, timeoutMs);
  if (res.status !== 200 && res.status !== 201) throw new Error(`Auto-auth blocked (${res.status} via ${transport})`);
  let data: Record<string, unknown>;
  try { data = JSON.parse(res.body) as Record<string, unknown>; }
  catch { throw new Error(`Auto-auth non-JSON body (challenge via ${transport})`); }
  const token = typeof data.token === "string" ? data.token.trim()
    : typeof data.access_token === "string" ? data.access_token.trim() : "";
  if (!token) throw new Error(`No token in mint response (via ${transport})`);
  const now = Date.now();
  const expiresIn = Number(data.expires_in);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0
    ? now + Math.floor(expiresIn * 1000)
    : now + 28 * 60 * 1000;
  if (expiresAt <= now + 60_000) throw new Error(`Minted token expires too soon (via ${transport})`);
  return { token, expiresAt };
}
