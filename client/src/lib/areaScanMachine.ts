// AREA SCAN STATE MACHINE — the field map's OWN, explicit, persistent scan
// lifecycle. The map must never infer "am I scanning?" from the tenant-wide
// discovery-job feed (a stale/orphaned or background job would then light up
// "Scanning fiber" on every launch). Instead the map OWNS exactly one scan —
// the one the operator elected — identified by its jobId, and drives the
// indicator solely from this machine.
//
// Invariants:
//   • Cold launch / navigation / remount / refresh / foreground → `idle`,
//     regardless of what jobs exist on the server. Only START (a user electing
//     a box) can enter `running`.
//   • A persisted `running` scan is RESUMED for DISPLAY only when it is recent
//     (legitimate in-flight progress from this operator). A stale `running`
//     persisted scan is a zombie — it resolves to `idle` and is never shown or
//     restarted. Stale `running` is never permission to restart.
//   • Terminal states are shown once (summary), then dismissed to `idle`.

export type AreaScanStatus =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface AreaScanState {
  status: AreaScanStatus;
  jobId: string | null;      // the discovery job THIS operator owns
  boxKey: string | null;     // scope identity of the drawn box (dedupe/stale)
  startedAt: number | null;  // epoch ms the operator elected the scan
  found: number;             // terminal summary — new leads
  checked: number;           // terminal summary — addresses checked
  error: string | null;
}

export interface PersistedScan {
  status: AreaScanStatus;
  jobId: string | null;
  boxKey: string | null;
  startedAt: number | null;
}

// A `running` scan older than this with nothing keeping it alive is a zombie
// (the process that owned it died, or its terminal event was missed). Never
// shown as running; resolved to idle.
export const STALE_RUNNING_MS = 30 * 60_000;

export const IDLE: AreaScanState = {
  status: "idle", jobId: null, boxKey: null, startedAt: null, found: 0, checked: 0, error: null,
};

export type AreaScanEvent =
  // Operator elected a box — optimistic, before the server returns a jobId.
  | { type: "START"; boxKey: string; at: number }
  // Server accepted the scan → we now own this jobId.
  | { type: "ATTACH"; jobId: string }
  // The submit call itself failed (network/validation) — never a silent hang.
  | { type: "SUBMIT_FAILED"; error?: string }
  // A status update for the OWNED job (from SSE or a targeted fetch). Ignored
  // unless jobId matches — a background/other job can never drive this machine.
  | { type: "JOB_UPDATE"; jobId: string; active: boolean; terminal?: "completed" | "failed" | "cancelled"; found?: number; checked?: number }
  // Backend verification says the owned job DOES NOT EXIST (404/purged). A
  // missing job must resolve to idle — there is no outcome to summarize, and a
  // phantom job must never keep "Scanning fiber" up.
  | { type: "JOB_GONE"; jobId: string }
  // Operator tapped Stop (optimistic; the caller also cancels server-side).
  | { type: "STOP" }
  // Operator dismissed the terminal summary.
  | { type: "DISMISS" }
  // Mount: reconcile the persisted scan. Cold launch (null) → idle.
  | { type: "HYDRATE"; persisted: PersistedScan | null; now: number };

const TERMINAL: ReadonlySet<AreaScanStatus> = new Set(["completed", "failed", "cancelled"]);
export const isTerminal = (s: AreaScanStatus): boolean => TERMINAL.has(s);
export const isActive = (s: AreaScanStatus): boolean => s === "running" || s === "paused";

/** Pure reducer. No I/O, no Date.now — the caller passes timestamps so it is
 *  fully deterministic and unit-testable. */
export function areaScanReducer(state: AreaScanState, event: AreaScanEvent): AreaScanState {
  switch (event.type) {
    case "START":
      // Duplicate-scan guard: a START while already running/paused is ignored —
      // one scan at a time. Only idle or a (dismissed) terminal state may start.
      if (isActive(state.status)) return state;
      return { status: "running", jobId: null, boxKey: event.boxKey, startedAt: event.at, found: 0, checked: 0, error: null };

    case "ATTACH":
      // Only meaningful while we're the running-but-unattached owner.
      if (state.status !== "running") return state;
      return { ...state, jobId: event.jobId };

    case "SUBMIT_FAILED":
      if (state.status !== "running") return state;
      return { ...state, status: "failed", error: event.error ?? "Scan could not start" };

    case "JOB_UPDATE": {
      // Only the owned job drives the machine. A background or unrelated job is
      // structurally incapable of turning the indicator on.
      if (!state.jobId || event.jobId !== state.jobId) return state;
      if (event.terminal) {
        return { ...state, status: event.terminal, found: event.found ?? state.found, checked: event.checked ?? state.checked };
      }
      if (event.active) {
        return { ...state, status: "running", found: event.found ?? state.found, checked: event.checked ?? state.checked };
      }
      // Not active and not explicitly terminal → the job finished; complete it.
      return { ...state, status: "completed", found: event.found ?? state.found, checked: event.checked ?? state.checked };
    }

    case "JOB_GONE":
      // Only the owned job, and only while we're showing it as active. A
      // terminal summary stays up (it has real counts to show).
      if (!state.jobId || event.jobId !== state.jobId || !isActive(state.status)) return state;
      return IDLE;

    case "STOP":
      if (!isActive(state.status)) return state;
      return { ...state, status: "cancelled" };

    case "DISMISS":
      return isTerminal(state.status) ? IDLE : state;

    case "HYDRATE": {
      const p = event.persisted;
      // Cold launch, or a persisted TERMINAL/paused scan → clean idle. We never
      // resurrect an old summary or a stale job on open.
      if (!p || p.status !== "running") return IDLE;
      // A persisted running scan is resumed for DISPLAY only if it is recent.
      const fresh = p.startedAt != null && event.now - p.startedAt < STALE_RUNNING_MS;
      if (!fresh) return IDLE; // zombie — never shown, never restarted
      return { status: "running", jobId: p.jobId, boxKey: p.boxKey, startedAt: p.startedAt, found: 0, checked: 0, error: null };
    }

    default:
      return state;
  }
}

/** What to persist between reloads — only the identity/lifecycle, never counts. */
export function toPersisted(state: AreaScanState): PersistedScan | null {
  if (state.status === "idle") return null;
  return { status: state.status, jobId: state.jobId, boxKey: state.boxKey, startedAt: state.startedAt };
}

/** True when a HYDRATE resolved a persisted running scan to idle because it was
 *  stale — the caller should cancel that server job so it stops being resumed. */
export function persistedRunningIsStale(p: PersistedScan | null, now: number): p is PersistedScan {
  return !!p && p.status === "running" && (p.startedAt == null || now - p.startedAt >= STALE_RUNNING_MS);
}
