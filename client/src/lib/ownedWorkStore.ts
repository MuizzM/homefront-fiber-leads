import { canAdoptLegacyWork, isCurrentWorkLease, sameWorkOwner, subscribeWorkAuthority, workOwnerKey, type WorkLease } from "./workAuthority";

/** Owner-tagged persistence with a memory mirror for blocked/full storage. The
 * mirror survives suspension, but purge destroys it before auth changes. */
export function ownedWorkStore<T>(prefix: string, empty: () => T, legacyKey?: string) {
  const memory = new Map<string, T>();
  const degraded = new Set<string>();
  subscribeWorkAuthority(event => {
    if (event !== "purge" && event !== "discard") return;
    if (event === "purge") {
      try {
        const keys = new Set(memory.keys());
        for (let i = 0; i < localStorage.length; i++) { const key = localStorage.key(i); if (key?.startsWith(prefix)) keys.add(key); }
        for (const key of keys) localStorage.removeItem(key);
      } catch { /* the memory mirror is still erased */ }
    }
    memory.clear(); degraded.clear();
  });
  function read(lease: WorkLease): T {
    if (!isCurrentWorkLease(lease)) return empty();
    const key = prefix + workOwnerKey(lease.owner);
    if (degraded.has(key)) return memory.get(key) ?? empty();
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const env = JSON.parse(raw);
        if (env?.v === 2 && sameWorkOwner(env.owner, lease.owner)) { memory.set(key, env.value); return env.value; }
        return empty();
      }
      if (legacyKey && canAdoptLegacyWork(lease.owner)) {
        const legacy = localStorage.getItem(legacyKey);
        if (legacy) { const value = JSON.parse(legacy); if (write(lease, value)) localStorage.removeItem(legacyKey); return value; }
      }
      return memory.get(key) ?? empty();
    } catch { degraded.add(key); return memory.get(key) ?? empty(); }
  }
  function write(lease: WorkLease, value: T): boolean {
    if (!isCurrentWorkLease(lease)) return false;
    const key = prefix + workOwnerKey(lease.owner);
    memory.set(key, value);
    if (degraded.has(key)) return false;
    try { localStorage.setItem(key, JSON.stringify({ v: 2, owner: lease.owner, value })); return true; }
    catch { degraded.add(key); return false; }
  }
  return { read, write };
}
