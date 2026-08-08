#!/usr/bin/env node
/**
 * PERF REPORT — summarize production request telemetry into an operator answer.
 *
 * Reads NDJSON log lines on stdin (what `docker logs` emits, since structuredLog
 * writes one JSON object per line) and prints a ranked latency report. Pure
 * analysis: it opens no database, writes no file, and contacts nothing. That is
 * deliberate — the production box runs at ~79% disk, so an observability tool
 * that materializes anything on it would be solving one problem by creating the
 * next one. Everything streams to the runner and dies with the job.
 *
 * ── WHY A SCRIPT AND NOT A DASHBOARD ────────────────────────────────────────
 * There is no metrics stack on this host, and standing one up costs RAM and disk
 * the box does not have (8 GB against an 18.82 GB database). The app already
 * emits per-request timing; the missing piece was never collection, it was that
 * nobody aggregates it. This is the smallest thing that turns existing logs into
 * a decision.
 *
 * ── WHAT IT CAN AND CANNOT SEE ──────────────────────────────────────────────
 * It reports ONLY what the app actually emits today. At time of writing that is
 * `http.request` (method/path/status/durationMs) and a single `perf.leads_map`.
 * Event-loop delay, RSS, SQLite busy counters, scheduler durations and payload
 * bytes are NOT emitted anywhere — so this prints an explicit GAPS section
 * rather than silently reporting zeros. A blank metric must read as "not
 * instrumented", never as "healthy".
 *
 * Usage:
 *   docker logs --since 6h <container> 2>&1 | node scripts/perf-report.mjs
 *   node scripts/perf-report.mjs --json < captured.ndjson
 */

// ── Redaction ───────────────────────────────────────────────────────────────
// The app does not log IPs, session ids, headers or bodies today, and this tool
// must not become the thing that starts. Rather than blocklisting known-bad
// fields (which fails open the moment someone adds a field), every value here
// comes from an explicit allowlist below. Anything unrecognised is dropped.

/**
 * Collapse a concrete request path to its route shape.
 *
 * `/api/leads/8213/knocks` and `/api/leads/9002/knocks` are the SAME endpoint
 * for latency purposes, and keeping them apart would both scatter every
 * percentile across thousands of one-sample buckets AND copy customer-record
 * identifiers into the report. Numeric, UUID, hex-token and long-opaque
 * segments all collapse to a placeholder.
 */
export function normalizeRoute(path) {
  if (typeof path !== "string" || !path) return "(unknown)";
  const clean = path.split("?")[0].split("#")[0];
  return clean
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":uuid";
      if (/^[0-9a-f]{24,}$/i.test(seg)) return ":token";
      // Mixed-case opaque handles (invite codes, referral slugs) are identifiers
      // too — length plus a digit is a good enough tell without eating real
      // route words like "commission-statements".
      if (seg.length >= 16 && /\d/.test(seg) && !seg.includes("-")) return ":opaque";
      return seg;
    })
    .join("/");
}

/** Nearest-rank percentile. `sorted` must be ascending and non-empty. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

const round = (n) => (n == null ? null : Number(n.toFixed(2)));

/**
 * Fold raw log lines into the report model.
 *
 * Unparseable lines are counted, not thrown on: `docker logs` interleaves plain
 * stdout (Vite banners, migration notices, third-party warnings) with our JSON,
 * and a report that dies on the first non-JSON line is useless in an incident.
 */
