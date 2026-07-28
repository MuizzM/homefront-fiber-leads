import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { setSessionId as syncSessionToQueryClient, setUnauthorizedHandler, clearPersistedQueryCache, queryClient } from "@/lib/queryClient";
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

// Session persistence: localStorage is the PRIMARY store — it survives a hard
// refresh AND a home-screen PWA relaunch (window.name alone does NOT: iOS gives a
// standalone web app a fresh browsing context on relaunch, wiping window.name, so
// the user got logged out on every refresh). window.name stays as a fallback for
// sandboxed-iframe contexts where storage is blocked.
const SID_KEY = "hfs.sid";
function readPersistedSession(): string | null {
  try {
    const ls = window.localStorage?.getItem(SID_KEY);
    if (typeof ls === "string" && ls) return ls;
  } catch { /* storage blocked — fall through */ }
  try {
    const data = JSON.parse(window.name || "{}");
    return typeof data.sid === "string" && data.sid ? data.sid : null;
  } catch { /* ignore */ }
  return null;
}
function writePersistedSession(sid: string | null) {
  try {
    if (sid) window.localStorage?.setItem(SID_KEY, sid);
    else window.localStorage?.removeItem(SID_KEY);
  } catch { /* storage blocked */ }
  try { window.name = JSON.stringify(sid ? { sid } : {}); } catch { /* ignore */ }
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
        setSid(null);
        syncSessionToQueryClient(null);
        setUser(null);
        toast(revoked
          ? { title: "Access removed", description: "Your account was deactivated by your team. Contact your manager if this is unexpected." }
          : { title: "Session expired", description: "Please sign back in — anything you logged is saved and will sync." });
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
          (window as any).__sessionId = existingSid; // expose for browser scanner
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
          (window as any).__sessionId = existingSid;
          window.addEventListener("online", () => void checkStatus(existingSid), { once: true });
        }
      }
    }
    setLoading(false);
  }

  function login(newSid: string, u: AuthUser) {
    // P1-11: a NEW identity is arriving — evict everything the previous
    // identity cached before the new session hydrates (user switch in one tab).
    try { queryClient.clear(); clearPersistedQueryCache(); } catch { /* */ }
    _memSession = newSid;
    writePersistedSession(newSid); // persist across page reloads via window.name
    setSid(newSid);
    syncSessionToQueryClient(newSid);
    (window as any).__sessionId = newSid; // expose for browser scanner native fetch calls
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
