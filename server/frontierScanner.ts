// ── Frontier fiber live availability scanner ─────────────────────────────────
// Second carrier alongside Kinetic. Reverse-engineered from frontier.com's own
// buy flow (verified live through the Decodo transport, 2026-07-19):
//
//   1) GET  /ftrcart-ol/api/v2/serviceability/predictive?address=<query>
//      → address candidates with addressKey, inFootprint, lat/lng, env,
//        controlNumber. inFootprint=false means outside Frontier territory.
//   2) POST /ftrcart-ol/api/v3/serviceability
//      headers: x-write-key (static, from the public ftr-buy bundle),
//               x-client-session-id + ftrCartClientId (fresh UUIDs per check),
//               x-user-id: pegdgtsale, x-affiliate-id: 910000
//      body: { address: {addressKey, parentKey, address, address2, city, state,
//              postalCode, zip, zip4, env, controlNumber, isParent, inFootprint},
//              isVerizonIncluded: true, rawUserString }
//      → plantType (COPPER | OVERLAY | NO_TERMINAL | FIBER), techAvailable
//        (FIBER | COPPER | SMARTVOICE | NONE), isBroadbandEligible,
//        isFutureFiberEligible, fiberBuildOutStatus, fiberModernization,
//        addressHasExistingService (the billing analog), redirect.reason
//        (VZ_ELIGIBLE = Verizon-sold territory → no Frontier service).
//
// LEAD RULE (mirrors the Kinetic NEW FIBER + billing N contract so the whole
// downstream pipeline — projector, Field Map, calling queue — fires unchanged):
//   techAvailable === "FIBER" && !addressHasExistingService
//     → fiberStatus "new_fiber", segment "NEW FIBER", billing "N"  (RED lead)
//   fiber && existing service
//     → "new_fiber" + billing "Y"  (Coming Soon watch / NOW_ACTIVE flip)
//   isFutureFiberEligible || fiberBuildOutStatus
//     → coming soon signal (billing "Y" watch)
//   plantType COPPER → "copper" (copper→fiber upgrade pool)
//   NO_TERMINAL / not in footprint / VZ redirect → "no_service"
//   ANY transport/HTTP error → blocked + session rotation, never a no-service.
//
// Result contract is identical to scanner.ts's ScanResult so scanEngine,
// freshFiberProjector, and the transitions feed consume it untouched; only
// `carrier: "frontier"` distinguishes it.

import crypto from "node:crypto";
import { proxyFetch, rotateProxySession, getProxySessionId } from "./proxy-fetch";
import { structuredLog } from "./structuredLog";
import type { ScanResult } from "./scanner";

const FRONTIER_API = "https://frontier.com/ftrcart-ol/api";
// Public web client credential shipped in frontier.com's own ftr-buy bundle
// (same posture as the Kinetic web Basic credential) — overridable via env.
const FRONTIER_WRITE_KEY = process.env.FRONTIER_WRITE_KEY?.trim() || "wk_2dykKTapYBcUW0zgKOI5V1jyDY4";
const FRONTIER_AFFILIATE = process.env.FRONTIER_AFFILIATE_ID?.trim() || "910000";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

interface FrontierPrediction {
  addressKey: string;
  parentKey?: string;
  address: { addressLine1: string; addressLine2?: string; city: string; stateProvince: string; zipCode: string };
  latitude?: number; longitude?: number;
  isParent?: boolean; inFootprint?: boolean;
  environment?: string; controlNumber?: string;
}

interface FrontierServiceability {
  success?: boolean;
  errorMessage?: string;
  redirect?: { reason?: string } | null;
  plantType?: string;
  techAvailable?: string;
  isBroadbandEligible?: boolean;
  isFutureFiberEligible?: boolean;
  fiberBuildOutStatus?: string;
  fiberModernization?: boolean;
  addressHasExistingService?: boolean;
  offerType?: string;
}