export function analyze(lines) {
  const routes = new Map();
  const leadsMap = { count: 0, dbMs: [], rows: [], truncated: 0, byCache: new Map(), byFormat: new Map() };
  const statusClasses = new Map();
  const signals = { sqliteBusy: 0, otpUnavailable: 0, walGuard: 0, projectionFailed: 0, alertFailed: 0 };
  let parsed = 0;
  let skipped = 0;
  let firstTs = null;
  let lastTs = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] !== "{") { if (line) skipped++; continue; }
    let rec;
    try { rec = JSON.parse(line); } catch { skipped++; continue; }
    if (!rec || typeof rec !== "object" || typeof rec.event !== "string") { skipped++; continue; }
    parsed++;

    if (typeof rec.ts === "string") {
      if (firstTs === null || rec.ts < firstTs) firstTs = rec.ts;
      if (lastTs === null || rec.ts > lastTs) lastTs = rec.ts;
    }

    switch (rec.event) {
      case "http.request": {
        const route = `${rec.method ?? "?"} ${normalizeRoute(rec.path)}`;
        let bucket = routes.get(route);
        if (!bucket) { bucket = { route, durations: [], count: 0, errors: 0, statuses: new Map() }; routes.set(route, bucket); }
        bucket.count++;
        if (typeof rec.durationMs === "number" && Number.isFinite(rec.durationMs)) bucket.durations.push(rec.durationMs);
        const status = Number(rec.status);
        if (Number.isFinite(status)) {
          const cls = `${Math.floor(status / 100)}xx`;
          statusClasses.set(cls, (statusClasses.get(cls) ?? 0) + 1);
          bucket.statuses.set(cls, (bucket.statuses.get(cls) ?? 0) + 1);
          if (status >= 500) bucket.errors++;
        }
        break;
      }
      case "perf.leads_map": {
        leadsMap.count++;
        if (typeof rec.dbMs === "number") leadsMap.dbMs.push(rec.dbMs);
        if (typeof rec.rows === "number") leadsMap.rows.push(rec.rows);
        if (rec.truncated === true) leadsMap.truncated++;
        const c = String(rec.cache ?? "?"); leadsMap.byCache.set(c, (leadsMap.byCache.get(c) ?? 0) + 1);
        const f = String(rec.format ?? "?"); leadsMap.byFormat.set(f, (leadsMap.byFormat.get(f) ?? 0) + 1);
        break;
      }
      // Contention and wedge signals. These are the events that tell you WHY a
      // percentile moved, so they are counted even though none of them carry
      // timing of their own.
      case "auth.otp_unavailable": signals.otpUnavailable++; break;
      case "db.wal_guard": signals.walGuard++; break;
      case "fresh_fiber.projection_failed": signals.projectionFailed++; break;
      case "state_monitor.alert_failed": signals.alertFailed++; break;
      default: break;
    }

    // SQLITE_BUSY surfaces as a substring on several different events rather
    // than an event of its own, so match on the code across any record.
    if (typeof rec.error === "string" && /SQLITE_BUSY|database is locked/i.test(rec.error)) signals.sqliteBusy++;
    if (typeof rec.code === "string" && /SQLITE_BUSY/i.test(rec.code)) signals.sqliteBusy++;
  }

  const routeRows = [...routes.values()].map((b) => {
    const sorted = [...b.durations].sort((a, z) => a - z);
    const total = sorted.reduce((s, n) => s + n, 0);
    return {
      route: b.route,
      count: b.count,
      p50: round(percentile(sorted, 50)),
      p95: round(percentile(sorted, 95)),
      p99: round(percentile(sorted, 99)),
      max: round(sorted.length ? sorted[sorted.length - 1] : null),
      meanMs: round(sorted.length ? total / sorted.length : null),
      // Total wall-clock this route accounts for. Ranking on p95 alone
      // over-weights a rare admin export; ranking on total time finds what the
      // fleet actually spends its day doing.
      totalMs: round(total),
      errors: b.errors,
      statuses: Object.fromEntries(b.statuses),
    };
  });

  const dbSorted = [...leadsMap.dbMs].sort((a, z) => a - z);
  const rowsSorted = [...leadsMap.rows].sort((a, z) => a - z);

  return {
    window: { from: firstTs, to: lastTs, parsedRecords: parsed, skippedLines: skipped },
    statusClasses: Object.fromEntries(statusClasses),
    routes: routeRows,
    leadsMap: leadsMap.count === 0 ? null : {
      samples: leadsMap.count,
      dbMs: { p50: round(percentile(dbSorted, 50)), p95: round(percentile(dbSorted, 95)), p99: round(percentile(dbSorted, 99)) },
      rows: { p50: percentile(rowsSorted, 50), p95: percentile(rowsSorted, 95), max: rowsSorted.length ? rowsSorted[rowsSorted.length - 1] : null },
      truncated: leadsMap.truncated,
      byCache: Object.fromEntries(leadsMap.byCache),
      byFormat: Object.fromEntries(leadsMap.byFormat),
    },
    signals,
  };
}

/**
 * Telemetry the operator questions need that NOTHING currently emits.
 *
 * Printed on every run on purpose. The danger with a perf report is that a
 * missing number reads as a good number; naming the gap keeps "we cannot see
 * this" visibly different from "this is fine".
 */
