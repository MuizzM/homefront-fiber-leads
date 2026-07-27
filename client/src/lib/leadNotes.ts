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

interface PendingNote { notes: string; baseUpdatedAt: string | null; at: number }

const STASH_KEY = "hf.pendingNotes.v1";

let memStash: Record<string, PendingNote> | null = null; // storage-blocked fallback

function readStash(): Record<string, PendingNote> {
  if (memStash) return memStash;
  try {
    const raw = localStorage.getItem(STASH_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { memStash = memStash ?? {}; return memStash; }
}

function writeStash(stash: Record<string, PendingNote>): void {
  if (memStash) { memStash = stash; return; }
  try { localStorage.setItem(STASH_KEY, JSON.stringify(stash)); }
  catch { memStash = stash; }
}

export function stashNote(leadId: number, notes: string, baseUpdatedAt: string | null): void {
  const stash = readStash();
  stash[String(leadId)] = { notes, baseUpdatedAt, at: Date.now() }; // last write per lead wins
  writeStash(stash);
}

export function pendingNoteCount(): number {
  return Object.keys(readStash()).length;
}

// One commit attempt. Network failure → durable stash (never lose the note).
export async function saveLeadNote(
  post: NotePoster, leadId: number, notes: string, baseUpdatedAt: string | null,
): Promise<NoteSaveResult> {
  try {
    const res = await post(leadId, { notes, baseUpdatedAt });
    if (res.status === 409) {
      const body = await res.json();
      return { status: "conflict", serverNotes: String(body?.serverNotes ?? ""), updatedAt: body?.updatedAt ?? null };
    }
    // HONESTY FIX: a definitive server rejection (400/403/404 — too-long note,
    // deleted lead, capability denial) is NOT an offline queue event. Stashing
    // it retries forever invisibly; tell the truth instead.
    if (res.status === 400 || res.status === 403 || res.status === 404) {
      const body = await res.json().catch(() => ({}));
      return { status: "rejected", reason: String((body as any)?.error ?? `HTTP ${res.status}`) };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    // Landed — clear any stale stash entry for this lead.
    const stash = readStash();
    if (stash[String(leadId)]) { delete stash[String(leadId)]; writeStash(stash); }
    return { status: "saved", updatedAt: body?.updatedAt ?? null };
  } catch {
    stashNote(leadId, notes, baseUpdatedAt);
    return { status: "queued" };
  }
}

// Flush everything stashed (called on 'online' and app load). Conflicts during
// flush resolve server-wins — the rep isn't looking at that card anymore, and
// the server copy is by definition the newer intentional write.
export async function flushPendingNotes(post: NotePoster): Promise<number> {
  const stash = readStash();
  const ids = Object.keys(stash);
  let flushed = 0;
  for (const id of ids) {
    const p = stash[id];
    try {
      const res = await post(Number(id), { notes: p.notes, baseUpdatedAt: p.baseUpdatedAt });
      if (res.ok || res.status === 409) {
        const cur = readStash();
        delete cur[id];
        writeStash(cur);
        flushed++;
      }
    } catch { /* still offline — keep it stashed */ }
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
