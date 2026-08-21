import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { setSessionId as syncSessionToQueryClient, setUnauthorizedHandler, clearPersistedQueryCache, purgeSessionScopedKeys, queryClient } from "@/lib/queryClient";
import { clearPdfBlobCache } from "@/lib/pdfBlobCache";
import { toast } from "@/hooks/use-toast";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  // Full server role set (shared/schema.ts users.role) — was "admin" | "rep",
  // which made manager/team_lead comparisons type-lies across the app.
  role:
    | "super_admin" | "admin" | "manager" | "team_lead" | "rep"
    | "calling_rep" | "calling_manager" | "compliance_admin" | "auditor";
  teamMemberId?: number | null;
  tenantId?: number | null; // the user's organization (tenants.id)
  // Platform-owner identity, straight from the immutable is_super_admin column.
  // Gating Central Admin on THIS (rather than matching the email against a
  // separately-fetched allowlist) is what keeps the console from disappearing
  // on refresh: it arrives with the session, in the same payload as the role.
  isSuperAdmin?: boolean;
  // Whether GUARDED_ACTIONS_ENABLED is set server-side. Same delivery choice
  // as isSuperAdmin: it arrives with the session, so Layout can decide whether
  // to run the pending-count poll at all instead of discovering a flag-off
  // environment through a 404 every minute (an error the browser logs to the
  // console unsuppressably). Absent on payloads from older servers, which
  // reads as false - the poll simply stays off until the next hydration.
  guardedActionsEnabled?: boolean;
}

