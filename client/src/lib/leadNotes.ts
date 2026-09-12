import { currentWorkLease, isCurrentWorkLease, type WorkLease } from "./workAuthority";
import { ownedWorkStore } from "./ownedWorkStore";
// ── Lead-note persistence — local-first, offline-safe, conflict-aware ─────────
// The card owns typing (optimistic local state, debounced commits); this module
// owns getting a committed note to the server without ever losing it:
//   saved   → PATCH landed; server returned the new lead version (updatedAt)
//   conflict→ another device saved a different note since we loaded (409);
//             caller merges and re-commits with the fresh base version
//   queued  → network down; note stashed durably and flushed on 'online'
// Storage mirrors the knock queue's proven layer (localStorage with in-memory
// fallback for sandboxed iframes) — same failure envelope, same test story.

export type NoteSaveResult =
  | { status: "saved"; updatedAt: string | null }
  | { status: "conflict"; serverNotes: string; updatedAt: string | null }
  | { status: "rejected"; reason: string }
  | { status: "queued" };

export type NotePoster = (leadId: number, body: { notes: string; baseUpdatedAt: string | null }) =>
  Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

interface PendingNote { notes: string; baseUpdatedAt: string | null; at: number; revision: string }
const store = ownedWorkStore<Record<string, PendingNote>>("hf.pendingNotes.v2.", () => ({}), "hf.pendingNotes.v1");
const suspendedResult = (): NoteSaveResult => ({ status: "rejected", reason: "Sign in to continue saving notes." });

export function stashNote(leadId: number, notes: string, baseUpdatedAt: string | null, lease = currentWorkLease()): void {
  if (!isCurrentWorkLease(lease)) return;
  const stash = store.read(lease);
  stash[String(leadId)] = { notes, baseUpdatedAt, at: Date.now(), revision: crypto.randomUUID() };
  store.write(lease, stash);
}
export function pendingNoteCount(): number {
  const lease = currentWorkLease();
  return lease ? Object.keys(store.read(lease)).length : 0;
}
function removeVersion(lease: WorkLease, leadId: number, revision: string): void {
  if (!isCurrentWorkLease(lease)) return;
  const stash = store.read(lease);
  if (stash[String(leadId)]?.revision === revision) { delete stash[String(leadId)]; store.write(lease, stash); }
}

// Persist before dispatch: an uncertain request retains this version through
// same-owner reauth. A late response cannot clear a newer edit or another owner.
export async function saveLeadNote(
  post: NotePoster, leadId: number, notes: string, baseUpdatedAt: string | null, lease = currentWorkLease(),
): Promise<NoteSaveResult> {
  if (!isCurrentWorkLease(lease)) return suspendedResult();
  stashNote(leadId, notes, baseUpdatedAt, lease);
  const revision = store.read(lease)[String(leadId)].revision;
  try {
    const res = await post(leadId, { notes, baseUpdatedAt });
    if (!isCurrentWorkLease(lease)) return suspendedResult();
    if (res.status === 409) {
      const body = await res.json();
      if (!isCurrentWorkLease(lease)) return suspendedResult();
      removeVersion(lease, leadId, revision);
      return { status: "conflict", serverNotes: String(body?.serverNotes ?? ""), updatedAt: body?.updatedAt ?? null };
    }
    if (res.status === 400 || res.status === 403 || res.status === 404) {
      const body = await res.json().catch(() => ({}));
      if (!isCurrentWorkLease(lease)) return suspendedResult();
      removeVersion(lease, leadId, revision);
      return { status: "rejected", reason: String((body as any)?.error ?? `HTTP ${res.status}`) };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!isCurrentWorkLease(lease)) return suspendedResult();
    removeVersion(lease, leadId, revision);
    return { status: "saved", updatedAt: body?.updatedAt ?? null };
  } catch {
    return isCurrentWorkLease(lease) ? { status: "queued" } : suspendedResult();
  }
}

export async function flushPendingNotes(post: NotePoster, lease = currentWorkLease()): Promise<number> {
  if (!isCurrentWorkLease(lease)) return 0;
  const stash = store.read(lease);
  let flushed = 0;
  for (const [id, p] of Object.entries(stash)) {
    if (!isCurrentWorkLease(lease)) break;
    try {
      const res = await post(Number(id), { notes: p.notes, baseUpdatedAt: p.baseUpdatedAt });
      if (!isCurrentWorkLease(lease)) break;
      if (res.ok || res.status === 409) { removeVersion(lease, Number(id), p.revision); flushed++; }
    } catch { if (!isCurrentWorkLease(lease)) break; }
  }
  return flushed;
}

// Two-device merge: keep the server text, append whatever local adds. If one
// contains the other, just take the longer one — no duplicated paragraphs.
export function mergeNotes(serverNotes: string, localNotes: string): string {
  const server = serverNotes.trim();
  const local = localNotes.trim();
  if (!server) return local;
  if (!local || server === local) return server;
  if (server.includes(local)) return server;
  if (local.includes(server)) return local;
  return `${server}\n${local}`;
}
