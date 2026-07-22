export type AuthorizedTokenState = "EMPTY" | "READY" | "REFRESHING" | "EXPIRED";
export type AuthorizedTokenHealth = "HEALTHY" | "DEGRADED" | "UNHEALTHY";

export interface MintedAuthorizedToken {
  token: string;
  expiresAt: number;
}

interface TokenSlot {
  id: number;
  state: AuthorizedTokenState;
  token: string | null;
  expiresAt: number;
  leases: number;
  addressKeys: Set<string>;
  health: AuthorizedTokenHealth;
  lastLeaseSequence: number;
  refreshInFlight: Promise<void> | null;
  failures: number;
  lastError: string | null;
}

export interface AuthorizedTokenLease {
  slotId: number;
  token: string;
  expiresAt: number;
  addressKey: string | null;
  checksUsed: number;
  release(): void;
}

export interface AuthorizedTokenSlotSnapshot {
  slotId: number;
  state: AuthorizedTokenState;
  health: AuthorizedTokenHealth;
  inFlight: number;
  checksUsed: number;
  checksRemaining: number;
  expiresAt: number | null;
}

export interface AuthorizedTokenPoolSnapshot {
  maxSize: number;
  warmMinimum: number;
  total: number;
  ready: number;
  activeLeases: number;
  activeRefreshes: number;
  maxChecksPerToken: number;
  maxBatchCapacity: number;
  checksUsed: number;
  checksRemaining: number;
  healthy: number;
  degraded: number;
  unhealthy: number;
  states: Record<AuthorizedTokenState, number>;
  nextExpiryAt: number | null;
  slots: AuthorizedTokenSlotSnapshot[];
}

export interface AuthorizedTokenPoolOptions {
  maxSize: number;
  warmMinimum: number;
  refreshMarginMs: number;
  maintenanceIntervalMs?: number;
  maxLeasesPerToken?: number;
  maxConcurrentRefreshes?: number;
  maxChecksPerToken?: number;
  mint: (slotId: number) => Promise<MintedAuthorizedToken>;
  now?: () => number;
}

/**
 * In-process bearer-token lifecycle manager shared by every scanner producer.
 * Tokens never leave this server-side object. There is NO cooldown, backoff, or
 * disabled state: a token is only ever replaced when it is expired or invalid.
 * On any failure a slot returns to EMPTY and is re-minted on demand — the scanner
 * can never be wedged by token state. Per-slot single-flight refresh + a bounded
 * refresh permit are the sole stampede guards ("one shared refresh operation").
 * A distributed provider admission gate separately constrains aggregate search
 * traffic across app instances.
 */
export class AuthorizedTokenPool {
  private readonly maxSize: number;
  private readonly warmMinimum: number;
  private readonly refreshMarginMs: number;
  private readonly maintenanceIntervalMs: number;
  private readonly maxLeasesPerToken: number;
  private readonly maxConcurrentRefreshes: number;
  private readonly maxChecksPerToken: number;
  private readonly mint: AuthorizedTokenPoolOptions["mint"];
  private consecutiveMintFailures = 0;
  private readonly now: () => number;
  private readonly slots: TokenSlot[] = [];
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private warmInFlight: Promise<void> | null = null;
  private warmFirstReady: Promise<void> | null = null;
  private leaseSequence = 0;
  private activeRefreshes = 0;
  private readonly refreshWaiters: Array<() => void> = [];

