// ── Client error beacon ───────────────────────────────────────────────────────
// The transmit half of the ErrorBoundary's "Support code": crashes used to
// mint an incidentId, console.error it, and throw it away - support could
// never find the crash behind the code a rep read off their phone. Reports go
// to POST /api/client-errors (authenticated, rate-limited server-side) and
// land as structuredLog("client.error") lines next to http.request.
//
// Deliberately quiet and bounded on THIS side too: at most 10 reports per
// page load, identical messages sent once, and every failure to report is
// swallowed - a beacon that can crash the app it watches is worse than none.
import { apiRequest } from "@/lib/queryClient";

const MAX_REPORTS_PER_LOAD = 10;
let sent = 0;
const seen = new Set<string>();

export interface ClientErrorReport {
  kind: "boundary" | "window" | "unhandledrejection";
  incidentId?: string;
  name?: string;
  message: string;
  stack?: string;
}

export function reportClientError(report: ClientErrorReport): void {
  try {
    if (sent >= MAX_REPORTS_PER_LOAD) return;
    const sig = `${report.kind}|${report.message}`.slice(0, 200);
    if (seen.has(sig)) return;
    seen.add(sig);
    sent++;
    void apiRequest("POST", "/api/client-errors", {
      kind: report.kind,
      incidentId: report.incidentId ?? "",
      name: (report.name ?? "").slice(0, 80),
      message: report.message.slice(0, 300),
      stack: (report.stack ?? "").slice(0, 600),
      route: typeof window !== "undefined" ? window.location.hash.slice(0, 80) : "",
    }).catch(() => { /* offline or signed out - the console.error still stands */ });
  } catch { /* never let the beacon throw */ }
}

let installed = false;

/** Global handlers for the errors no boundary sees: synchronous window errors
 *  and unhandled promise rejections. Installed once per page load. */
export function installGlobalErrorBeacon(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (event) => {
    reportClientError({
      kind: "window",
      name: event.error?.name,
      message: String(event.message ?? "Unknown window error"),
      stack: typeof event.error?.stack === "string" ? event.error.stack : undefined,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason: any = event.reason;
    reportClientError({
      kind: "unhandledrejection",
      name: reason?.name,
      message: String(reason?.message ?? reason ?? "Unhandled rejection"),
      stack: typeof reason?.stack === "string" ? reason.stack : undefined,
    });
  });
}
