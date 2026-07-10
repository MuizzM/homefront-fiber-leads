// ── Provider adapter boundary ─────────────────────────────────────────────────
// Monitoring logic must NOT know how credentials, transport, or provider
// payloads work. Everything that talks to a provider goes through this seam:
//   - FixtureProvider   — deterministic, LABELLED, zero network. Tests + demos.
//   - KineticProvider   — wraps the EXISTING authorized KFS integration
//                         (server/scanner.ts). Live-gated OFF by default; it is
//                         the ONLY real provider path — there is deliberately no
//                         fallback to the public Kinetic consumer form.
// A ProviderObservation separates provider-observed time from HomeFront
// ingestion time, raw from normalized, and carries an evidence hash + schema
// version + conclusive flag so the truth model can trust it.
import crypto from "crypto";
import { normalizeSegment, type CanonicalState } from "@shared/transition";

export interface AuthorizedTarget {
  id: number;
  tenantId: number;
  provider: string;
  providerTargetKey: string;   // e.g. an authorized dfAddressId
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}

export interface ProviderObservation {
  provider: string;
  providerTargetKey: string;
  providerObservedAtMs: number;   // provider's "as of" (≈ request time when the API gives none)
  ingestedAtMs: number;           // when HomeFront received it
  rawSegment: string | null;      // untouched provider segment string
  canonical: CanonicalState;      // normalized
  recognized: boolean;            // false → schema drift
  billingStatus: string | null;
  conclusive: boolean;            // false = failure/timeout/challenge/heuristic → no state change
  failureKind: "timeout" | "rate_limited" | "auth" | "challenge" | "server" | "malformed" | "heuristic" | null;
  schemaVersion: number;
  evidenceHash: string;           // sha256 of the raw evidence — tamper-evidence, no raw dump
  responseReference?: string | null; // pointer to the evidence store (fiber_checks)
  isFixture: boolean;             // TRUE → must never mix with production evidence
  latencyMs: number;
}

export interface ProviderHealth {
  provider: string;
  ok: boolean;
  circuitOpen: boolean;
  lastError: string | null;
  successRate: number | null;
}

export interface AvailabilityProvider {
  readonly name: string;
  readonly isFixture: boolean;
  check(target: AuthorizedTarget, signal?: AbortSignal): Promise<ProviderObservation>;
  health(): Promise<ProviderHealth>;
}

function sha256(s: string): string { return crypto.createHash("sha256").update(s).digest("hex"); }

// ── Fixture provider — deterministic, labelled, NO network ────────────────────
// Scripted per provider_target_key: an ordered list of segment strings (or a
// { fail } marker). Each check() consumes the next entry (repeating the last).
// Every observation is stamped isFixture:true so it can never be mistaken for
// production evidence.
export interface FixtureStep {
  segment?: string;              // raw provider segment (e.g. "NEW FIBER", "COPPER")
  billingStatus?: string | null;
  fail?: "timeout" | "rate_limited" | "auth" | "challenge" | "server" | "malformed" | "heuristic";
  observedAtMs?: number;         // override provider-observed time (for window tests)
}
export class FixtureProvider implements AvailabilityProvider {
  readonly name = "fixture";
  readonly isFixture = true;
  private cursor = new Map<string, number>();
  constructor(private script: Record<string, FixtureStep[]>, private clock: () => number = () => 0) {}

  async check(target: AuthorizedTarget): Promise<ProviderObservation> {
    const steps = this.script[target.providerTargetKey] ?? [];
    const i = this.cursor.get(target.providerTargetKey) ?? 0;
    const step = steps[Math.min(i, steps.length - 1)] ?? { fail: "server" as const };
    this.cursor.set(target.providerTargetKey, i + 1);
    const now = step.observedAtMs ?? this.clock();
    if (step.fail) {
      return {
        provider: target.provider, providerTargetKey: target.providerTargetKey,
        providerObservedAtMs: now, ingestedAtMs: now,
        rawSegment: null, canonical: "INCONCLUSIVE", recognized: false, billingStatus: null,
        conclusive: false, failureKind: step.fail, schemaVersion: 1,
        evidenceHash: sha256(`fixture-fail:${step.fail}:${now}`), isFixture: true, latencyMs: 0,
      };
    }
    const norm = normalizeSegment(step.segment ?? null);
    return {
      provider: target.provider, providerTargetKey: target.providerTargetKey,
      providerObservedAtMs: now, ingestedAtMs: now,
      rawSegment: step.segment ?? null, canonical: norm.canonical, recognized: norm.recognized,
      billingStatus: step.billingStatus ?? null,
      conclusive: true, failureKind: null, schemaVersion: 1,
      evidenceHash: sha256(`fixture:${step.segment}:${step.billingStatus}:${now}`), isFixture: true, latencyMs: 0,
    };
  }
  async health(): Promise<ProviderHealth> {
    return { provider: "fixture", ok: true, circuitOpen: false, lastError: null, successRate: 1 };
  }
}