interface AuthCtx {
  user: AuthUser | null;
  sessionId: string | null;
  isFirstRun: boolean;
  loading: boolean;
  login: (sessionId: string, user: AuthUser) => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>({
  user: null, sessionId: null, isFirstRun: false, loading: true,
  login: () => {}, logout: async () => {},
});

// Session persistence: localStorage with an EXPLICIT client-side deadline.
//
// This used to be sessionStorage-only (SEC-B), which killed the token when the
// tab closed. That threw away the server's own design: sessions renew on a
// sliding window (storage.touchSession) and are only capped by an absolute
// ceiling from login, precisely so an app in daily use never expires under a
// rep mid-shift. A field rep on a phone does not "close the app" - iOS evicts
// backgrounded tabs and standalone PWAs from memory routinely, and every one of
// those evictions was a forced re-login against a session the server still
// considered perfectly valid.
//
// The original worry was real though, so it is answered rather than dropped:
// what made localStorage risky was a token sitting there INDEFINITELY on a
// shared device. So the token is stored with a deadline, the deadline is
// refreshed while the app is in use (mirroring the server's sliding renewal),
// and a token past its deadline is deleted on read and never sent. Logout
// still clears it outright. The lifetime is bounded on both sides now instead
// of being unbounded on the server and one tab-close on the client.
const SID_KEY = "hfs.sid";
const SID_DEADLINE_KEY = "hfs.sid.until";
// Kept a little under the server's 7-day default TTL so the client gives up
// first and shows a clean sign-in rather than firing a request it knows is
// dead. SESSION_TTL_HOURS can lengthen the server side; this floor stays safe
// because every authenticated request pushes the real deadline out again.
const CLIENT_SESSION_MS = 6 * 24 * 60 * 60 * 1000;

function readPersistedSession(): string | null {
  try {
    const sid = window.localStorage?.getItem(SID_KEY);
    if (typeof sid !== "string" || !sid) {
      // A session minted by an older build lived in sessionStorage. Adopt it
      // once so upgrading does not sign everyone out.
      const legacy = window.sessionStorage?.getItem(SID_KEY);
      if (typeof legacy === "string" && legacy) {
        writePersistedSession(legacy);
        try { window.sessionStorage?.removeItem(SID_KEY); } catch { /* ignore */ }
        return legacy;
      }
      return null;
    }
    const until = Number(window.localStorage?.getItem(SID_DEADLINE_KEY) ?? 0);
    if (Number.isFinite(until) && until > 0 && Date.now() > until) {
      writePersistedSession(null);
      return null;
    }
    return sid;
  } catch { /* storage blocked */ }
  return null;
}

function writePersistedSession(sid: string | null) {
  try {
    if (sid) {
      window.localStorage?.setItem(SID_KEY, sid);
      window.localStorage?.setItem(SID_DEADLINE_KEY, String(Date.now() + CLIENT_SESSION_MS));
    } else {
      window.localStorage?.removeItem(SID_KEY);
      window.localStorage?.removeItem(SID_DEADLINE_KEY);
      window.sessionStorage?.removeItem(SID_KEY);
    }
  } catch { /* storage blocked */ }
}

/** Push the client deadline out while the app is in use, mirroring the
 *  server's sliding renewal. Cheap: two localStorage writes, no network. */
function touchPersistedSession() {
  try {
    if (window.localStorage?.getItem(SID_KEY)) {
      window.localStorage?.setItem(SID_DEADLINE_KEY, String(Date.now() + CLIENT_SESSION_MS));
    }
  } catch { /* storage blocked */ }
}

// Last-known user snapshot — the offline cold-launch grace. A rep opening the
// PWA in a dead zone used to hit an unpassable login wall (status check network-
// errors, user stays null) even though the session + shell + pins were cached.
// The snapshot only ever hydrates alongside a persisted session id on a NETWORK
// failure — a real 401 still logs out and clears it.
const USER_KEY = "hfs.user";
function readPersistedUser(): AuthUser | null {
  try {
    const raw = window.localStorage?.getItem(USER_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw);
    return u && typeof u === "object" && typeof u.id === "number" && typeof u.role === "string" ? (u as AuthUser) : null;
  } catch { return null; }
}
function writePersistedUser(u: AuthUser | null) {
  try {
    if (u) window.localStorage?.setItem(USER_KEY, JSON.stringify(u));
    else window.localStorage?.removeItem(USER_KEY);
  } catch { /* storage blocked */ }
}

let _memSession: string | null = readPersistedSession();
export function getSessionId() { return _memSession; }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [sid, setSid] = useState<string | null>(null);
  const [isFirstRun, setIsFirstRun] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkStatus(_memSession);
  }, []);

  // Keep the client deadline moving while the app is actually being used, so a
  // rep who opens it daily is never signed out - the mirror of the server's
  // sliding renewal. Refreshed on mount, whenever the tab comes back to the
  // foreground, and hourly; all three are local writes, never a request.
  useEffect(() => {
    if (!sid) return;
    touchPersistedSession();
    const onVisible = () => { if (document.visibilityState === "visible") touchPersistedSession(); };
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(touchPersistedSession, 60 * 60 * 1000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }, [sid]);

  // Global session-expiry recovery. A 401 is NOT by itself proof the session
  // died: a deploy restart mid-request, a momentary DB lock, a proxy hiccup, or
  // one endpoint rejecting for its own reason all surface as a single 401 — and
  // hard-clearing on any of them is what bounced reps to Login mid-shift, often
  // several times a day. So CONFIRM against /api/auth/status (the one endpoint
  // whose whole job is answering "is this session real?") and sign out only when
  // the server actually disowns it. A network failure keeps the rep signed in —
  // the offline path already handles that. Queued knocks are never lost either
  // way; they resync after sign-in.
  useEffect(() => {
    let confirming: Promise<void> | null = null; // single-flight: a burst of 401s asks once
    setUnauthorizedHandler(() => {
      if (!_memSession || confirming) return;
      const suspect = _memSession;
      let revoked = false;
      confirming = (async () => {
        try {
          const res = await fetch(`${API_BASE}/api/auth/status`, { headers: { "x-session-id": suspect } });
          const data = await res.json();
          if (data.currentUser) {
            // Session is alive — the 401 was transient. Stay signed in and let
            // the failed call retry on its own; refresh the offline snapshot.
            writePersistedUser(data.currentUser);
            setUser(data.currentUser);
            return;
          }
          // Removed from the team (offboarded / login deactivated) rather than
          // simply timed out. Say so, so a rep who was kicked mid-shift isn't
          // left retyping a code that will never work.
          revoked = Boolean(data.accessRevoked);
        } catch {
          return; // couldn't reach the server — assume the session is fine
        }
        if (_memSession !== suspect) return; // re-logged-in while we were asking
        _memSession = null;
        writePersistedSession(null);
        writePersistedUser(null); // a confirmed 401 ends offline grace too
        // P1-11 (K3 swarm): identity changed — purge ALL query state. Previously
        // only the disk snapshot was dropped on manual logout; the whole in-memory
        // cache (leads, team, stats) survived into the next login on the same
        // device, and the 401 path cleared nothing at all.
        try { queryClient.clear(); } catch { /* */ }
        clearPersistedQueryCache();
        purgeSessionScopedKeys(); // SEC-B: pin snapshots, pending notes, knock queue
        clearPdfBlobCache(); // agreement PDFs are identity-scoped too
        setSid(null);
        syncSessionToQueryClient(null);
        setUser(null);
        toast(revoked
          ? { title: "Access removed", description: "Your account was deactivated by your team. Contact your manager if this is unexpected." }
          : { title: "Session expired", description: "Please sign back in - anything you logged is saved and will sync." });
      })().finally(() => { confirming = null; });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  async function checkStatus(existingSid: string | null) {
    try {
      const res = await fetch(`${API_BASE}/api/auth/status`, {
        headers: existingSid ? { "x-session-id": existingSid } : {},
      });
      const data = await res.json();
      setIsFirstRun(data.isFirstRun);
      if (data.currentUser) {
        setUser(data.currentUser);
        writePersistedUser(data.currentUser); // refresh the offline-grace snapshot
        if (existingSid) {
          setSid(existingSid);
          syncSessionToQueryClient(existingSid);
        }
      }
    } catch {
      // NETWORK failure (dead zone / offline PWA launch) — not an auth rejection
      // (a rejected session resolves with no currentUser instead). Hydrate the
      // last-known user so the cached shell, pins and knock queue stay usable,
      // and re-verify the moment connectivity returns. A true expiry surfaces
      // as a 401 on the first real API call and logs out via the global handler.
      if (existingSid) {
        const snapshot = readPersistedUser();
        if (snapshot) {
          setUser(snapshot);
          setSid(existingSid);
          syncSessionToQueryClient(existingSid);
          window.addEventListener("online", () => void checkStatus(existingSid), { once: true });
        }
      }
    }
    setLoading(false);
  }

  function login(newSid: string, u: AuthUser) {
    // P1-11: a NEW identity is arriving — evict everything the previous
    // identity cached before the new session hydrates (user switch in one tab).
    try { queryClient.clear(); clearPersistedQueryCache(); purgeSessionScopedKeys(); clearPdfBlobCache(); } catch { /* */ }
    _memSession = newSid;
    writePersistedSession(newSid); // persist across page reloads (sessionStorage)
    setSid(newSid);
    syncSessionToQueryClient(newSid);
    setUser(u);
    writePersistedUser(u); // offline-grace snapshot
    setIsFirstRun(false);
  }

  async function logout() {
    if (sid) {
      try {
        await fetch(`${API_BASE}/api/auth/logout`, {
          method: "POST",
          headers: { "x-session-id": sid },
        });
      } catch {}
    }
    _memSession = null;
    writePersistedSession(null); // clear persisted session
    writePersistedUser(null); // clear the offline-grace snapshot
    try { queryClient.clear(); } catch { /* */ }
    clearPersistedQueryCache(); // drop the on-disk dashboard SWR snapshot
    purgeSessionScopedKeys(); // SEC-B: pin snapshots, pending notes, knock queue
    clearPdfBlobCache(); // agreement PDFs are identity-scoped too
    setSid(null);
    syncSessionToQueryClient(null);
    setUser(null);
  }

  return (
    <Ctx.Provider value={{ user, sessionId: sid, isFirstRun, loading, login, logout }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() { return useContext(Ctx); }