  constructor(options: AuthorizedTokenPoolOptions) {
    // Unlimited Decodo budget → no artificial pool ceilings. Bounds exist only to
    // catch absurd misconfiguration, not to ration proxy spend.
    this.maxSize = boundedInt(options.maxSize, 1, 1_000, 1);
    this.warmMinimum = boundedInt(options.warmMinimum, 1, this.maxSize, 1);
    this.refreshMarginMs = Math.max(1_000, Math.floor(options.refreshMarginMs));
    this.maintenanceIntervalMs = Math.max(1_000, Math.floor(options.maintenanceIntervalMs ?? 15_000));
    this.maxLeasesPerToken = boundedInt(options.maxLeasesPerToken ?? 10, 1, 10_000, 10);
    this.maxConcurrentRefreshes = boundedInt(options.maxConcurrentRefreshes ?? 2, 1, 100, 2);
    this.maxChecksPerToken = boundedInt(options.maxChecksPerToken ?? 100, 1, 100_000, 100);
    this.mint = options.mint;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.maintenanceTimer) return;
    void this.ensureWarm().catch(() => {});
    // A failed mint during maintenance is an expected transient — the pool
    // self-heals on the next tick. Swallow it: an uncaught rejection from a
    // timer is a process-killer in Node (this crashed the prod container).
    this.maintenanceTimer = setInterval(() => { this.maintain().catch(() => {}); }, this.maintenanceIntervalMs);
    if (typeof (this.maintenanceTimer as any).unref === "function") (this.maintenanceTimer as any).unref();
  }

  stop(): void {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    for (const slot of this.slots) {
      slot.state = "EMPTY";
      slot.token = null;
      slot.expiresAt = 0;
      slot.addressKeys.clear();
    }
  }

  async lease(addressKey?: string): Promise<AuthorizedTokenLease> {
    const normalizedAddressKey = addressKey?.trim() || null;
    // FAST PATH — an interactive check must never queue behind pool husbandry.
    // If ANY ready token exists, take it now: no ensureWarm, no due-slot
    // refresh wave (a burst that emptied 10 slots used to make the next field
    // tap wait ~10 serialized mints before its own search dispatched). pickReady
    // filters on real expiry, so a stale slot can never be returned here.
    let slot = this.pickReady(normalizedAddressKey);
    if (!slot) {
      await this.ensureWarm();
      // Bounded: mint at most ONE due slot synchronously for this lease; the
      // maintenance tick refreshes the rest in the background.
      await this.refreshDueSlots(1);
      slot = this.pickReady(normalizedAddressKey);
    }
    if (slot && slot.leases >= this.maxLeasesPerToken && this.slots.length < this.maxSize) {
      const expanded = this.createSlot();
      await this.refreshSlot(expanded.id, true);
      slot = this.pickReady(normalizedAddressKey);
    }
    if (!slot && this.slots.length < this.maxSize) {
      slot = this.createSlot();
      await this.refreshSlot(slot.id, true);
      slot = this.pickReady(normalizedAddressKey);
    }
    if (!slot) {
      const refreshing = this.slots.map(item => item.refreshInFlight).filter(Boolean) as Promise<void>[];
      if (refreshing.length) await Promise.race(refreshing.map(task => task.catch(() => {})));
      slot = this.pickReady(normalizedAddressKey);
    }
    if (!slot?.token) {
      const atCapacity = this.slots.length >= this.maxSize
        && this.slots.every(item => item.addressKeys.size >= this.maxChecksPerToken);
      throw new Error(atCapacity
        ? "AUTHORIZED_TOKEN_BATCH_CAPACITY_EXHAUSTED"
        : "AUTHORIZED_TOKEN_POOL_EMPTY");
    }
    if (normalizedAddressKey && !slot.addressKeys.has(normalizedAddressKey)) {
      if (slot.addressKeys.size >= this.maxChecksPerToken)
        throw new Error("AUTHORIZED_TOKEN_SLOT_CAPACITY_EXHAUSTED");
      slot.addressKeys.add(normalizedAddressKey);
    }
    slot.leases++;
    slot.lastLeaseSequence = ++this.leaseSequence;
    let released = false;
    return {
      slotId: slot.id,
      token: slot.token,
      expiresAt: slot.expiresAt,
      addressKey: normalizedAddressKey,
      checksUsed: slot.addressKeys.size,
      release: () => {
        if (released) return;
        released = true;
        slot!.leases = Math.max(0, slot!.leases - 1);
      },
    };
  }

  async refreshSlot(slotId: number, force = false): Promise<string> {
    const slot = this.slots[slotId];
    if (!slot) throw new Error("AUTHORIZED_TOKEN_SLOT_NOT_FOUND");
    const now = this.now();
    if (!force && slot.token && slot.state === "READY" && now < slot.expiresAt - this.refreshMarginMs) return slot.token;
    if (slot.refreshInFlight) {
      await slot.refreshInFlight;
      if (!slot.token) throw new Error(slot.lastError ?? "AUTHORIZED_TOKEN_REFRESH_FAILED");
      return slot.token;
    }
    slot.state = "REFRESHING";
    slot.refreshInFlight = (async () => {
      try {
        // Per-slot refreshes are single-flight above; this second, pool-wide
        // permit prevents many independently expiring slots from stampeding the
        // token endpoint at the same instant. This is the ONE shared refresh op.
        const minted = await this.withRefreshPermit(() => this.mint(slot.id));
        if (!minted.token || minted.expiresAt <= this.now() + this.refreshMarginMs) throw new Error("AUTHORIZED_TOKEN_EXPIRES_TOO_SOON");
        slot.token = minted.token;
        slot.expiresAt = minted.expiresAt;
        slot.state = "READY";
        slot.health = "HEALTHY";
        slot.addressKeys.clear();
        slot.failures = 0;
        slot.lastError = null;
        this.consecutiveMintFailures = 0;
      } catch (error) {
        // No cooldown, no backoff — the slot simply becomes EMPTY and is re-minted
        // on the next lease/maintenance. Failures are tracked for health only.
        slot.token = null;
        slot.expiresAt = 0;
        slot.failures++;
        slot.health = slot.failures >= 3 ? "UNHEALTHY" : "DEGRADED";
        slot.lastError = String((error as any)?.message ?? error).slice(0, 180);
        slot.state = "EMPTY";
        this.consecutiveMintFailures++;
        throw error;
      } finally {
        slot.refreshInFlight = null;
      }
    })();
    await slot.refreshInFlight;
    return slot.token!;
  }

  async refreshLease(lease: AuthorizedTokenLease): Promise<string> {
    const token = await this.refreshSlot(lease.slotId, true);
    const slot = this.slots[lease.slotId];
    if (lease.addressKey) slot.addressKeys.add(lease.addressKey);
    return token;
  }

  /**
   * Drop a token the caller just saw fail against the provider so it is never
   * reused. The slot returns to EMPTY and is re-minted on the next lease. Safe to
   * call with a stale/unknown token (no-op). This is the invalidate half of the
   * "on error: invalidate token → mint fresh → requeue → continue" contract.
   */
  invalidate(token: string | null | undefined): void {
    if (!token) return;
    for (const slot of this.slots) {
      if (slot.token === token) {
        slot.token = null;
        slot.expiresAt = 0;
        slot.state = "EMPTY";
        slot.addressKeys.clear();
        slot.health = "DEGRADED";
      }
    }
  }

  install(token: string, expiresAt: number): void {
    const slot = this.slots[0] ?? this.createSlot();
    slot.token = token;
    slot.expiresAt = expiresAt;
    slot.state = "READY";
    slot.health = "HEALTHY";
    slot.addressKeys.clear();
    slot.failures = 0;
    slot.lastError = null;
    this.start();
  }

  expire(slotId: number): void {
    const slot = this.slots[slotId];
    if (!slot) return;
    slot.token = null;
    slot.expiresAt = 0;
    slot.state = "EXPIRED";
    slot.health = "UNHEALTHY";
    slot.addressKeys.clear();
  }

  snapshot(): AuthorizedTokenPoolSnapshot {
    this.updateStates();
    const states: Record<AuthorizedTokenState, number> = { EMPTY: 0, READY: 0, REFRESHING: 0, EXPIRED: 0 };
    for (const slot of this.slots) states[slot.state]++;
    const expiries = this.slots.filter(slot => slot.state === "READY" && slot.expiresAt > 0).map(slot => slot.expiresAt);
    const slotSnapshots: AuthorizedTokenSlotSnapshot[] = this.slots.map(slot => ({
      slotId: slot.id,
      state: slot.state,
      health: slot.health,
      inFlight: slot.leases,
      checksUsed: slot.addressKeys.size,
      checksRemaining: Math.max(0, this.maxChecksPerToken - slot.addressKeys.size),
      expiresAt: slot.expiresAt > 0 ? slot.expiresAt : null,
    }));
    const checksUsed = slotSnapshots.reduce((sum, slot) => sum + slot.checksUsed, 0);
    return {
      maxSize: this.maxSize,
      warmMinimum: this.warmMinimum,
      total: this.slots.length,
      ready: states.READY,
      activeLeases: this.slots.reduce((sum, slot) => sum + slot.leases, 0),
      activeRefreshes: this.activeRefreshes,
      maxChecksPerToken: this.maxChecksPerToken,
      maxBatchCapacity: this.maxSize * this.maxChecksPerToken,
      checksUsed,
      checksRemaining: Math.max(0, this.maxSize * this.maxChecksPerToken - checksUsed),
      healthy: slotSnapshots.filter(slot => slot.health === "HEALTHY").length,
      degraded: slotSnapshots.filter(slot => slot.health === "DEGRADED").length,
      unhealthy: slotSnapshots.filter(slot => slot.health === "UNHEALTHY").length,
      states,
      nextExpiryAt: expiries.length ? Math.min(...expiries) : null,
      slots: slotSnapshots,
    };
  }

  private async maintain(): Promise<void> {
    this.updateStates();
    await this.refreshDueSlots();
    await this.ensureWarm();
  }

  private async ensureWarm(): Promise<void> {
    // A leaser needs exactly ONE ready token — never the whole warm pool.
    if (this.pickReady()) return;
    if (this.warmInFlight) {
      await (this.warmFirstReady ?? this.warmInFlight);
      return;
    }
    this.updateStates();
    // When mints are FAILING, bound the synchronous wave to one concurrency
    // window: a lease must never sit through dozens of doomed mints before
    // concluding the pool is empty (the maintenance timer keeps retrying in
    // the background). Healthy pools warm fully, immediately.
    const wave = this.consecutiveMintFailures > 0 ? this.maxConcurrentRefreshes : Number.MAX_SAFE_INTEGER;
    const needed = Math.min(wave, this.maxSize - this.slots.length, Math.max(0, this.warmMinimum - this.slots.length));
    const created = Array.from({ length: needed }, () => this.createSlot());
    const refreshes = created.map(slot => this.refreshSlot(slot.id, true));
    const full = (async () => {
      await Promise.allSettled(refreshes);
      if (!this.pickReady()) {
        const reusable = this.slots.find(slot => slot.state === "EMPTY" || slot.state === "EXPIRED");
        if (reusable) await this.refreshSlot(reusable.id, true).catch(() => {});
      }
    })();
    this.warmInFlight = full;
    // COLD-START FIX: the caller unblocks on the FIRST successful mint (~one
    // Decodo RTT) while the rest of the pool warms in the background. The old
    // allSettled-only shape made the first post-boot check wait for EVERY warm
    // mint serialized through the 100ms mint gate (~6-16s after a redeploy).
    this.warmFirstReady = refreshes.length
      ? Promise.race([Promise.any(refreshes).then(() => undefined, () => undefined), full])
      : full;
    void full.finally(() => {
      this.warmInFlight = null;
      this.warmFirstReady = null;
    });
    await this.warmFirstReady;
  }

  private async refreshDueSlots(maxWave?: number): Promise<void> {
    const now = this.now();
    this.updateStates();
    // Demand-driven: refresh only enough slots to keep warmMinimum READY.
    // The old shape re-minted EVERY empty/expired slot on every 10s tick —
    // with a grown pool that was ~40 perpetual mints per token window at zero
    // traffic, and a transient failure burst permanently raised the rate
    // (slots are never removed). Excess dead slots now just sit idle.
    const ready = this.slots.filter(slot =>
      slot.state === "READY" && !!slot.token && slot.expiresAt > now + this.refreshMarginMs).length;
    const deficit = Math.max(0, this.warmMinimum - ready);
    if (deficit === 0) return;
    const due = this.slots.filter(slot =>
      (slot.state === "READY" && slot.expiresAt <= now + this.refreshMarginMs) ||
      slot.state === "EXPIRED" ||
      slot.state === "EMPTY");
    // Same failure-aware bound as ensureWarm: when the endpoint is down, one
    // wave per lease; the maintenance timer sweeps the rest.
    const failureWave = this.consecutiveMintFailures > 0 ? this.maxConcurrentRefreshes : due.length;
    const wave = Math.min(deficit, maxWave ?? failureWave);
    await Promise.allSettled(due.slice(0, wave).map(slot => this.refreshSlot(slot.id, true)));
  }

  private updateStates(): void {
    const now = this.now();
    for (const slot of this.slots) {
      if (slot.state === "READY" && slot.expiresAt <= now) {
        slot.token = null;
        slot.state = "EXPIRED";
        slot.health = "UNHEALTHY";
        slot.addressKeys.clear();
      }
    }
  }

  private pickReady(addressKey: string | null = null): TokenSlot | null {
    const now = this.now();
    const candidates = this.slots.filter(slot =>
      slot.state === "READY"
      && !!slot.token
      && slot.expiresAt > now + this.refreshMarginMs
      && (!addressKey || slot.addressKeys.has(addressKey) || slot.addressKeys.size < this.maxChecksPerToken));
    candidates.sort((a, b) => {
      if (addressKey) {
        const existingDelta = Number(!a.addressKeys.has(addressKey)) - Number(!b.addressKeys.has(addressKey));
        if (existingDelta) return existingDelta;
      }
      // STICKY REUSE (owner directive: "if I scan 40-50 and it works, do NOT
      // fetch a new token"): drain the MOST-used token toward its per-token
      // check budget before touching the next one. The old least-used-first
      // order round-robined a batch across every warm slot, so 45 checks
      // burned ~10 tokens instead of 1. Capped slots are already excluded by
      // the filter above, so a full token hands off to the next automatically.
      return b.addressKeys.size - a.addressKeys.size
        || a.leases - b.leases
        || a.lastLeaseSequence - b.lastLeaseSequence
        || a.id - b.id;
    });
    return candidates[0] ?? null;
  }

  private createSlot(): TokenSlot {
    if (this.slots.length >= this.maxSize) throw new Error("AUTHORIZED_TOKEN_POOL_CAPACITY");
    const slot: TokenSlot = {
      id: this.slots.length, state: "EMPTY", token: null, expiresAt: 0,
      leases: 0, lastLeaseSequence: 0,
      refreshInFlight: null, failures: 0, lastError: null,
      addressKeys: new Set<string>(), health: "UNHEALTHY",
    };
    this.slots.push(slot);
    return slot;
  }

  private async withRefreshPermit<T>(task: () => Promise<T>): Promise<T> {
    if (this.activeRefreshes >= this.maxConcurrentRefreshes) {
      await new Promise<void>(resolve => this.refreshWaiters.push(resolve));
    }
    this.activeRefreshes++;
    try {
      return await task();
    } finally {
      this.activeRefreshes = Math.max(0, this.activeRefreshes - 1);
      this.refreshWaiters.shift()?.();
    }
  }
}

function boundedInt(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}
