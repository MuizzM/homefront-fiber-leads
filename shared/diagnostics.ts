// ── Diagnostics read-model — PURE aggregation ─────────────────────────────────
// Turns the append-only activity stream into the operations panel's health
// cards, categorized failures, and severity-labeled feed. Pure so the mapping
// from raw events → health is unit-testable without a DB, and so the server
// route stays a thin read wrapper.

// Bumped per release — surfaced in the diagnostics panel so operators can see
// which build a tenant is on (pairs with the PWA service-worker version).
export const APP_VERSION = "1.0.0";

export type Severity = "ok" | "info" | "warning" | "critical";
export type DiagModule = "sync" | "commission" | "assignment" | "permission" | "auth" | "other";

// The minimum shape the aggregator needs from an activity_log row.
export interface RawEvent {
  action: string;
  at: string;            // ISO
  userId: number | null;
  details: unknown;      // parsed JSON or null
}

export interface HealthCard {
  module: DiagModule;
  label: string;
  severity: Severity;
  value: number;         // headline count (failures / denials / events)
  hint: string;          // one-line operator context
}

export interface DiagEvent {
  action: string;
  module: DiagModule;
  severity: Severity;
  at: string;
  userId: number | null;
  detail: string;        // short human summary
}

export interface DiagnosticsModel {
  healthScore: number;   // 0–100, 100 = all green
  windowHours: number;
  cards: HealthCard[];
  recentFailures: DiagEvent[];      // things an operator should look at
  recentDenials: DiagEvent[];       // permission.denied feed (governance)
  sensitiveActions: DiagEvent[];    // structure/assignment/permission changes — governance review
  readModelAgeMs: number | null;    // age of the newest event (staleness signal); null = no events
  readModelStale: boolean;          // newest event older than the freshness threshold
  totalEvents: number;
}

// Which actions count as failures / denials / high-risk governance actions.
const FAILURE_ACTIONS = new Set<string>(["commission.no_structure"]);
const DENIAL_ACTION = "permission.denied";
const HIGH_RISK_ACTIONS = new Set<string>([
  "commission_structure.created", "commission_structure.updated",
  "lead.assigned", "lead.reassigned",
]);

function moduleOf(action: string): DiagModule {
  if (action.startsWith("commission")) return "commission";
  if (action.startsWith("permission")) return "permission";
  if (action.startsWith("lead.assign") || action.includes("assigned")) return "assignment";
  if (action.startsWith("auth") || action.includes("login") || action.includes("otp")) return "auth";
  if (action.includes("sync") || action.includes("queue")) return "sync";
  return "other";
}

function withinWindow(iso: string, nowMs: number, windowHours: number): boolean {
  const t = Date.parse(iso);
  return Number.isFinite(t) && nowMs - t <= windowHours * 3600_000;
}

// Build the whole model from a raw event slice. `nowMs` is injected so the
// mapping is deterministic and testable (no Date.now() inside).
export function buildDiagnostics(events: RawEvent[], nowMs: number, windowHours = 24): DiagnosticsModel {
  const inWindow = events.filter(e => withinWindow(e.at, nowMs, windowHours));

  const denials = inWindow.filter(e => e.action === DENIAL_ACTION);
  const failures = inWindow.filter(e => FAILURE_ACTIONS.has(e.action));
  const assignmentEvents = inWindow.filter(e => e.action.includes("assigned"));
  const structureChanges = inWindow.filter(e => e.action.startsWith("commission_structure"));

  const sev = (n: number, warnAt: number, critAt: number): Severity =>
    n >= critAt ? "critical" : n >= warnAt ? "warning" : n === 0 ? "ok" : "info";

  // Read-model freshness: age of the NEWEST event across the whole slice (not
  // just the window) — a stale stream means the read models feeding dashboards
  // may be lagging. Threshold: nothing logged in 6h during business use is odd.
  const STALE_MS = 6 * 3600_000;
  const newestMs = events.reduce((mx, e) => Math.max(mx, Date.parse(e.at) || 0), 0);
  const readModelAgeMs = newestMs > 0 ? Math.max(0, nowMs - newestMs) : null;
  const readModelStale = readModelAgeMs != null && readModelAgeMs > STALE_MS;

  // Health score: start at 100, dock for failures (heavy), denial pressure, and
  // a stale read model (operators should notice a quiet stream).
  const score = Math.max(0, 100 - failures.length * 15 - Math.min(denials.length, 10) * 3 - (readModelStale ? 10 : 0));

  const cards: HealthCard[] = [
    { module: "permission", label: "Permission denials", severity: sev(denials.length, 5, 20),
      value: denials.length, hint: denials.length ? "Repeated denials can signal misconfigured access" : "No blocked actions" },
    { module: "commission", label: "Commission engine", severity: failures.length ? "critical" : "ok",
      value: failures.length, hint: failures.length ? "Sales sold with no active plan — book manually" : "All sales scored by an active plan" },
    { module: "assignment", label: "Assignment activity", severity: "ok",
      value: assignmentEvents.length, hint: `${assignmentEvents.length} assignments logged` },
    { module: "commission", label: "Structure changes", severity: structureChanges.length ? "info" : "ok",
      value: structureChanges.length, hint: "Governed edits to commission plans" },
  ];

  const toDiagEvent = (e: RawEvent, severity: Severity): DiagEvent => {
    const d = (e.details ?? {}) as Record<string, unknown>;
    const detail = e.action === DENIAL_ACTION
      ? `needs "${String(d.need ?? "?")}" · ${String(d.path ?? "")}`
      : e.action === "commission.no_structure"
        ? `lead ${String(d.leadId ?? "?")} · rep ${String(d.repId ?? "?")}`
        : JSON.stringify(d).slice(0, 80);
    return { action: e.action, module: moduleOf(e.action), severity, at: e.at, userId: e.userId, detail };
  };

  // Sensitive / suspicious actions — the governance review feed: money-moving
  // structure edits, ownership-changing assignments, and blocked attempts.
  const sensitive = inWindow.filter(e => HIGH_RISK_ACTIONS.has(e.action) || e.action === DENIAL_ACTION);

  return {
    healthScore: score,
    windowHours,
    cards,
    recentFailures: failures.slice(0, 20).map(e => toDiagEvent(e, "critical")),
    recentDenials: denials.slice(0, 20).map(e => toDiagEvent(e, "warning")),
    sensitiveActions: sensitive.slice(0, 25).map(e => toDiagEvent(e, e.action === DENIAL_ACTION ? "warning" : "info")),
    readModelAgeMs,
    readModelStale,
    totalEvents: inWindow.length,
  };
}

export const HIGH_RISK_ACTION_SET = HIGH_RISK_ACTIONS;
