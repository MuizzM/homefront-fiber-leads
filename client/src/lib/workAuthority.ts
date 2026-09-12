import { withRequestDeadline } from "./requestDeadline";
/** Browser work ownership. A lease permits delivery only while its exact
 * authenticated owner/session remains active. Quarantine is never auth. */
export interface WorkOwner { userId: number; tenantId: number | null; teamMemberId: number | null }
export interface WorkLease { readonly owner: WorkOwner; readonly sessionId: string; readonly generation: number; readonly signal: AbortSignal }
export const WORK_QUARANTINE_KEY = "hfs.work.quarantine.v1";
export const WORK_PURGE_KEY = "hfs.work.purge.v1"; // random tombstone, contains no identity or work
const OWNER_KEY = "hfs.work.owner.v1";
type WorkEvent = "suspend" | "activate" | "purge" | "discard";
type Listener = (event: WorkEvent) => void;
const listeners = new Set<Listener>();
let active: WorkLease | null = null;
let suspendedOwner: WorkOwner | null = null;
export function lastWorkOwner(): WorkOwner | null { return active?.owner ?? suspendedOwner; }
let controller: AbortController | null = null;
let generation = 0;
let durableStamp = false;
let fallbackStamp: string | null = null;
let observedSession = false;
let purgeStamp: string | null = null;
export function wasWorkPurged(): boolean { return !!lastWorkOwner() && stored(WORK_PURGE_KEY) !== purgeStamp; }
let legacyOwner: WorkOwner | null = null;
let memoryQuarantine: WorkOwner | null = null;
let responseHandler: ((status: number | null) => void) | null = null;
export function setWorkResponseHandler(handler: (status: number | null) => void): void { responseHandler = handler; }

