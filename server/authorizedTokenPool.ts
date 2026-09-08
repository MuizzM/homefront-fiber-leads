import { providerAborted, providerTaskWaitMs } from "./providerDeadline";
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
  backgroundMaintenance?: boolean;
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
  private readonly backgroundMaintenance: boolean;
  private readonly maxLeasesPerToken: number;
  private readonly maxConcurrentRefreshes: number;
  private readonly maxChecksPerToken: number;
  private readonly mint: AuthorizedTokenPoolOptions["mint"];
  // 403-storm mint backoff. These two fields MIRROR the fleet-shared row in
  // governor_state (via bandwidthGovernor, C1): in the 4-worker cluster every
  // process used to count failures and compute backoff independently, so up to
  // 4× concurrent mints could fire against a throttling Cloudflare. The binding
  // is lazy (dynamic import) so constructing a pool never opens the DB; if the
  // shared store is unreachable the pool degrades to its old per-process
  // behavior with zero other changes.
  private consecutiveMintFailures = 0;
  private lastMintFailureAt = 0;
  private governorPromise: Promise<typeof import("./bandwidthGovernor") | null> | null = null;
  private fleetMintSyncAt = 0;
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
    this.backgroundMaintenance = options.backgroundMaintenance !== false;
    this.maxLeasesPerToken = boundedInt(options.maxLeasesPerToken ?? 10, 1, 10_000, 10);
    this.maxConcurrentRefreshes = boundedInt(options.maxConcurrentRefreshes ?? 2, 1, 100, 2);
    this.maxChecksPerToken = boundedInt(options.maxChecksPerToken ?? 100, 1, 100_000, 100);
    this.mint = options.mint;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (!this.backgroundMaintenance || this.maintenanceTimer) return;
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

  /**
   * @param preferLane  With parallel egress lanes, the caller names the lane it
   *   wants to ride and the pool answers with a token that BELONGS to that lane
   *   (slot.id % laneCount === preferLane). Without it, sticky reuse drains one
   *   slot at a time - which is right for token economy and fatal for lanes:
   *   one live slot means one lane means one residential IP, and DECODO_LANES
   *   silently does nothing. Sticky reuse still applies WITHIN a lane.
   */
  async lease(addressKey?: string, preferLane?: number, laneCount?: number,
    wait: { deadlineAt?: number; abort?: () => boolean } = {}): Promise<AuthorizedTokenLease> {
    const deadlineAt = Math.min(this.now() + providerTaskWaitMs(), wait.deadlineAt ?? Infinity);
    const check = () => {
      if (this.now() >= deadlineAt || providerAborted(wait.abort)) throw new Error("AUTHORIZED_TOKEN_WAIT_EXPIRED");
    };
    // A caller can abandon shared pool maintenance without acquiring a lease
    // later. Mints retain their own existing permit; no address work continues.
    const ready = <T>(work: () => Promise<T>): Promise<T> => {
      check();
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("AUTHORIZED_TOKEN_WAIT_EXPIRED")), Math.max(1, deadlineAt - this.now()));
        const poll = wait.abort ? setInterval(() => { if (providerAborted(wait.abort)) finish(new Error("AUTHORIZED_TOKEN_WAIT_EXPIRED")); }, 100) : null;
        const finish = (error?: unknown, value?: T) => {
          clearTimeout(timer); if (poll) clearInterval(poll);
          if (error) reject(error); else resolve(value as T);
        };
        Promise.resolve().then(work).then(value => finish(undefined, value), error => finish(error));
      });
    };
    check();
    const normalizedAddressKey = addressKey?.trim() || null;
    const lane = Number.isInteger(preferLane) && Number.isInteger(laneCount) && (laneCount as number) > 1
      ? { id: preferLane as number, count: laneCount as number } : null;
    // FAST PATH — an interactive check must never queue behind pool husbandry.
    // If ANY ready token exists, take it now: no ensureWarm, no due-slot
    // refresh wave (a burst that emptied 10 slots used to make the next field
    // tap wait ~10 serialized mints before its own search dispatched). pickReady
    // filters on real expiry, so a stale slot can never be returned here.
    let slot = this.pickReady(normalizedAddressKey, lane);
    if (!slot) {
      await ready(() => this.ensureWarm());
      // Bounded: mint at most ONE due slot synchronously for this lease; the
      // maintenance tick refreshes the rest in the background.
      await ready(() => this.refreshDueSlots(1));
      slot = this.pickReady(normalizedAddressKey, lane);
    }
    if (slot && slot.leases >= this.maxLeasesPerToken && this.slots.length < this.maxSize) {
      const expanded = this.createSlot();
      await ready(() => this.refreshSlot(expanded.id, true));
      slot = this.pickReady(normalizedAddressKey, lane);
    }
    // RECYCLE THE LANE'S OWN SLOT, DO NOT GROW THE POOL.
    //
    // A slot that has spent its address budget stays READY-but-full forever, so
    // pickReady skips it and the old code answered by creating a NEW slot. Ids
    // therefore climbed for the life of the process until maxSize refused
    // leases. Measured live on Lexington: 1 -> 6 -> 24 -> 50 -> ... -> 200 slots
    // in eight minutes, at which point the sweep stalled with the queue full and
    // zero answers. Re-minting the lane's existing slot keeps the pool at about
    // one slot per lane, which is the whole point of a pair.
    if (!slot && lane) {
      const own = this.slots.filter((candidate) => candidate.id % lane.count === lane.id);
      const reusable = own.find((candidate) => candidate.state === "EMPTY" || candidate.state === "EXPIRED")
        ?? own.find((candidate) => !candidate.leases)
        ?? own[0];
      if (reusable) {
        await ready(() => this.refreshSlot(reusable.id, true).catch(() => {}));
        slot = this.pickReady(normalizedAddressKey, lane);
      }
    }
    if (!slot && this.slots.length < this.maxSize) {
      // First use of a lane: grow just far enough that the lane owns an id.
      const attempts = lane ? lane.count : 1;
      for (let i = 0; i < attempts && this.slots.length < this.maxSize; i++) {
        const created = this.createSlot();
        if (!lane || created.id % lane.count === lane.id) {
          await ready(() => this.refreshSlot(created.id, true));
          break;
        }
      }
      slot = this.pickReady(normalizedAddressKey, lane);
    }
    // Still nothing on this lane: rather than stall the check, fall back to any
    // ready token. A borrowed token is worse than a lane's own, and far better
    // than a refused check.
    if (!slot && lane) slot = this.pickReady(normalizedAddressKey);
    if (!slot) {
      const refreshing = this.slots.map(item => item.refreshInFlight).filter(Boolean) as Promise<void>[];
      if (refreshing.length) await ready(() => Promise.race(refreshing.map(task => task.catch(() => {}))));
      slot = this.pickReady(normalizedAddressKey);
    }
    if (!slot?.token) {
      const atCapacity = this.slots.length >= this.maxSize
        && this.slots.every(item => item.addressKeys.size >= this.maxChecksPerToken);
      throw new Error(atCapacity
        ? "AUTHORIZED_TOKEN_BATCH_CAPACITY_EXHAUSTED"
        : "AUTHORIZED_TOKEN_POOL_EMPTY");
    }
    check();
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
        // 403-STORM BACKOFF (Kinetic bot-wall workaround): once mints fail
        // consecutively, each further attempt waits 5s -> 10s -> 20s -> ... ->
        // 120s cap. Without it, lease demand re-fires the failed mint hundreds
        // of times a minute — feeding the very throttle that caused the
        // failures (observed live: 500+ mint_failed/3min, zero checks for hours).
        // C1: sync the FLEET failure count first so a sibling worker's storm
        // backs this mint off too (and vice versa via the write-through below).
        await this.syncMintBackoffFromFleet();
        if (process.env.VITEST !== "true" && this.consecutiveMintFailures >= 3) {
          const backoffMs = Math.min(120_000, 5_000 * 2 ** (this.consecutiveMintFailures - 3));
          const wait = this.lastMintFailureAt + backoffMs - this.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        }
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
        this.resetFleetMintBackoff(); // write-through: clear the shared storm counter
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
        this.lastMintFailureAt = this.now();
        this.noteFleetMintFailure(); // write-through: the whole fleet backs off
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

  /**
   * End the current token generation: every live token was minted against an
   * egress IP that has just been replaced, and Kinetic throttles the (token, IP)
   * PAIR, so a token that outlives its IP is half of a pair that no longer
   * exists. Measured: fresh token + fresh IP every 20 checks answered 60/60,
   * against 20/60 for a token ridden across fresh IPs.
   *
   * LAZY on purpose. Slots go EMPTY and are re-minted on the next lease, so a
   * rotation costs ONE mint when the next check arrives rather than a warm-pool
   * refill. That is why the warm reserve belongs at 1 under this rule: a crowd
   * of warm tokens would all die at the same instant, unused.
   *
   * An earlier revision carried invalidateAllForEgressChange and removed it as
   * "a pointless re-mint on every rotation". That was correct THEN - rotation
   * fired every 10 proxied requests, nowhere near a pair boundary. It is wrong
   * now: rotation IS the pair boundary.
   */
  /**
   * Retire ONE slot's token, because the lane it was bound to just changed IP.
   * With parallel lanes a pair is (slot, lane): lane 3 moving house says nothing
   * about the token on lane 1, and dropping the whole pool there would throw
   * away good tokens on every lane rotation.
   */
  retireSlot(slotId: number): number {
    const slot = this.slots[slotId];
    if (!slot?.token) return 0;
    slot.token = null;
    slot.expiresAt = 0;
    slot.state = "EMPTY";
    slot.addressKeys.clear();
    slot.leases = 0;
    return 1;
  }

  /**
   * Retire every token riding one egress lane.
   *
   * A lane is not a slot. The scanner maps slot -> lane as `slotId % laneCount`,
   * so lane L carries slots L, L+laneCount, L+2*laneCount... Indexing the slot
   * array with a LANE id retires slots[L] - usually an idle slot, silently,
   * returning 0 - while the token actually on that lane's brand-new IP keeps
   * being leased. That is the "one token, fresh IP every 20" arm the measurement
   * table scores at 20/60, and it also lets the pool grow unchecked: simulated
   * at 6-way concurrency it ran to the 200-slot cap with 1,900 of 6,000 leases
   * refused, against 5 slots and zero refusals once the right slots retire.
   */
  retireLane(laneId: number, laneCount: number): number {
    if (!Number.isInteger(laneId) || !Number.isInteger(laneCount) || laneCount < 1) return 0;
    let retired = 0;
    for (const slot of this.slots) {
      if (slot.id % laneCount !== laneId) continue;
      if (!slot.token) continue;
      slot.token = null;
      slot.expiresAt = 0;
      slot.state = "EMPTY";
      slot.addressKeys.clear();
      slot.leases = 0;
      retired++;
    }
    return retired;
  }

  retireGeneration(): number {
    let retired = 0;
    for (const slot of this.slots) {
      if (!slot.token) continue;
      retired++;
      slot.token = null;
      slot.expiresAt = 0;
      slot.state = "EMPTY";
      slot.addressKeys.clear();
      slot.leases = 0;
    }
    return retired;
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

  private pickReady(addressKey: string | null = null, lane: { id: number; count: number } | null = null): TokenSlot | null {
    const now = this.now();
    const candidates = this.slots.filter(slot =>
      (!lane || slot.id % lane.count === lane.id) &&
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

  // ── C1 fleet-shared mint backoff binding ──────────────────────────────────
  private governor(): Promise<typeof import("./bandwidthGovernor") | null> {
    if (!this.governorPromise) {
      this.governorPromise = import("./bandwidthGovernor").catch(() => null);
    }
    return this.governorPromise;
  }

  /** Refresh the local mirror from the shared row. Forced (bypasses the TTL)
   *  while we already believe a storm is active, so we never lengthen/shorten
   *  a backoff off a stale count. */
  private async syncMintBackoffFromFleet(): Promise<void> {
    try {
      const gov = await this.governor();
      if (!gov) return;
      const force = this.consecutiveMintFailures > 0;
      const now = Date.now();
      if (!force && now - this.fleetMintSyncAt < 5_000) return;
      this.fleetMintSyncAt = now;
      const shared = gov.getSharedMintBackoff(force);
      this.consecutiveMintFailures = shared.failures;
      this.lastMintFailureAt = shared.lastFailureAt;
    } catch { /* fleet share best-effort — local mirror stays authoritative */ }
  }

  private noteFleetMintFailure(): void {
    void this.governor().then((gov) => {
      try { gov?.noteSharedMintFailure(Date.now()); } catch { /* best-effort */ }
    });
  }

  private resetFleetMintBackoff(): void {
    void this.governor().then((gov) => {
      try { gov?.resetSharedMintFailures(); } catch { /* best-effort */ }
    });
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
