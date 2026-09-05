// Read-only by default; explicit repair input may restart existing sender DNS
// verification. Never select OTPs, sessions, passwords or keys.
const path = require("node:path");

function mailConfiguration(env) {
  const domain = (value) => {
    const match = String(value || "").match(/@([a-z0-9.-]+)(?:>|\s|$)/i);
    return match ? match[1].toLowerCase() : null;
  };
  return {
    production: env.NODE_ENV === "production",
    resendKeyPresent: Boolean(env.RESEND_API_KEY?.trim()),
    smtpHostIsResend: env.SMTP_HOST?.trim().toLowerCase() === "smtp.resend.com",
    smtpUserPresent: Boolean(env.SMTP_USER),
    smtpPasswordPresent: Boolean(env.SMTP_PASS),
    smtpPort: /^\d{2,5}$/.test(env.SMTP_PORT || "") ? Number(env.SMTP_PORT) : null,
    resendFromDomain: domain(env.RESEND_FROM),
    mailFromDomain: domain(env.MAIL_FROM),
  };
}

function accountStatus(db, email, now = Date.now()) {
  const user = db.prepare("SELECT active FROM users WHERE email = ? LIMIT 1").get(email);
  // Bound work even if the audit table has no email index. Missing history is
  // inconclusive when the relevant request fell outside these newest rows.
  const attempts = db.prepare("SELECT kind, success, reason, created_at FROM (SELECT id, email, kind, success, reason, created_at FROM login_attempts ORDER BY id DESC LIMIT 2000) WHERE email = ? ORDER BY id DESC LIMIT 10").all(email);
  const reasons = new Set(["rate_limited", "account_inactive", "unknown_email", "code_sent", "code_created_mail_failed", "bad_code", "organization_inactive", "success"]);
  const requestBucket = db.prepare("SELECT count, locked_until FROM otp_rate_buckets WHERE bucket = 'request' AND key = ?").get("email:" + email);
  return {
    accountExists: Boolean(user),
    active: user ? Boolean(user.active) : null,
    historyScope: "newest_2000_requests_across_accounts",
    recentAttempts: attempts.map((attempt) => ({
      kind: ["request", "verify"].includes(attempt.kind) ? attempt.kind : "unknown",
      success: Boolean(attempt.success),
      reason: reasons.has(attempt.reason) ? attempt.reason : "unknown",
      createdAt: /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{3}Z|Z)?$/.test(attempt.created_at) ? attempt.created_at : null,
    })),
    storedRequestCount: requestBucket?.count ?? 0,
    requestLockSeconds: Math.max(0, Math.ceil(((requestBucket?.locked_until ?? 0) - now) / 1000)),
  };
}

function mailFailureCategory(line) {
  if (/"event"\s*:\s*"auth\.otp_unavailable"/.test(line)) {
    return /SQLITE_BUSY|SQLITE_LOCKED/.test(line) ? "otp_database_busy" : "otp_unavailable";
  }
  if (/"event"\s*:\s*"otp_rate_buckets\.degraded"/.test(line)) return "otp_rate_store_degraded";
  if (!/\[otp\]|\[mail\]/.test(line)) return null;
  if (/quota|daily.*limit|monthly.*limit|sending limit|maximum.*emails/i.test(line)) return "provider_quota";
  if (/not verified|verify.*domain|domain.*verif/i.test(line)) return "sender_domain";
  if (/invalid.*api.?key|invalid.*token|unauthorized|authentication|535|\(401\)/i.test(line)) return "provider_auth";
  if (/\(429\)|too many requests|rate.?limit/i.test(line)) return "provider_rate_limit";
  if (/time.?out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|unreachable|ESOCKET/i.test(line)) return "provider_connection";
  if (/Resend API send failed/.test(line)) {
    const status = line.match(/Resend delivery failed \(([45]\d\d)\)/)?.[1];
    return status ? "resend_http_" + status : "resend_failed";
  }
  if (/mail delivery failed/.test(line)) return "delivery_failed";
  return "other_mail_event";
}