export function workOwner(user: { id: number; tenantId?: number | null; teamMemberId?: number | null }): WorkOwner {
  return { userId: user.id, tenantId: user.tenantId ?? null, teamMemberId: user.teamMemberId ?? null };
}
export function sameWorkOwner(a: WorkOwner | null | undefined, b: WorkOwner | null | undefined): boolean {
  return !!a && !!b && a.userId === b.userId && a.tenantId === b.tenantId && a.teamMemberId === b.teamMemberId;
}
export function workOwnerKey(owner: WorkOwner): string { return `${owner.userId}.${owner.tenantId ?? "none"}.${owner.teamMemberId ?? "none"}`; }
function validOwner(value: any): value is WorkOwner {
  return value && Number.isSafeInteger(value.userId) && value.userId > 0
    && (value.tenantId === null || Number.isSafeInteger(value.tenantId) && value.tenantId > 0)
    && (value.teamMemberId === null || Number.isSafeInteger(value.teamMemberId) && value.teamMemberId > 0);
}
function stored(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function remove(key: string): void { try { localStorage.removeItem(key); } catch { /* memory still invalidated */ } }
function publish(event: WorkEvent): void { for (const listener of [...listeners]) listener(event); }
export function subscribeWorkAuthority(listener: Listener): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function quarantinedWorkOwner(): WorkOwner | null { return memoryQuarantine ?? persistedQuarantineOwner(); }
export function persistedQuarantineOwner(): WorkOwner | null {
  try { const value = JSON.parse(stored(WORK_QUARANTINE_KEY) ?? "null"); return validOwner(value?.owner) ? value.owner : null; } catch { return null; }
}
export function persistedWorkOwner(): WorkOwner | null {
  try { const value = JSON.parse(stored(OWNER_KEY) ?? "null"); return validOwner(value?.owner) ? value.owner : null; } catch { return null; }
}
function quarantineLegacyOwner(): WorkOwner | null {
  try {
    const value = JSON.parse(stored(WORK_QUARANTINE_KEY) ?? "null");
    return validOwner(value?.owner) && value.legacy === true ? value.owner : null;
  } catch { return null; }
}
export function syncWorkQuarantineFromStorage(): void { memoryQuarantine = persistedQuarantineOwner(); }
export function hasWorkQuarantine(): boolean { return !!memoryQuarantine || stored(WORK_QUARANTINE_KEY) !== null; }

/** Snapshot evidence BEFORE writing the newly authenticated user. Only that
 * matching identity may adopt the previous release's untagged envelopes. */
function readLegacyOwner(): WorkOwner | null {
  try {
    const user = JSON.parse(stored("hfs.user") ?? "null");
    const owner = user ? workOwner(user) : null;
    return validOwner(owner) && stored("hfs.sid") ? owner : null;
  } catch { return null; }
}
export function canAdoptLegacyWork(owner: WorkOwner): boolean { return sameWorkOwner(owner, legacyOwner); }

export function suspendWork(): void {
  controller?.abort(); controller = null; active = null; generation++;
  publish("suspend");
}
export function activateWork(owner: WorkOwner, sessionId: string): WorkLease {
  if (!validOwner(owner) || !sessionId) throw new Error("Invalid work authority");
  if (active && sameWorkOwner(active.owner, owner) && active.sessionId === sessionId && isCurrentWorkLease(active)) return active;
  const prior = lastWorkOwner() ?? quarantinedWorkOwner();
  legacyOwner = readLegacyOwner() ?? quarantineLegacyOwner() ?? (sameWorkOwner(legacyOwner, owner) ? legacyOwner : null);
  if (prior && !sameWorkOwner(prior, owner)) purgeWork();
  else suspendWork();
  suspendedOwner = { ...owner };
  controller = new AbortController();
  active = Object.freeze({ owner: Object.freeze({ ...owner }), sessionId, generation, signal: controller.signal });
  memoryQuarantine = null;
  remove(WORK_QUARANTINE_KEY);
  purgeStamp = stored(WORK_PURGE_KEY);
  durableStamp = false; fallbackStamp = null; observedSession = stored("hfs.sid") === sessionId;
  try { localStorage.setItem(OWNER_KEY, JSON.stringify({ owner, sessionId })); durableStamp = true; }
  catch {
    // A quota failure may leave this owner's old stamp readable. Keep it as
    // a fence only while the independently persisted SID is the new session.
    try { const raw = localStorage.getItem(OWNER_KEY); if (raw && sameWorkOwner(JSON.parse(raw).owner, owner)) fallbackStamp = raw; } catch { /* memory-only */ }
  }
  publish("activate");
  return active;
}
export function quarantineWork(owner: WorkOwner, reason: string): void {
  legacyOwner = readLegacyOwner() ?? legacyOwner;
  suspendWork(); suspendedOwner = { ...owner }; memoryQuarantine = { ...owner };
  try { localStorage.setItem(WORK_QUARANTINE_KEY, JSON.stringify({ owner, reason, legacy: sameWorkOwner(legacyOwner, owner), at: Date.now() })); } catch { /* live resources remain suspended */ }
}
export function purgeWork(): void {
  try { localStorage.setItem(WORK_PURGE_KEY, crypto.randomUUID()); } catch { /* memory-only */ }
  suspendWork(); publish("purge"); legacyOwner = null; memoryQuarantine = null; suspendedOwner = null;
  remove(WORK_QUARANTINE_KEY); remove(OWNER_KEY);
}
/** Another tab owns storage now. Retire local resources without removing that
 * tab's persisted queues, session or quarantine marker. */
export function retireWorkLocally(): void {
  suspendWork(); publish("discard"); legacyOwner = null; memoryQuarantine = null; suspendedOwner = null;
}
export function currentWorkLease(owner?: WorkOwner): WorkLease | null {
  return active && (!owner || sameWorkOwner(active.owner, owner)) && isCurrentWorkLease(active) ? active : null;
}
export function isCurrentWorkLease(lease: WorkLease | null | undefined): lease is WorkLease {
  if (!lease || lease !== active || lease.signal.aborted) return false;
  // Storage events arrive asynchronously. Check the stamp before each send as
  // well, so an older tab cannot race delivery into a newly signed-in account.
  try {
    if (localStorage.getItem(WORK_PURGE_KEY) !== purgeStamp) return false;
    const stamp = localStorage.getItem(OWNER_KEY);
    const sid = localStorage.getItem("hfs.sid");
    if (sid === lease.sessionId) observedSession = true;
    if (observedSession && sid !== lease.sessionId) return false;
    if (!stamp && (durableStamp || fallbackStamp)) return false;
    if (stamp) {
      const value = JSON.parse(stamp);
      if (!sameWorkOwner(value.owner, lease.owner)) return false;
      if (value.sessionId !== lease.sessionId && (stamp !== fallbackStamp || sid !== lease.sessionId)) return false;
    }
    if (localStorage.getItem(WORK_QUARANTINE_KEY)) return false;
  } catch { if (durableStamp || fallbackStamp || observedSession) return false; /* storage blocked from the start uses memory */ }
  return true;
}

/** Narrow transport: capture one session and abort signal at dispatch; never
 * read queryClient's mutable session after a queue crosses an await. */
export async function workRequest(lease: WorkLease | null, method: string, url: string, body?: unknown): Promise<Response> {
  if (!isCurrentWorkLease(lease)) throw new Error("Work is suspended until sign-in completes");
  const base = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";
  return withRequestDeadline(async signal => {
    if (!isCurrentWorkLease(lease)) throw new Error("Work is suspended until sign-in completes");
    let response: Response;
    try { response = await fetch(`${base}${url}`, { method, signal,
      headers: { "Content-Type": "application/json", "x-session-id": lease.sessionId, "x-csrf-token": lease.sessionId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } finally { if (isCurrentWorkLease(lease) && method !== "GET") responseHandler?.(null); }
    if (!isCurrentWorkLease(lease)) throw new Error("Work is suspended until sign-in completes");
    responseHandler?.(response.status);
    // Buffer the small JSON API response while the same deadline and lease
    // abort still own the fetch. Returning headers alone detaches that guard.
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    const abortBody = () => { void reader?.cancel().catch(() => {}); };
    signal.addEventListener("abort", abortBody, { once: true });
    if (reader) {
      try {
        for (;;) {
          const part = await reader.read();
          if (!isCurrentWorkLease(lease)) throw new Error("Work is suspended until sign-in completes");
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1_048_576) throw new Error("Work response exceeds its size limit");
          chunks.push(part.value);
        }
      } catch (error) { void reader.cancel().catch(() => {}); throw error; }
      finally { signal.removeEventListener("abort", abortBody); reader.releaseLock(); }
    }
    signal.removeEventListener("abort", abortBody);
    if (signal.aborted || !isCurrentWorkLease(lease)) throw new Error("Work is suspended until sign-in completes");
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new Response([204, 205, 304].includes(response.status) ? null : bytes,
      { status: response.status, statusText: response.statusText, headers: response.headers });
  }, 30_000, lease.signal);
}
export async function workJson(lease: WorkLease | null, method: string, url: string, body: unknown): Promise<any> {
  const response = await workRequest(lease, method, url, body);
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  const result = await response.json();
  if (!isCurrentWorkLease(lease)) throw new Error("Work is suspended until sign-in completes");
  return result;
}
