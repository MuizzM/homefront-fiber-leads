export type AuthorizedTokenState = "EMPTY" | "READY" | "REFRESHING" | "COOLDOWN" | "EXPIRED" | "DISABLED";

export interface MintedAuthorizedToken {
  token: string;
  expiresAt: number;
}

interface TokenSlot {
  id: number;
  state: AuthorizedTokenState;
  token: string | null;
  expiresAt: number;
  cooldownUntil: number;
  leases: number;
  lastLeaseSequence: number;
  refreshInFlight: Promise<void> | null;
  failures: number;
  lastError: string | null;
}

export interface AuthorizedTokenLease {
  slotId: number;
  token: string;
  expiresAt: number;
  release(): void;
}

export interface AuthorizedTokenPoolSnapshot {
  maxSize: number;
  warmMinimum: number;
  total: number;
  ready: number;
  activeLeases: number;
  states: Record<AuthorizedTokenState, number>;
  nextExpiryAt: number | null;
  disabled: boolean;
}

export interface AuthorizedTokenPoolOptions {
  maxSize: number;
  warmMinimum: number;
  refreshMarginMs: number;
  cooldownBaseMs?: number;
  maintenanceIntervalMs?: number;
  maxLeasesPerToken?: number;
  mint: (slotId: number) => Promise<MintedAuthorizedToken>;
  now?: () => number;
}

/**
 * In-process bearer-token lifecycle manager shared by every scanner producer.
 * Tokens never leave this server-side object. A distributed provider admission
 * gate separately constrains aggregate search traffic across app instances.
 */
export class AuthorizedTokenPool {
  private readonly maxSize: number;
  private readonly warmMinimum: number;
  private readonly refreshMarginMs: number;
  private readonly cooldownBaseMs: number;
  private readonly maintenanceIntervalMs: number;
  private readonly maxLeasesPerToken: number;
  private readonly mint: AuthorizedTokenPoolOptions["mint"];
  private readonly now: () => number;
  private readonly slots: TokenSlot[] = [];
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private warmInFlight: Promise<void> | null = null;
  private leaseSequence = 0;
  private disabled = false;