async function senderDomainStatus(env, request = fetch) {
  const configuration = mailConfiguration(env);
  const domain = configuration.resendFromDomain || configuration.mailFromDomain;
  const key = env.RESEND_API_KEY?.trim() || (configuration.smtpHostIsResend ? env.SMTP_PASS?.trim() : "");
  if (!key || !domain) return { available: false };
  const get = async (resource) => {
    const response = await request("https://api.resend.com/domains" + resource, {
      method: "GET", redirect: "error", headers: { Authorization: "Bearer " + key },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { status: response.status };
    return { status: response.status, data: await response.json() };
  };
  try {
    const list = await get("");
    if (!Array.isArray(list.data?.data)) return { status: list.status };
    // Only this configured sender's exact domain; never inspect other tenants'
    // email contents or unrelated domains belonging to the provider account.
    const match = list.data.data.slice(0, 100).find((item) => item.name === domain);
    if (!match || !/^[a-f0-9-]{36}$/i.test(match.id)) return { status: list.status, domainFound: false };
    const detail = await get("/" + match.id);
    if (detail.data?.name !== domain) return { status: detail.status, domainFound: true };
    const statuses = new Set(["not_started", "pending", "verified", "failed", "temporary_failure"]);
    const status = (value) => statuses.has(value) ? value : "unknown";
    let verification;
    if (env.AUTH_DIAG_VERIFY_SENDER === "true") {
      // Repair only this application's existing sender. This checks already
      // restored DNS; it does not add domains, change records or send email.
      if (domain !== "portal.homefrontsolutionsllc.com") {
        verification = { requested: false, reason: "sender_outside_repair_scope" };
      } else if (detail.data.status === "verified") {
        verification = { requested: false, reason: "already_verified" };
      } else {
        const response = await request("https://api.resend.com/domains/" + match.id + "/verify", {
          method: "POST", redirect: "error", headers: { Authorization: "Bearer " + key },
          signal: AbortSignal.timeout(8000),
        });
        verification = { requested: response.ok, status: response.status };
      }
    }
    return {
      status: detail.status, domain, domainStatus: status(detail.data.status),
      ...(verification ? { verification } : {}),
      // These are public DNS verification records, not authentication keys.
      dnsRecords: (Array.isArray(detail.data.records) ? detail.data.records : []).slice(0, 10)
        .filter((record) => ["DKIM", "SPF"].includes(record.record)
          && ["TXT", "MX", "CNAME"].includes(record.type)
          && typeof record.name === "string" && /^[a-z0-9_.-]{1,254}$/i.test(record.name)
          && typeof record.value === "string" && record.value.length <= 2048)
        .map((record) => ({ purpose: record.record, type: record.type, name: record.name,
          value: record.value, priority: Number.isInteger(record.priority) ? record.priority : null,
          status: status(record.status) })),
    };
  } catch { return { available: false, reason: "provider_read_failed" }; }
}

async function main(env) {
  if (env.AUTH_DIAG_MODE === "logs") {
    const counts = {};
    let bytes = 0;
    let truncated = false;
    const lines = require("node:readline").createInterface({ input: process.stdin });
    for await (const line of lines) {
      bytes += Buffer.byteLength(line);
      if (bytes > 2_000_000) { truncated = true; break; }
      const category = mailFailureCategory(line);
      if (category) counts[category] = (counts[category] || 0) + 1;
    }
    process.stdin.destroy();
    console.log(JSON.stringify({ scope: "global_events_last_30m_max_10000_lines", truncated, mailFailureCounts: counts }));
    return;
  }
  const email = Buffer.from(env.AUTH_DIAG_EMAIL_B64 || "", "base64").toString("utf8").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("invalid_email");
  const Database = require("better-sqlite3");
  const db = new Database(path.join(env.DATA_DIR || process.cwd(), "data.db"), { readonly: true, fileMustExist: true, timeout: 1000 });
  try {
    console.log(JSON.stringify({ configuration: mailConfiguration(env), account: accountStatus(db, email) }));
  } finally {
    db.close();
  }
  console.log(JSON.stringify({ senderDomain: await senderDomainStatus(env) }));
}

module.exports = { mailConfiguration, accountStatus, mailFailureCategory, senderDomainStatus };
if (["account", "logs"].includes(process.env.AUTH_DIAG_MODE)) {
  const deadline = setTimeout(() => {
    console.error("Authentication diagnostic exceeded its time budget.");
    process.exit(1);
  }, 35_000);
  main(process.env).catch(() => {
    // Driver/provider errors can contain data. Keep failure output generic.
    console.error("Authentication diagnostic failed; no raw error details emitted.");
    process.exitCode = 1;
  }).finally(() => clearTimeout(deadline));
}
