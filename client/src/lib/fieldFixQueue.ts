import { ownedWorkStore } from "./ownedWorkStore";
import { isCurrentWorkLease, type WorkLease } from "./workAuthority";
export interface QueuedFix { lat: number; lng: number; accuracyM: number | null; capturedAt: string; id?: string }
const store = ownedWorkStore<QueuedFix[]>("hfs.fieldTracking.v2.", () => [], "hfs.fieldTracking.queue");
const running = new WeakSet<WorkLease>();
const retryAt = new WeakMap<WorkLease, number>();
function readFixes(lease: WorkLease): QueuedFix[] {
  const raw: unknown = store.read(lease);
  if (!Array.isArray(raw)) return [];
  return raw.filter((fix): fix is QueuedFix => !!fix && Number.isFinite(fix.lat) && Math.abs(fix.lat) <= 90
    && Number.isFinite(fix.lng) && Math.abs(fix.lng) <= 180
    && (fix.accuracyM === null || Number.isFinite(fix.accuracyM) && fix.accuracyM >= 0)
    && typeof fix.capturedAt === "string" && Number.isFinite(Date.parse(fix.capturedAt)))
    .slice(-200).map(fix => ({ lat: fix.lat, lng: fix.lng, accuracyM: fix.accuracyM, capturedAt: fix.capturedAt,
      ...(typeof fix.id === "string" ? { id: fix.id } : {}) }));
}
export function queuedFieldFixes(lease: WorkLease | null): number { return lease ? readFixes(lease).length : 0; }
export function appendFieldFix(lease: WorkLease, fix: QueuedFix): void {
  if (!isCurrentWorkLease(lease)) return;
  store.write(lease, [...readFixes(lease), { ...fix, id: crypto.randomUUID() }].slice(-200));
}
/** The backlog remains durable until each acknowledgement. A stopped or failed
 * delivery leaves every later fix intact, including across lease replacement. */
export async function flushFieldFixes(lease: WorkLease, deliver: (fix: QueuedFix) => Promise<{ stop?: boolean; retryAfterMs?: number }>): Promise<{ retryAfterMs?: number }> {
  if (!isCurrentWorkLease(lease) || running.has(lease)) return {};
  const delay = (retryAt.get(lease) ?? 0) - Date.now();
  if (delay > 0) return { retryAfterMs: delay };
  running.add(lease);
  try {
    while (isCurrentWorkLease(lease)) {
      const entries = readFixes(lease).map(fix => fix.id ? fix : { ...fix, id: crypto.randomUUID() })
        .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
      if (!entries.length) break;
      store.write(lease, entries);
      const first = entries[0];
      let result: { stop?: boolean; retryAfterMs?: number };
      try { result = await deliver(first); } catch { break; }
      if (!isCurrentWorkLease(lease)) break;
      if (result.retryAfterMs) { retryAt.set(lease, Date.now() + result.retryAfterMs); return { retryAfterMs: result.retryAfterMs }; }
      store.write(lease, readFixes(lease).filter(fix => fix.id !== first.id));
      if (result.stop) break;
    }
    return {};
  } finally { running.delete(lease); }
}
