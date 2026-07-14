import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { setSessionId as syncSessionToQueryClient, setUnauthorizedHandler } from "@/lib/queryClient";
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

  // Global session-expiry recovery: if any request 401s while we held a session,
  // clear it locally (the server already invalidated it) and route back to Login
  // with a clear message — instead of every screen silently erroring on stale
  // data. Queued knocks are NOT lost; they resync after sign-in.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (!_memSession) return;
      _memSession = null;
      writePersistedSession(null);
      setSid(null);
      syncSessionToQueryClient(null);
      setUser(null);
      toast({ title: "Session expired", description: "Please sign back in — anything you logged is saved and will sync." });
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
        if (existingSid) {
          setSid(existingSid);
          syncSessionToQueryClient(existingSid);
          (window as any).__sessionId = existingSid; // expose for browser scanner
        }
      }
    } catch {}
    setLoading(false);
  }

  function login(newSid: string, u: AuthUser) {
    _memSession = newSid;
    writePersistedSession(newSid); // persist across page reloads via window.name
    setSid(newSid);
    syncSessionToQueryClient(newSid);
    (window as any).__sessionId = newSid; // expose for browser scanner native fetch calls
    setUser(u);
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
