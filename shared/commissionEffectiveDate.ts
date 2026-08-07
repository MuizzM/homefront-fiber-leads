// ── Effective-date resolution for commission-relevant writes (PURE) ──────────
//
// ONE place decides what timestamp a sale write is allowed to record. Every
// write path — upsertSale, transitionSale, knock/field-sale intake, imports,
// backfills, cron jobs and administrative corrections — resolves through here,
// because the moment there are two implementations one of them is the backdating
// door. There were two: `upsertSale` clamped to the correction window while
// `transitionSale`'s QUALIFY took the caller's timestamp verbatim, so a payload
// refused by one route was accepted by the other.
//
// Pure on purpose: no DB, no clock, no framework. The caller supplies the org
// policy, the server-stamped receipt time, and whether the target week is
// locked; this module decides, explains itself, and never writes anything.

/** Which timestamp places a sale in a pay week. */
export type QualificationBasis = "SOLD_AT" | "QUALIFIED_AT" | "INSTALLED_AT" | "ACTIVATED_AT";

export const BASIS_FIELD: Record<QualificationBasis, "soldAt" | "qualifiedAt" | "installedAt" | "activatedAt"> = {
  SOLD_AT: "soldAt", QUALIFIED_AT: "qualifiedAt", INSTALLED_AT: "installedAt", ACTIVATED_AT: "activatedAt",
};

export interface EffectiveDateInput {
  soldAt?: string | null;
  qualifiedAt?: string | null;
  installedAt?: string | null;
  activatedAt?: string | null;
}

export interface EffectiveDatePolicy {
  /** The basis this sale is placed by — its frozen snapshot, not live config. */
  basis: QualificationBasis;
  correctionWindowDays: number;
  /**
   * Server-stamped receipt time. PRESENT means the timestamps came from an
   * untrusted clock (an HTTP caller, a device, an import) and are clamped into
   * `[received − correctionWindowDays, received]`. ABSENT means a trusted
   * in-process caller booking a known-good historical date (the boot backfill,
   * a test fixture) and nothing is clamped. This is the only trust boundary in
   * the module, and it is the caller's job to stamp it — a request handler must
   * never let the request body supply it.
   */
  serverReceivedAt?: string | null;
}

export type ClampReason = "BEFORE_CORRECTION_WINDOW" | "AFTER_SERVER_RECEIPT" | "UNPARSEABLE";

export interface ClampRecord {
  field: "soldAt" | "qualifiedAt" | "installedAt" | "activatedAt";
  requested: string;
  applied: string;
  reason: ClampReason;
  /** True when this field is the one that decides the pay week. */
  isBasisField: boolean;
}

export interface EffectiveDateResult {
  /** The values that may actually be written. */
  applied: Required<EffectiveDateInput>;
  /** The instant that places this sale in a pay week, after clamping. */
  basisTs: string | null;
  /** Every value that was moved, and why. Empty on a clean write. */
  clamps: ClampRecord[];
  /** True when any clamp moved the BASIS field — i.e. the pay week changed. */
  payWeekMoved: boolean;
}

const ms = (v: string | null | undefined): number => (v == null ? NaN : Date.parse(v));

/**
 * Resolve every commission-relevant timestamp against the org's correction
 * window.
 *
 * All four are clamped, not just `soldAt`: the pay week is decided by
 * `BASIS_FIELD[basis]`, so clamping one field and passing the others through
 * leaves the field that actually places the money caller-controlled — which is
 * precisely the exploit that made a 4-sale week re-price as a 19-sale top-tier
 * week.
 */
export function resolveEffectiveDates(
  input: EffectiveDateInput,
  policy: EffectiveDatePolicy,
): EffectiveDateResult {
  const clamps: ClampRecord[] = [];
  const basisField = BASIS_FIELD[policy.basis];
  const receivedMs = ms(policy.serverReceivedAt);
  const trusted = policy.serverReceivedAt == null || !Number.isFinite(receivedMs);
  const floorMs = receivedMs - Math.max(0, policy.correctionWindowDays) * 86_400_000;

  const resolve = (field: ClampRecord["field"], raw: string | null | undefined): string | null => {
    if (raw == null) return null;
    if (trusted) return raw;
    const rawMs = ms(raw);
    if (!Number.isFinite(rawMs)) {
      const applied = new Date(receivedMs).toISOString();
      clamps.push({ field, requested: String(raw), applied, reason: "UNPARSEABLE", isBasisField: field === basisField });
      return applied;
    }
    if (rawMs < floorMs) {
      const applied = new Date(floorMs).toISOString();
      clamps.push({ field, requested: raw, applied, reason: "BEFORE_CORRECTION_WINDOW", isBasisField: field === basisField });
      return applied;
    }
    // BACKDATING is the whole reason this module exists. Removing this branch
    // leaves only the future-date check, which stops nothing an attacker wants:
    // the reproduced exploit pushed `qualifiedAt` 300 days INTO THE PAST to
    // stuff 15 sales into one already-rich week, turning $600 into $5,700.
    // Pinned by tests/unit/commission-effective-date.test.ts.
    if (rawMs < floorMs) {
      const applied = new Date(floorMs).toISOString();
      clamps.push({ field, requested: raw, applied, reason: "BEFORE_CORRECTION_WINDOW", isBasisField: field === basisField });
      return applied;
    }
    if (rawMs > receivedMs) {
      const applied = new Date(receivedMs).toISOString();
      clamps.push({ field, requested: raw, applied, reason: "AFTER_SERVER_RECEIPT", isBasisField: field === basisField });
      return applied;
    }
    return raw;
  };

  const applied = {
    soldAt: resolve("soldAt", input.soldAt),
    qualifiedAt: resolve("qualifiedAt", input.qualifiedAt),
    installedAt: resolve("installedAt", input.installedAt),
    activatedAt: resolve("activatedAt", input.activatedAt),
  } as Required<EffectiveDateInput>;

  return {
    applied,
    // sold_at is the documented last resort, matching the COALESCE every ledger
    // query uses to place a sale whose basis column is not stamped yet.
    basisTs: (applied[basisField] as string | null) ?? applied.soldAt ?? null,
    clamps,
    payWeekMoved: clamps.some(c => c.isBasisField),
  };
}
