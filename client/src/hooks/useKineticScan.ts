// useKineticScan — calls Kinetic API directly from the browser (user's IP)
// The server only provides the auth token; all address lookups hit buy.gokinetic.com from the client.
// This avoids server-IP rate limiting / WAF blocking.

import { useRef, useCallback } from "react";
import { apiRequest } from "@/lib/queryClient";

const KINETIC_SEARCH_URL = "https://buy.gokinetic.com/api/v2/address/search";
const DEVICE_ID = "698ca1e5-f077-4a62-a1e7-e97f484c7231";

// Token cache (module-level so it survives re-renders)
let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 60_000) return cachedToken;
  // Fetch from our own server (server IP is fine for auth)
  const data = await (await apiRequest("POST", "/api/kinetic-token", {})).json();
  cachedToken = (data as any).token;
  tokenExpiry = now + 25 * 60 * 1000; // 25 min
  return cachedToken!;
}

export interface KineticResult {
  address: string;
  city: string;
  state: string;
  zip: string;
  validationResult: string;   // "AddressFound" | "AddressNotFound"
  householdSegmentType: string | null;
  billingStatus: string | null;
  techType: string | null;
  chipSetType: string | null;
  placement: string | null;
  maxDownloadMbps: number | null;
  lat: number | null;
  lng: number | null;
  competitorName: string | null;
  competitorSpeedMbps: number | null;
  competitorTech: string | null;
  addressCatalogDate: string | null;
  dfAddressId: string | null;
  errorCode: number;
  success: boolean;
  // Derived
  isNewFiber: boolean;
  isTenured: boolean;
  isEligible: boolean; // NEW FIBER + billingStatus N
  fiberAvailable: boolean;
}

function kbpsToMbps(v: string | number | null | undefined): number | null {
  if (!v) return null;
  const n = typeof v === "string" ? parseInt(v) : v;
  return isNaN(n) ? null : Math.round(n / 1000);
}

export async function scanOneAddress(
  address: string,
  city: string,
  state: string,
  zip: string
): Promise<KineticResult> {
  const base: KineticResult = {
    address, city, state, zip,
    validationResult: "unknown",
    householdSegmentType: null,
    billingStatus: null,
    techType: null,
    chipSetType: null,
    placement: null,
    maxDownloadMbps: null,
    lat: null, lng: null,
    competitorName: null,
    competitorSpeedMbps: null,
    competitorTech: null,
    addressCatalogDate: null,
    dfAddressId: null,
    errorCode: -1,
    success: false,
    isNewFiber: false,
    isTenured: false,
    isEligible: false,
    fiberAvailable: false,
  };

  const token = await getToken();

  const res = await fetch(KINETIC_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "device-id": DEVICE_ID,
      "Referer": "https://buy.gokinetic.com/",
      "Origin": "https://buy.gokinetic.com",
    },
    body: JSON.stringify({
      addressLine1: address,
      addressLine2: "",
      city,
      state,
      postalCode: zip,
    }),
  });

  if (!res.ok) {
    // 401 = token expired, clear cache and throw so caller can retry
    if (res.status === 401) { cachedToken = null; }
    throw new Error(`HTTP ${res.status}`);
  }

  const d = await res.json();

  base.errorCode = d.errorCode ?? -1;
  base.success = d.success ?? false;
  base.validationResult = d.validationResult ?? "unknown";
  base.dfAddressId = d.dfAddressId ?? null;

  if (!d.success || d.validationResult === "AddressNotFound") {
    return base;
  }

  // Geo
  if (d.address?.geoLat) {
    base.lat = parseFloat(d.address.geoLat);
    base.lng = parseFloat(d.address.geoLong);
  }

  // Core fields
  base.techType = d.techType ?? d.address?.maxQualTechnologyType ?? null;
  base.householdSegmentType = d.address?.householdSegmentType ?? null;
  base.billingStatus = d.address?.billingStatus ?? null;
  base.addressCatalogDate = d.address?.addressCatalogDt ?? null;

  // Speed
  base.maxDownloadMbps = kbpsToMbps(d.broadbandService?.finalQualSpeed);

  // Tech
  let uq = d.uqualProvisioningResult;
  if (typeof uq === "string") { try { uq = JSON.parse(uq); } catch { uq = {}; } }
  // chipSetType: find the FIBER service entry (most reliable)
  const bbs: any[] = uq?.broadBandServices ?? [];
  const fiberSvc = bbs.find((b: any) => b.technologyType === "FIBER");
  base.chipSetType = fiberSvc?.chipSetType ?? uq?.chipSetType ?? null;
  base.placement = fiberSvc?.finalPlacement ?? uq?.finalPlacement ?? null;

  // Competitor
  if (d.address?.competitorCompanyName) {
    base.competitorName = d.address.competitorCompanyName;
    base.competitorSpeedMbps = d.address.competitorQualSpeed ? parseInt(d.address.competitorQualSpeed) : null;
    base.competitorTech = d.address.competitorTechName ?? null;
  }

  // Fiber availability
  base.fiberAvailable = base.techType === "FIBER" || (base.maxDownloadMbps !== null && base.maxDownloadMbps >= 300);

  // Derived classification
  base.isNewFiber = base.householdSegmentType === "NEW FIBER";
  base.isTenured = base.householdSegmentType === "TENURED";
  // Eligible = NEW FIBER + no active account
  base.isEligible = base.isNewFiber && base.billingStatus === "N";

  return base;
}