function baseResult(address: string, city: string, state: string, zip: string): ScanResult {
  return {
    address, city, state, zip, lat: null, lng: null,
    fiberStatus: "unknown", isNewFiber: false, isTenured: false, fiberAvailable: false,
    maxDownloadKbps: null, maxDownloadMbps: null, speedTier: null,
    techType: null, chipSetType: null, placement: null, maxQual: null,
    competitorName: null, competitorSpeedMbps: null, competitorTech: null, inCompetitorArea: false,
    addressCatalogDate: null, householdSegmentType: null, billingStatus: null,
    exchangeId: null, dfAddressId: null, accessId: null, serviceKey: null,
    confidence: "LOW", apiSource: "failed", blocked: false, notes: "",
    leadTag: null, leadScore: 0,
  };
}

/** Classify a conclusive Frontier serviceability response into the shared
 * ScanResult contract. Exported for tests. */
export function classifyFrontierResponse(
  base: ScanResult,
  svc: FrontierServiceability,
  pred: FrontierPrediction,
): ScanResult {
  base.apiSource = "kinetic_live"; // live provider answer (contract name shared with Kinetic)
  base.confidence = "HIGH";
  base.dfAddressId = pred.addressKey;
  if (pred.latitude != null) base.lat = pred.latitude;
  if (pred.longitude != null) base.lng = pred.longitude;

  const redirectReason = String(svc.redirect?.reason ?? "");
  if (/VZ_ELIGIBLE|VERIZON/i.test(redirectReason)) {
    base.fiberStatus = "no_service";
    base.notes = `Verizon-sold territory (${redirectReason}) — not Frontier fiber`;
    return base;
  }
  const tech = String(svc.techAvailable ?? "").toUpperCase();
  const plant = String(svc.plantType ?? "").toUpperCase();
  const fiber = tech === "FIBER" || plant === "FIBER" || plant === "OVERLAY";
  const existing = svc.addressHasExistingService === true;

  if (fiber) {
    base.fiberAvailable = true;
    base.isNewFiber = true;
    base.fiberStatus = "new_fiber";
    base.techType = "FIBER";
    base.householdSegmentType = "NEW FIBER";
    base.billingStatus = existing ? "Y" : "N";
    base.notes = existing
      ? `Frontier fiber live (plant ${plant || tech}) — existing service on address (watch)`
      : `Frontier fiber live (plant ${plant || tech}) with NO existing service — fresh lead`;
    return base;
  }
  if (svc.isFutureFiberEligible || (svc.fiberBuildOutStatus ?? "").length > 0) {
    // Frontier fiber is being built here — the Coming Soon analog. billing "Y"
    // + isNewFiber keeps it in the monitoring inventory; the watchlist worker
    // promotes it the moment a recheck shows orderable fiber with no service.
    base.isNewFiber = true;
    base.fiberStatus = "new_fiber";
    base.householdSegmentType = "NEW FIBER";
    base.billingStatus = "Y";
    base.notes = `Frontier fiber building (futureFiber=${!!svc.isFutureFiberEligible} buildOut=${svc.fiberBuildOutStatus || "?"}) — coming soon watch`;
    return base;
  }
  if (plant === "COPPER" || tech === "COPPER" || tech === "SMARTVOICE") {
    base.fiberStatus = "copper";
    base.notes = `Frontier copper plant (${plant || tech}) — copper→fiber upgrade pool`;
    return base;
  }
  // NO_TERMINAL / NONE / no-sam-record — definitively unserved.
  base.fiberStatus = "no_service";
  base.notes = `Not Frontier-serviceable (plant=${plant || "?"}, tech=${tech || "?"})`;
  return base;
}

