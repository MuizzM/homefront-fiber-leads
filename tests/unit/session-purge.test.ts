import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { purgeSessionScopedKeys, isSessionScopedStorageKey } from "../../client/src/lib/queryClient";

describe("session-scoped key classification", () => {
  it("matches the account-data keys and nothing else", () => {
    expect(isSessionScopedStorageKey("hf.mapPinsSnapshot.tenant1.rep2")).toBe(true);
    expect(isSessionScopedStorageKey("hf.pendingNotes.v1")).toBe(true);
    expect(isSessionScopedStorageKey("hf.knockQueue.v1.7")).toBe(true);
    expect(isSessionScopedStorageKey("hf.knockDead.v1.7")).toBe(true);
    // Unrelated keys must survive the sweep.
    expect(isSessionScopedStorageKey("hf.mapCamera.v1")).toBe(false);
    expect(isSessionScopedStorageKey("hf.lastFix.v1")).toBe(false);
    expect(isSessionScopedStorageKey("hf.mapFilterStatus.v1")).toBe(false);
    expect(isSessionScopedStorageKey("hf-query-cache-v1")).toBe(false); // handled by clearPersistedQueryCache
    expect(isSessionScopedStorageKey("hfs.user")).toBe(false);          // handled by writePersistedUser(null)
    expect(isSessionScopedStorageKey("other.app.key")).toBe(false);
  });
});

describe("logout purge completeness (SEC-B)", () => {
  beforeEach(() => window.localStorage.clear());

  it("clears pin snapshots, pending notes, and knock-queue keys after purge", () => {
    window.localStorage.setItem("hf.mapPinsSnapshot.t1.r2", "pins");
    window.localStorage.setItem("hf.pendingNotes.v1", "notes");
    window.localStorage.setItem("hf.knockQueue.v1.7", "queue");
    window.localStorage.setItem("hf.knockDead.v1.7", "dead");
    window.localStorage.setItem("hf.mapCamera.v1", "camera");   // survives
    window.localStorage.setItem("some-other-app", "x");         // survives

    purgeSessionScopedKeys();

    expect(window.localStorage.getItem("hf.mapPinsSnapshot.t1.r2")).toBeNull();
    expect(window.localStorage.getItem("hf.pendingNotes.v1")).toBeNull();
    expect(window.localStorage.getItem("hf.knockQueue.v1.7")).toBeNull();
    expect(window.localStorage.getItem("hf.knockDead.v1.7")).toBeNull();
    expect(window.localStorage.getItem("hf.mapCamera.v1")).toBe("camera");
    expect(window.localStorage.getItem("some-other-app")).toBe("x");
  });
});

describe("session token storage (SEC-B)", () => {
  const clientSrc = path.resolve(__dirname, "../../client/src");

  function* walk(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(full);
      else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) yield full;
    }
  }

  it("no window.name references remain anywhere in client/src", () => {
    const offenders: string[] = [];
    for (const file of walk(clientSrc)) {
      if (fs.readFileSync(file, "utf8").includes("window.name")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  // The token now PERSISTS (localStorage) so a rep whose phone evicted the tab
  // is not signed out of a session the server still considers valid - the
  // server renews on a sliding window precisely so that never happens. What
  // made persistence risky before was a token living there indefinitely, so
  // the replacement invariant is: it is never written without a deadline, the
  // deadline is enforced on read, and logout clears both keys.
  it("auth.tsx persists the session with an enforced deadline, never unbounded", () => {
    const auth = fs.readFileSync(path.join(clientSrc, "lib/auth.tsx"), "utf8");
    // Written with a deadline, always as a pair.
    expect(auth).toContain("localStorage?.setItem(SID_KEY");
    expect(auth).toContain("localStorage?.setItem(SID_DEADLINE_KEY");
    // Enforced on read: a token past its deadline is dropped, not returned.
    expect(auth).toMatch(/Date\.now\(\) > until[\s\S]{0,120}writePersistedSession\(null\)/);
    // Cleared on the way out - both keys, plus the legacy sessionStorage one.
    expect(auth).toContain("localStorage?.removeItem(SID_KEY)");
    expect(auth).toContain("localStorage?.removeItem(SID_DEADLINE_KEY)");
  });

  it("logout and 401 purge paths call the session-scoped sweep", () => {
    const auth = fs.readFileSync(path.join(clientSrc, "lib/auth.tsx"), "utf8");
    // login (identity switch), logout, and the confirmed-401 handler all purge.
    const calls = auth.match(/purgeSessionScopedKeys\(\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});