  constructor(options: AuthorizedTokenPoolOptions) {
    this.maxSize = boundedInt(options.maxSize, 1, 300, 1);
    this.warmMinimum = boundedInt(options.warmMinimum, 1, this.maxSize, 1);
    this.refreshMarginMs = Math.max(1_000, Math.floor(options.refreshMarginMs));
    this.cooldownBaseMs = Math.max(250, Math.floor(options.cooldownBaseMs ?? 2_000));
    this.maintenanceIntervalMs = Math.max(1_000, Math.floor(options.maintenanceIntervalMs ?? 15_000));
    this.maxLeasesPerToken = boundedInt(options.maxLeasesPerToken ?? 10, 1, 1_000, 10);
    this.mint = options.mint;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.maintenanceTimer || this.disabled) return;
    void this.ensureWarm();
    this.maintenanceTimer = setInterval(() => void this.maintain(), this.maintenanceIntervalMs);
    if (typeof (this.maintenanceTimer as any).unref === "function") (this.maintenanceTimer as any).unref();
  }

  stop(): void {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    this.disabled = true;
    for (const slot of this.slots) {
      slot.state = "DISABLED";
      slot.token = null;
      slot.expiresAt = 0;
    }
  }

  resume(): void {
    this.disabled = false;
    for (const slot of this.slots) if (slot.state === "DISABLED") slot.state = "EMPTY";
    this.start();
  }

  async lease(): Promise<AuthorizedTokenLease> {
    if (this.disabled) throw new Error("AUTHORIZED_TOKEN_POOL_DISABLED");
    await this.ensureWarm();
    await this.refreshDueSlots();
    let slot = this.pickReady();
    if (slot && slot.leases >= this.maxLeasesPerToken && this.slots.length < this.maxSize) {
      const expanded = this.createSlot();
      await this.refreshSlot(expanded.id, true);
      slot = this.pickReady();
    }
    if (!slot && this.slots.length < this.maxSize) {
      slot = this.createSlot();
      await this.refreshSlot(slot.id, true);
      slot = this.pickReady();
    }
    if (!slot) {
      const refreshing = this.slots.map(item => item.refreshInFlight).filter(Boolean) as Promise<void>[];
      if (refreshing.length) await Promise.race(refreshing.map(task => task.catch(() => {})));
      slot = this.pickReady();
    }
    if (!slot?.token) throw new Error("AUTHORIZED_TOKEN_POOL_EMPTY");
    slot.leases++;
    slot.lastLeaseSequence = ++this.leaseSequence;
    let released = false;
    return {
      slotId: slot.id,
      token: slot.token,
      expiresAt: slot.expiresAt,
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
    if (this.disabled || slot.state === "DISABLED") throw new Error("AUTHORIZED_TOKEN_POOL_DISABLED");
    const now = this.now();
    if (!force && slot.token && slot.state === "READY" && now < slot.expiresAt - this.refreshMarginMs) return slot.token;
    if (slot.refreshInFlight) {
      await slot.refreshInFlight;
      if (!slot.token) throw new Error(slot.lastError ?? "AUTHORIZED_TOKEN_REFRESH_FAILED");
      return slot.token;
    }
    if (!force && slot.state === "COOLDOWN" && slot.cooldownUntil > now) throw new Error("AUTHORIZED_TOKEN_SLOT_COOLDOWN");
    slot.state = "REFRESHING";
    slot.refreshInFlight = (async () => {
      try {
        const minted = await this.mint(slot.id);
        if (!minted.token || minted.expiresAt <= this.now() + this.refreshMarginMs) throw new Error("AUTHORIZED_TOKEN_EXPIRES_TOO_SOON");
        slot.token = minted.token;
        slot.expiresAt = minted.expiresAt;
        slot.state = "READY";
        slot.failures = 0;
        slot.cooldownUntil = 0;
        slot.lastError = null;
      } catch (error) {
        slot.token = null;
        slot.expiresAt = 0;
        slot.failures++;
        slot.lastError = String((error as any)?.message ?? error).slice(0, 180);
        slot.cooldownUntil = this.now() + Math.min(60_000, this.cooldownBaseMs * 2 ** Math.min(5, slot.failures - 1));
        slot.state = "COOLDOWN";
        throw error;
      } finally {
        slot.refreshInFlight = null;
      }
    })();
    await slot.refreshInFlight;
    return slot.token!;
  }

  async refreshLease(lease: AuthorizedTokenLease): Promise<string> {
    return this.refreshSlot(lease.slotId, true);
  }

  install(token: string, expiresAt: number): void {
    this.disabled = false;
    let slot = this.slots[0] ?? this.createSlot();
    slot.token = token;
    slot.expiresAt = expiresAt;
    slot.state = "READY";
    slot.failures = 0;
    slot.cooldownUntil = 0;
    slot.lastError = null;
    this.start();
  }

  expire(slotId: number): void {
    const slot = this.slots[slotId];
    if (!slot || slot.state === "DISABLED") return;
    slot.token = null;
    slot.expiresAt = 0;
    slot.state = "EXPIRED";
  }

  disable(): void {
    this.disabled = true;
    for (const slot of this.slots) {
      slot.state = "DISABLED";
      slot.token = null;
      slot.expiresAt = 0;
    }
  }

  snapshot(): AuthorizedTokenPoolSnapshot {
    this.updateStates();
    const states: Record<AuthorizedTokenState, number> = { EMPTY: 0, READY: 0, REFRESHING: 0, COOLDOWN: 0, EXPIRED: 0, DISABLED: 0 };
    for (const slot of this.slots) states[slot.state]++;
    const expiries = this.slots.filter(slot => slot.state === "READY" && slot.expiresAt > 0).map(slot => slot.expiresAt);
    return {
      maxSize: this.maxSize,
      warmMinimum: this.warmMinimum,
      total: this.slots.length,
      ready: states.READY,
      activeLeases: this.slots.reduce((sum, slot) => sum + slot.leases, 0),
      states,
      nextExpiryAt: expiries.length ? Math.min(...expiries) : null,
      disabled: this.disabled,
    };
  }

  private async maintain(): Promise<void> {
    this.updateStates();
    await this.refreshDueSlots();
    await this.ensureWarm();
  }

  private async ensureWarm(): Promise<void> {
    if (this.disabled) throw new Error("AUTHORIZED_TOKEN_POOL_DISABLED");
    if (this.warmInFlight) return this.warmInFlight;
    this.warmInFlight = (async () => {
      this.updateStates();
      const needed = Math.min(this.maxSize - this.slots.length, Math.max(0, this.warmMinimum - this.slots.length));
      const created = Array.from({ length: needed }, () => this.createSlot());
      await Promise.allSettled(created.map(slot => this.refreshSlot(slot.id, true)));
      if (!this.pickReady()) {
        const reusable = this.slots.find(slot => slot.state === "EMPTY" || slot.state === "EXPIRED" || (slot.state === "COOLDOWN" && slot.cooldownUntil <= this.now()));
        if (reusable) await this.refreshSlot(reusable.id, true);
      }
    })();
    try { await this.warmInFlight; }
    finally { this.warmInFlight = null; }
  }

  private async refreshDueSlots(): Promise<void> {
    const now = this.now();
    this.updateStates();
    const due = this.slots.filter(slot =>
      (slot.state === "READY" && slot.expiresAt <= now + this.refreshMarginMs) ||
      slot.state === "EXPIRED" ||
      (slot.state === "COOLDOWN" && slot.cooldownUntil <= now));
    await Promise.allSettled(due.map(slot => this.refreshSlot(slot.id, true)));
  }

  private updateStates(): void {
    const now = this.now();
    for (const slot of this.slots) {
      if (this.disabled) slot.state = "DISABLED";
      else if (slot.state === "READY" && slot.expiresAt <= now) {
        slot.token = null;
        slot.state = "EXPIRED";
      }
    }
  }

  private pickReady(): TokenSlot | null {
    const now = this.now();
    const candidates = this.slots.filter(slot => slot.state === "READY" && !!slot.token && slot.expiresAt > now + this.refreshMarginMs);
    candidates.sort((a, b) => a.leases - b.leases || a.lastLeaseSequence - b.lastLeaseSequence || a.id - b.id);
    return candidates[0] ?? null;
  }

  private createSlot(): TokenSlot {
    if (this.slots.length >= this.maxSize) throw new Error("AUTHORIZED_TOKEN_POOL_CAPACITY");
    const slot: TokenSlot = {
      id: this.slots.length, state: "EMPTY", token: null, expiresAt: 0,
      cooldownUntil: 0, leases: 0, lastLeaseSequence: 0,
      refreshInFlight: null, failures: 0, lastError: null,
    };
    this.slots.push(slot);
    return slot;
  }
}

function boundedInt(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}