export const KNOWN_GAPS = [
  ["response payload bytes", "http.request logs no size — cannot separate serialization/network cost from SQL"],
  ["per-route DB time", "only perf.leads_map emits dbMs; every other route's SQL share is unknown"],
  ["event-loop delay", "not sampled — cannot prove scan/background work is starving HTTP"],
  ["process RSS / heap", "not sampled — cannot correlate latency with memory pressure or GC"],
  ["SQLite busy/lock counters", "only inferred from error strings; no counter of waits or wait duration"],
  ["scheduler / job durations", "no consistent job.* timing event"],
  ["scan-engine write + failure rate", "no aggregate counter emitted"],
  ["client render timing", "no RUM — server timing cannot explain perceived map slowness"],
];

function fmt(n, width) { return String(n ?? "—").padStart(width); }

function render(report) {
  const out = [];
  const w = report.window;
  out.push("═".repeat(78));
  out.push("PRODUCTION PERF REPORT");
  out.push("═".repeat(78));
  out.push(`window        ${w.from ?? "?"}  →  ${w.to ?? "?"}`);
  out.push(`records       ${w.parsedRecords} parsed, ${w.skippedLines} non-JSON lines skipped`);
  if (w.parsedRecords === 0) {
    out.push("");
    out.push("NO STRUCTURED RECORDS FOUND. Either the window is empty, or the log ring");
    out.push("(json-file, max-size 10m x max-file 5) already rolled past it.");
    return out.join("\n");
  }
  out.push(`status mix    ${Object.entries(report.statusClasses).map(([k, v]) => `${k}=${v}`).join("  ") || "—"}`);
  out.push("");

  const byP95 = [...report.routes].filter((r) => r.p95 != null).sort((a, z) => z.p95 - a.p95);
  out.push("── SLOWEST USER-FACING ENDPOINTS (by p95) ".padEnd(78, "─"));
  out.push("  p95      p99      p50      n      errors  route");
  for (const r of byP95.slice(0, 10)) {
    out.push(`${fmt(r.p95, 7)}ms${fmt(r.p99, 8)}ms${fmt(r.p50, 8)}ms${fmt(r.count, 7)}${fmt(r.errors, 8)}  ${r.route}`);
  }
  out.push("");

  const byTotal = [...report.routes].filter((r) => r.totalMs != null).sort((a, z) => z.totalMs - a.totalMs);
  out.push("── HIGHEST TOTAL TIME (where the fleet actually spends its day) ".padEnd(78, "─"));
  out.push("  total       n     mean    route");
  for (const r of byTotal.slice(0, 10)) {
    out.push(`${fmt(Math.round(r.totalMs), 8)}ms${fmt(r.count, 7)}${fmt(r.meanMs, 8)}ms  ${r.route}`);
  }
  out.push("");

  if (report.leadsMap) {
    const m = report.leadsMap;
    out.push("── MAP FEED (perf.leads_map) ".padEnd(78, "─"));
    out.push(`  samples ${m.samples}   dbMs p50=${m.dbMs.p50} p95=${m.dbMs.p95} p99=${m.dbMs.p99}`);
    out.push(`  rows    p50=${m.rows.p50} p95=${m.rows.p95} max=${m.rows.max}   truncated=${m.truncated}`);
    out.push(`  cache   ${Object.entries(m.byCache).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    out.push(`  format  ${Object.entries(m.byFormat).map(([k, v]) => `${k}=${v}`).join("  ")}`);
    out.push("");
  }

  out.push("── CONTENTION SIGNALS ".padEnd(78, "─"));
  const s = report.signals;
  out.push(`  SQLITE_BUSY / locked      ${s.sqliteBusy}`);
  out.push(`  auth.otp_unavailable      ${s.otpUnavailable}   (sign-in 503s from write-lock contention)`);
  out.push(`  db.wal_guard fires        ${s.walGuard}`);
  out.push(`  fresh_fiber projection    ${s.projectionFailed} failed`);
  out.push(`  state_monitor alert       ${s.alertFailed} failed`);
  out.push("");

  out.push("── NOT INSTRUMENTED (absent ≠ healthy) ".padEnd(78, "─"));
  for (const [name, why] of KNOWN_GAPS) out.push(`  ${name.padEnd(30)} ${why}`);
  return out.join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// import.meta.url vs argv[1] so the module can be imported by tests without
// executing. Kept last so every export above is defined first.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const chunks = [];
  process.stdin.on("data", (d) => chunks.push(d));
  process.stdin.on("end", () => {
    const report = analyze(Buffer.concat(chunks).toString("utf8").split("\n"));
    process.stdout.write(process.argv.includes("--json")
      ? JSON.stringify(report, null, 2) + "\n"
      : render(report) + "\n");
  });
}
