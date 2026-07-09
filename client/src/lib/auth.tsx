import { createContext, useContext, useState, useEffect, ReactNode } from "react";
import { setSessionId as syncSessionToQueryClient } from "@/lib/queryClient";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  // Full server role set (shared/schema.ts users.role) — was "admin" | "rep",
  // which made manager/team_lead comparisons type-lies across the app.
  role: "super_admin" | "admin" | "manager" | "team_lead" | "rep";
  teamMemberId?: number | null;
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

// Session persistence: window.name survives page reload on same tab,
// works in sandboxed iframes where localStorage/sessionStorage are blocked.
function readPersistedSession(): string | null {
  try {
    const data = JSON.parse(window.name || "{}");
    return typeof data.sid === "string" && data.sid ? data.sid : null;
  } catch { return null; }
}
function writePersistedSession(sid: string | null) {
  try {
    const data = sid ? { sid } : {};
    window.name = JSON.stringify(data);
  } catch {}
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