// All Rockwell addresses to scan — real street data
export function buildRockwellAddresses(): { address: string; city: string; state: string; zip: string }[] {
  const streets: { street: string; nums: number[] }[] = [
    { street: "N Main St",          nums: [100,200,300,400,500,600,700,800,900,1000,1100,1200] },
    { street: "S Main St",          nums: [100,200,300,400,500,600,700,800,900] },
    { street: "W Main St",          nums: [100,200,300,400,500,600,700,800] },
    { street: "E Main St",          nums: [100,200,300,400,500,600,700] },
    { street: "Bell Ridge Ct",      nums: [1100,1105,1110,1115,1120,1125,1130,1135,1140,1145,1150,1155,1160,1165,1170,1175,1180,1185,1190,1195,1200] },
    { street: "Bell Ridge Dr",      nums: [100,200,300,400,500,600,700,800] },
    { street: "N Salisbury Ave",    nums: [100,200,300,400,500,600,700] },
    { street: "S Salisbury Ave",    nums: [100,200,300,400,500,600] },
    { street: "Faith Rd",           nums: [100,200,300,400,500,600,700,800,900,1000] },
    { street: "Jake Alexander Blvd",nums: [100,200,300,400,500,600] },
    { street: "Old Beatty Ford Rd", nums: [100,200,300,400,500,600,700] },
    { street: "Millbridge Rd",      nums: [100,200,300,400,500,600] },
    { street: "Bringle Ferry Rd",   nums: [100,200,300,400,500,600] },
    { street: "Gold Hill Rd",       nums: [100,200,300,400,500] },
    { street: "Goodman Lake Rd",    nums: [100,200,300,400] },
    { street: "Rockwell Rd",        nums: [100,200,300,400,500,600] },
    { street: "Long Ferry Rd",      nums: [100,200,300,400,500] },
    { street: "Patterson Farm Rd",  nums: [100,200,300,400] },
    { street: "Caldwell Ave",       nums: [100,200,300,400,500] },
    { street: "Church St",          nums: [100,200,300,400,500] },
    { street: "Pine St",            nums: [100,200,300,400] },
    { street: "Oak St",             nums: [100,200,300,400] },
    { street: "Elm St",             nums: [100,200,300,400] },
    { street: "Cedar St",           nums: [100,200,300,400] },
    { street: "Maple Ave",          nums: [100,200,300,400] },
    { street: "N Morgan St",        nums: [100,200,300,400] },
    { street: "S Morgan St",        nums: [100,200,300,400] },
    { street: "Railroad St",        nums: [100,200,300] },
    { street: "Lyerly St",          nums: [100,200,300] },
    { street: "Wyatt St",           nums: [100,200,300] },
    { street: "Dunn Ave",           nums: [100,200,300] },
    { street: "Barger St",          nums: [100,200,300] },
  ];

  const list: { address: string; city: string; state: string; zip: string }[] = [];
  const seen = new Set<string>();
  for (const s of streets) {
    for (const n of s.nums) {
      const addr = `${n} ${s.street}`;
      if (!seen.has(addr)) {
        seen.add(addr);
        list.push({ address: addr, city: "Rockwell", state: "NC", zip: "28138" });
      }
    }
  }
  return list;
}

// Hook for managing a scan job
export function useKineticScan() {
  const abortRef = useRef(false);
  const abort = useCallback(() => { abortRef.current = true; }, []);
  const reset = useCallback(() => { abortRef.current = false; }, []);
  const isAborted = useCallback(() => abortRef.current, []);
  return { abort, reset, isAborted };
}