export async function scanFrontierAddress(
  address: string, city: string, state: string, zip: string,
): Promise<ScanResult> {
  const base = baseResult(address, city, state, zip);
  const sessionId = crypto.randomUUID();
  const clientId = crypto.randomUUID();
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "x-client-session-id": sessionId,
    "x-user-id": "pegdgtsale",
    "ftrCartClientId": clientId,
    "User-Agent": UA,
  };

  // ── Step 1: predictive address resolution ─────────────────────────────────
  const query = `${address}, ${city}, ${state}${zip ? ` ${zip}` : ""}`;
  let preds: FrontierPrediction[];
  try {
    const res = await proxyFetch(
      `${FRONTIER_API}/v2/serviceability/predictive?address=${encodeURIComponent(query)}`,
      { method: "GET", headers, signal: AbortSignal.timeout(6_000) },
    );
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500) {
      void rotateProxySession(`frontier predictive ${res.status}`);
      base.blocked = true;
      base.notes = `Frontier predictive ${res.status} — Decodo session rotated, address requeued`;
      return base;
    }
    if (!res.ok) {
      void rotateProxySession(`frontier predictive ${res.status}`);
      base.blocked = true;
      base.notes = `Frontier predictive ${res.status} — session rotated, requeued`;
      return base;
    }
    preds = (await res.json()) as FrontierPrediction[];
  } catch (err: any) {
    base.blocked = true;
    base.notes = `Frontier predictive transport error — ${String(err?.message ?? err).slice(0, 100)} (requeued)`;
    return base;
  }
  if (!Array.isArray(preds) || preds.length === 0) {
    base.fiberStatus = "no_service";
    base.apiSource = "kinetic_live";
    base.confidence = "HIGH";
    base.notes = "Address not in Frontier fabric (no predictive match)";
    return base;
  }
  // Prefer an in-footprint match in the same city; else any in-footprint; else
  // out-of-footprint = definitively unserved by Frontier.
  const inFoot = preds.filter((p) => p.inFootprint);
  const pred = inFoot.find((p) => p.address.city.toLowerCase() === city.toLowerCase()) ?? inFoot[0];
  if (!pred) {
    base.fiberStatus = "no_service";
    base.apiSource = "kinetic_live";
    base.confidence = "HIGH";
    base.notes = "Outside Frontier footprint";
    return base;
  }

  // ── Step 2: serviceability qualification ──────────────────────────────────
  const a = pred.address;
  const zipCode = a.zipCode ?? zip ?? "";
  const body = {
    address: {
      addressKey: pred.addressKey,
      parentKey: pred.parentKey ?? "",
      address: a.addressLine1,
      address2: a.addressLine2 ?? "",
      city: a.city,
      state: a.stateProvince,
      postalCode: zipCode.slice(0, 5),
      zip: zipCode.slice(0, 5),
      zip4: zipCode.includes("-") ? zipCode.split("-")[1] : "",
      env: pred.environment ?? "",
      controlNumber: pred.controlNumber ?? "",
      isParent: pred.isParent ?? false,
      inFootprint: true,
    },
    isVerizonIncluded: true,
    rawUserString: query,
  };
  let svc: FrontierServiceability;
  try {
    const res = await proxyFetch(`${FRONTIER_API}/v3/serviceability`, {
      method: "POST",
      headers: {
        ...headers,
        "x-write-key": FRONTIER_WRITE_KEY,
        "x-affiliate-id": FRONTIER_AFFILIATE,
        "Origin": "https://frontier.com",
        "Referer": "https://frontier.com/ftr-buy/",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6_000),
    });
    if (res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500 || !res.ok) {
      void rotateProxySession(`frontier serviceability ${res.status}`);
      base.blocked = true;
      base.notes = `Frontier serviceability ${res.status} — Decodo session rotated, address requeued`;
      if (res.status === 403) structuredLog("scan.provider.access_denied", { status: 403, source: "frontier" }, "warn");
      return base;
    }
    svc = (await res.json()) as FrontierServiceability;
  } catch (err: any) {
    base.blocked = true;
    base.notes = `Frontier serviceability transport error — ${String(err?.message ?? err).slice(0, 100)} (requeued)`;
    return base;
  }
  if (svc.success === false) {
    // Frontier's own error envelope (FTRError …) — a transient non-answer, not
    // a serviceability verdict. Rotate and requeue; never recorded as no-service.
    void rotateProxySession("frontier svc success=false");
    base.blocked = true;
    base.notes = `Frontier error envelope (${String(svc.errorMessage ?? "unknown").slice(0, 90)}) — session rotated, requeued`;
    return base;
  }
  base.rawResponse = svc;
  const out = classifyFrontierResponse(base, svc, pred);
  structuredLog("scan.frontier.classified", {
    carrier: "frontier", status: out.fiberStatus, billing: out.billingStatus,
    plant: svc.plantType, tech: svc.techAvailable, session: getProxySessionId(),
  });
  return out;
}
