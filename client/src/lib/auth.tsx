import { activateWork, lastWorkOwner, wasWorkPurged, hasWorkQuarantine, persistedWorkOwner, persistedQuarantineOwner, syncWorkQuarantineFromStorage, purgeWork, quarantinedWorkOwner, quarantineWork, retireWorkLocally,
  sameWorkOwner, suspendWork, workOwner, type WorkOwner } from "./workAuthority";
import { createContext, useContext, useState, useEffect, useRef, ReactNode } from "react";
import { setSessionId as syncSessionToQueryClient, setUnauthorizedHandler, clearPersistedQueryCache, purgeSessionScopedKeys, queryClient, bustInflightGetShare, invalidateRequestScope } from "@/lib/queryClient";
import { clearPdfBlobCache } from "@/lib/pdfBlobCache";
import { toast } from "@/hooks/use-toast";
import { withRequestDeadline } from "@/lib/requestDeadline";

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
  statusError?: string | null;
  retryStatus?: () => void;
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
let sessionStorageUnavailable = false;
const CLIENT_SESSION_MS = 6 * 24 * 60 * 60 * 1000;

function readPersistedSession(): string | null {
  if (hasWorkQuarantine()) return null;
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
    if (sid) window.localStorage?.setItem(SID_KEY, sid);
    else window.localStorage?.removeItem(SID_KEY);
    sessionStorageUnavailable = false;
  } catch { sessionStorageUnavailable = true; }
  // A deadline quota error must never disable cross-tab token comparisons.
  try {
    if (sid) window.localStorage?.setItem(SID_DEADLINE_KEY, String(Date.now() + CLIENT_SESSION_MS));
    else { window.localStorage?.removeItem(SID_DEADLINE_KEY); window.sessionStorage?.removeItem(SID_KEY); }
  } catch { /* token durability is tracked separately above */ }
}