// ── Kinetic provider — wraps the EXISTING authorized integration ──────────────
// This is the only real provider path. It calls server/scanner.scanAddress
// (the authorized KFS v2 integration through the approved Decodo transport). It
// NEVER touches the public consumer form and has NO fallback to it. It is
// LIVE-GATED: check() throws unless RADAR_LIVE === "true", so nothing spends
// proxy money by accident. A heuristic/knowledge-base result is treated as
// INCONCLUSIVE (not a real provider observation — no fabrication).
export class KineticProvider implements AvailabilityProvider {
  readonly name = "kinetic";
  readonly isFixture = false;
  private lastError: string | null = null;
  private circuitOpen = false;
  // Injected so tests never import the live scanner. Defaults to the real one.
  constructor(private scanAddress?: (address: string, city: string, state: string, zip: string) => Promise<any>) {}

  async check(target: AuthorizedTarget, _signal?: AbortSignal): Promise<ProviderObservation> {
    if (process.env.RADAR_LIVE !== "true") {
      throw new Error("RADAR_LIVE_DISABLED: live Kinetic monitoring is gated off. Set RADAR_LIVE=true with a valid authorized source to enable.");
    }
    const t0 = Date.now();
    const scan = this.scanAddress ?? (await import("./scanner")).scanAddress;
    let result: any;
    try {
      result = await scan(target.address ?? "", target.city ?? "", target.state ?? "NC", target.zip ?? "");
    } catch (err: any) {
      this.lastError = String(err?.message ?? err);
      return this.failObs(target, "server", Date.now() - t0);
    }
    const latencyMs = Date.now() - t0;
    // A failed OR heuristic (knowledge_base) result is NOT a conclusive provider
    // observation — it carries no availability signal and must never change state.
    if (result?.apiSource === "failed") return this.failObs(target, classifyFailure(result), latencyMs);
    if (result?.apiSource === "knowledge_base") return this.failObs(target, "heuristic", latencyMs);

    const data = result?.rawResponse;
    const raw = result?.householdSegmentType ?? null;
    const norm = normalizeSegment(raw);
    // A genuine, CONCLUSIVE answer is one of exactly two things:
    //   (a) a RECOGNIZED availability segment, or
    //   (b) an explicit "address not in the fabric" (validationResult=AddressNotFound)
    //       → a true NO_SERVICE, the legitimate non-New prior state Radar needs.
    // Anything else — a soft `success:false`, a null/empty/unrecognized segment
    // with no explicit not-found — is a NON-ANSWER (a timeout is not a "no"). It
    // must be inconclusive so it can never flip fiber status.
    const explicitNotServiceable = data?.validationResult === "AddressNotFound";
    if (!norm.recognized && !explicitNotServiceable) {
      return this.failObs(target, "malformed", latencyMs);
    }
    const canonical: CanonicalState = norm.recognized ? norm.canonical : "NO_SERVICE";
    const now = Date.now();
    return {
      provider: "kinetic", providerTargetKey: target.providerTargetKey,
      providerObservedAtMs: now, ingestedAtMs: now,       // Kinetic gives no separate 'as-of' time
      rawSegment: raw ?? (explicitNotServiceable ? "NO SERVICE" : null),
      canonical, recognized: true,                        // both (a) and (b) are genuine conclusions
      billingStatus: result?.billingStatus ?? null,
      conclusive: true, failureKind: null, schemaVersion: 1,
      evidenceHash: sha256(JSON.stringify(data ?? result ?? {})),
      responseReference: result?.dfAddressId ?? null,
      isFixture: false, latencyMs,
    };
  }

  private failObs(target: AuthorizedTarget, kind: ProviderObservation["failureKind"], latencyMs = 0): ProviderObservation {
    const now = Date.now();
    return {
      provider: "kinetic", providerTargetKey: target.providerTargetKey,
      providerObservedAtMs: now, ingestedAtMs: now,
      rawSegment: null, canonical: "INCONCLUSIVE", recognized: false, billingStatus: null,
      conclusive: false, failureKind: kind, schemaVersion: 1,
      evidenceHash: sha256(`kinetic-fail:${kind}:${now}`), isFixture: false, latencyMs,
    };
  }

  async health(): Promise<ProviderHealth> {
    return { provider: "kinetic", ok: !this.circuitOpen, circuitOpen: this.circuitOpen, lastError: this.lastError, successRate: null };
  }
}

// Map a failed scanner result note to a coarse failure kind for backoff policy.
function classifyFailure(result: any): ProviderObservation["failureKind"] {
  const note = String(result?.notes ?? "").toLowerCase();
  if (note.includes("429")) return "rate_limited";
  if (note.includes("401") || note.includes("403") || note.includes("token")) return "auth";
  if (note.includes("timeout") || note.includes("timed out")) return "timeout";
  if (note.includes("challenge") || note.includes("captcha") || note.includes("cloudflare")) return "challenge";
  return "server";
}