type SessionFence = { sid: string | null; owner: string | null; quarantine: string | null; purge: string | null } | null;
function readSessionFence(): SessionFence {
  try { return { sid: localStorage.getItem(SID_KEY), owner: localStorage.getItem("hfs.work.owner.v1"),
    quarantine: localStorage.getItem("hfs.work.quarantine.v1"), purge: localStorage.getItem("hfs.work.purge.v1") }; } catch { return null; }
}
function ownsPersistedSession(expected: string, captured: SessionFence): boolean {
  const current = readSessionFence();
  if (hasWorkQuarantine()) return false;
  if (!captured || !current) return !captured && !current && sessionStorageUnavailable;
  if (current.sid !== captured.sid || current.owner !== captured.owner || current.quarantine !== captured.quarantine || current.purge !== captured.purge) return false;
  // A stable old same-owner stamp may remain after a quota failure. The fresh
  // server status, captured SID and unchanged storage together establish who
  // may recover; no already-active lease is needed on reload or in a peer tab.
  return current.sid === expected || (current.sid === null && sessionStorageUnavailable);
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
function readPersistedUser(sessionId: string): AuthUser | null {
  if (hasWorkQuarantine()) return null;
  try {
    if (window.localStorage?.getItem(SID_KEY) !== sessionId) return null;
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

interface AuthStatus {
  isFirstRun: boolean;
  currentUser: AuthUser | null;
  accessRevoked?: boolean;
  disposition?: "reauth" | "revoked";
  reason?: string;
  owner?: WorkOwner;
}

async function fetchAuthStatus(sessionId: string, signal?: AbortSignal): Promise<AuthStatus> {
  return withRequestDeadline(async requestSignal => {
    const res = await fetch(`${API_BASE}/api/auth/status`, {
      headers: { "x-session-id": sessionId }, signal: requestSignal,
    });
    // Only the status endpoint's successful, complete answer may disown a
    // session. A proxy/DB error (even JSON) is not an authentication decision.
    if (!res.ok) throw new Error("Unable to check your session. Please try again.");
    const data: AuthStatus = await res.json();
    if (!data || typeof data.isFirstRun !== "boolean"
      || !(data.currentUser === null || (typeof data.currentUser?.id === "number" && typeof data.currentUser?.role === "string"))) {
      throw new Error("Unable to check your session. Please try again.");
    }
    return data;
  }, 8_000, signal);
}

let _memSession: string | null = readPersistedSession();

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [sid, setSid] = useState<string | null>(null);
  const [isFirstRun, setIsFirstRun] = useState(false);
  // Anonymous visitors can use Login immediately; it needs no status payload.
  const [loading, setLoading] = useState(Boolean(_memSession));
  const [statusError, setStatusError] = useState<string | null>(null);
  const statusRequest = useRef<AbortController | null>(null);
  const statusVersion = useRef(0);
  const [initialIdentity] = useState(() => _memSession
    ? { sid: _memSession, user: readPersistedUser(_memSession) } : null);
  const identity = useRef(initialIdentity);

  useEffect(() => {
    if (_memSession) void checkStatus(_memSession);
    return () => statusRequest.current?.abort();
  }, []);

  useEffect(() => {
    if (!sid) return;
    touchPersistedSession();
    const onVisible = () => { if (document.visibilityState === "visible") touchPersistedSession(); };
    // Always recheck the CURRENT identity after reconnection. A one-off listener
    // holding an old session could previously resurrect it after account switch.
    const onOnline = () => { if (_memSession === sid) void checkStatus(sid); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    const timer = window.setInterval(touchPersistedSession, 60 * 60 * 1000);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
      window.clearInterval(timer);
    };
  }, [sid]);

  useEffect(() => {
    let confirming: Promise<void> | null = null;
    let disposed = false;
    setUnauthorizedHandler(() => {
      if (!_memSession || confirming) return;
      const suspect = _memSession;
      const fence = readSessionFence();
      const version = ++statusVersion.current;
      confirming = (async () => {
        let data: AuthStatus;
        try { data = await fetchAuthStatus(suspect); }
        catch { return; } // Offline, timeout and server errors do not revoke access.
        if (disposed || _memSession !== suspect || statusVersion.current !== version || !ownsPersistedSession(suspect, fence)) return;
        if (data.currentUser) {
          adoptUser(suspect, data.currentUser);
          return;
        }
        applyStatusDenial(data);
        toast(data.accessRevoked
          ? { title: "Access removed", description: "Your account was deactivated by your team. Contact your manager if this is unexpected.", variant: "destructive", duration: 30_000 }
          : { title: "Session expired", description: "Please sign back in to continue.", variant: "destructive", duration: 30_000 });
      })().finally(() => { confirming = null; });
    });
    return () => { disposed = true; setUnauthorizedHandler(null); };
  }, []);

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== null && !["hfs.sid", "hfs.work.owner.v1", "hfs.work.quarantine.v1", "hfs.work.purge.v1"].includes(event.key)) return;
      // Retire this tab without deleting the session/work written by its peer.
      const priorOwner = identity.current?.user ? workOwner(identity.current.user) : lastWorkOwner() ?? quarantinedWorkOwner();
      const peerOwner = persistedQuarantineOwner() ?? persistedWorkOwner();
      clearIdentity({ persist: false, preserveWork: !wasWorkPurged() && sameWorkOwner(priorOwner, peerOwner) });
      syncWorkQuarantineFromStorage();
      const nextSid = readPersistedSession();
      if (nextSid) {
        _memSession = nextSid;
        identity.current = { sid: nextSid, user: readPersistedUser(nextSid) };
        void checkStatus(nextSid);
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);

  function clearIdentity({ preserveWork = false, persist = true } = {}) {
    // This synchronous boundary precedes changing queryClient's shared token.
    if (!persist && !preserveWork) retireWorkLocally();
    else if (preserveWork) suspendWork();
    else purgeWork();
    statusVersion.current += 1;
    invalidateRequestScope();
    statusRequest.current?.abort();
    statusRequest.current = null;
    _memSession = null;
    identity.current = null;
    if (persist) { writePersistedSession(null); writePersistedUser(null); }
    try { bustInflightGetShare(); queryClient.clear(); } catch { /* storage recovery continues */ }
    if (persist) { clearPersistedQueryCache(); purgeSessionScopedKeys({ preservePendingWrites: preserveWork }); }
    clearPdfBlobCache();
    setSid(null);
    syncSessionToQueryClient(null);
    setUser(null);
    setLoading(false);
    setStatusError(null);
  }

  function applyStatusDenial(data: AuthStatus) {
    const prior = identity.current?.user;
    const recoverable = data.disposition === "reauth" && ["SESSION_EXPIRED", "MFA_REQUIRED"].includes(data.reason ?? "")
      && prior && sameWorkOwner(workOwner(prior), data.owner);
    if (recoverable && prior) quarantineWork(workOwner(prior), data.reason!);
    clearIdentity({ preserveWork: !!recoverable });
  }

  function adoptUser(sessionId: string, nextUser: AuthUser) {
    const prior = identity.current?.user;
    const reassigned = prior && (prior.id !== nextUser.id || prior.tenantId !== nextUser.tenantId
      || prior.teamMemberId !== nextUser.teamMemberId);
    if (prior && (reassigned || prior.role !== nextUser.role || !!prior.isSuperAdmin !== !!nextUser.isSuperAdmin)) {
      // Cached manager/tenant data is no longer authorized after a scope change.
      // Same-person role changes keep their pending field writes; reassignment
      // must never replay those writes under a different tenant or rep identity.
      if (reassigned) purgeWork(); else suspendWork();
      invalidateRequestScope();
      queryClient.clear();
      clearPersistedQueryCache();
      purgeSessionScopedKeys({ preservePendingWrites: !reassigned });
      clearPdfBlobCache();
    }
    activateWork(workOwner(nextUser), sessionId);
    identity.current = { sid: sessionId, user: nextUser };
    setLoading(false);
    setUser(nextUser);
    setSid(sessionId);
    syncSessionToQueryClient(sessionId);
    // Another tab may have signed in since this request began. Never overwrite
    // that tab's persisted user with a response belonging to our older session.
    try { if (window.localStorage?.getItem(SID_KEY) === sessionId) writePersistedUser(nextUser); }
    catch { /* current in-memory identity remains usable */ }
  }

  async function checkStatus(existingSid: string) {
    const version = ++statusVersion.current;
    const fence = readSessionFence();
    statusRequest.current?.abort();
    const controller = new AbortController();
    statusRequest.current = controller;
    setStatusError(null);
    setLoading(!user);
    const isCurrent = () => !controller.signal.aborted && _memSession === existingSid && statusVersion.current === version && ownsPersistedSession(existingSid, fence);
    try {
      const data = await fetchAuthStatus(existingSid, controller.signal);
      if (!isCurrent()) return;
      setIsFirstRun(data.isFirstRun);
      if (data.currentUser) {
        adoptUser(existingSid, data.currentUser);
      } else {
        applyStatusDenial(data);
      }
    } catch {
      if (!isCurrent()) return;
      const snapshot = identity.current?.sid === existingSid ? identity.current.user : readPersistedUser(existingSid);
      if (snapshot && !hasWorkQuarantine()) {
        activateWork(workOwner(snapshot), existingSid);
        // Existing offline grace: the server still authorizes every API action.
        setLoading(false);
        setUser(snapshot);
        setSid(existingSid);
        syncSessionToQueryClient(existingSid);
      } else {
        setStatusError("We couldn't check your session. Check your connection and try again.");
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  function login(newSid: string, u: AuthUser) {
    const preserveWork = sameWorkOwner(quarantinedWorkOwner(), workOwner(u));
    clearIdentity({ preserveWork });
    _memSession = newSid;
    writePersistedSession(newSid);
    activateWork(workOwner(u), newSid);
    setSid(newSid);
    syncSessionToQueryClient(newSid);
    setUser(u);
    identity.current = { sid: newSid, user: u };
    writePersistedUser(u);
    setIsFirstRun(false);
  }

  async function logout() {
    const previousSid = _memSession;
    clearIdentity(); // Signing out locally must not wait on a stalled connection.
    if (!previousSid) return;
    try {
      await withRequestDeadline(signal => fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST", signal,
        headers: { "x-session-id": previousSid, "x-csrf-token": previousSid },
      }), 8_000);
    } catch { /* Local identity and cached data are already cleared. */ }
  }

  return (
    <Ctx.Provider value={{ user, sessionId: sid, isFirstRun, loading, statusError,
      retryStatus: () => { if (_memSession) void checkStatus(_memSession); }, login, logout }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() { return useContext(Ctx); }
