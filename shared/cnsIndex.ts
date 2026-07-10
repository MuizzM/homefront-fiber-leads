// ── City ↔ CNS index — learn where a city lives in Kinetic's control-number
// space, so we can discover FRESH addresses for it WITHOUT any Mapbox geocoding.
//
// Every address Kinetic returns carries a df id of the form ENV + control-number
// (e.g. "MS3062552"). Kinetic hands us the full canonical address on every probe,
// so once we've scanned a city its addresses accumulate in the pool complete with
// their df ids. This module turns that accumulated evidence into a targeting plan:
// group a city's known control numbers into contiguous BANDS, then probe the
// FRONTIER just past each band (where Kinetic numbers a city's newest builds) plus
// unprobed GAPS inside bands (city addresses we simply haven't checked yet).
//
// Robustness: we ONLY ever propose probes adjacent to control numbers where the
// city has DEMONSTRABLY appeared. If Kinetic assigns numbers with geographic
// locality (fiber builds go exchange-by-exchange, so this largely holds), frontier
// probing finds that city's new builds cheaply. If locality is weak, the plan is
// still no worse than a blind sweep and every probe grows the pool for free — and
// the nightly global-frontier sweep (a separate engine) already catches globally-
// numbered new builds for every city. Pure + deterministic + fully unit-tested.

export interface DfParsed { env: string; cns: number; pad: number }

// Parse a Kinetic df id into a region/type bucket (`env`) + a varying numeric part
// (`cns`) we can range/enumerate on. Handles BOTH real formats:
//   A. ENV-prefixed control number — "MS3062552" (FiberFocus-style).
//   B. Kinetic's real 22-digit numeric id — "8000000000000223381034", where the
//      high-order digits are a constant region/type prefix and the low-order ~9
//      digits are the per-address part. We split so `cns` stays a safe integer.
// `pad` is the tail width so dfIdFor() can round-trip. Returns null for anything
// unparseable (those rows still work as ordinary pool addresses).
export function parseDfAddressId(df: string | null | undefined): DfParsed | null {
  if (!df) return null;
  const s = String(df).trim();
  const m = /^([A-Za-z]+)(\d+)$/.exec(s);            // format A
  if (m) {
    const cns = parseInt(m[2], 10);
    if (Number.isFinite(cns) && cns > 0) return { env: m[1].toUpperCase(), cns, pad: m[2].length };
  }
  if (/^\d{13,}$/.test(s)) {                          // format B (long numeric)
    const TAIL = 9;                                   // 9 digits → up to ~1e9, safe int
    const env = s.slice(0, -TAIL) || "0";
    const cns = parseInt(s.slice(-TAIL), 10);
    if (Number.isFinite(cns) && cns > 0) return { env, cns, pad: TAIL };
  }
  return null;
}

export interface CnsBand { minCns: number; maxCns: number; count: number }

export interface CityCnsCoverage {
  env: string;
  city: string;        // normalized (trim+lower) key
  state: string;       // normalized
  displayCity: string; // first-seen original casing, for UI
  knownCount: number;  // addresses in this city with a parseable df id
  newFiberCount: number;
  minCns: number;
  maxCns: number;
  pad: number;         // tail width for reconstructing df ids (dfIdFor)
  bands: CnsBand[];    // contiguous-ish clusters (split on gaps > bandGap)
}

export interface CoverageRow {
  dfAddressId: string | null | undefined;
  city: string | null | undefined;
  state: string | null | undefined;
  isNewFiber?: boolean;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

// Build per-(env, city, state) coverage from pool/lead rows. Rows without a
// parseable df id or without a city are ignored (they can't be targeted by CNS).
export function buildCityCoverage(rows: CoverageRow[], opts: { bandGap?: number } = {}): CityCnsCoverage[] {
  const bandGap = opts.bandGap ?? 400;
  // key = env|city|state → { displayCity, cnsList, newFiber }
  const groups = new Map<string, { env: string; pad: number; city: string; state: string; displayCity: string; cns: number[]; newFiber: number }>();
  for (const r of rows) {
    const parsed = parseDfAddressId(r.dfAddressId);
    if (!parsed) continue;
    const city = norm(r.city);
    if (!city) continue;
    const state = norm(r.state);
    const key = `${parsed.env}|${city}|${state}`;
    let g = groups.get(key);
    if (!g) { g = { env: parsed.env, pad: parsed.pad, city, state, displayCity: (r.city ?? "").trim(), cns: [], newFiber: 0 }; groups.set(key, g); }
    g.cns.push(parsed.cns);
    if (r.isNewFiber) g.newFiber++;
  }
  const out: CityCnsCoverage[] = [];
  for (const g of groups.values()) {
    const sorted = Array.from(new Set(g.cns)).sort((a, b) => a - b);
    const bands: CnsBand[] = [];
    let start = sorted[0], prev = sorted[0], count = 1;
    for (let i = 1; i < sorted.length; i++) {
      const c = sorted[i];
      if (c - prev > bandGap) { bands.push({ minCns: start, maxCns: prev, count }); start = c; count = 1; }
      else count++;
      prev = c;
    }
    bands.push({ minCns: start, maxCns: prev, count });
    out.push({
      env: g.env, city: g.city, state: g.state, displayCity: g.displayCity,
      knownCount: sorted.length, newFiberCount: g.newFiber,
      minCns: sorted[0], maxCns: prev, pad: g.pad, bands,
    });
  }
  // Biggest known footprint first (most-established cities are the safest to deepen).
  return out.sort((a, b) => b.knownCount - a.knownCount);
}

export interface ProbePlanOpts {
  budget: number;            // max control numbers to propose
  frontierSpan?: number;     // how far past each band max to probe (newest builds)
  gapCapPerBand?: number;    // max intra-band gap fills per band
  envMaxCns?: number;        // don't propose control numbers beyond this (unassigned)
  overshoot?: number;        // allow probing this far past envMaxCns for brand-new builds
}

export interface ProbePlan {
  env: string;
  frontier: number[]; // control numbers just past band maxima — where new builds land
  gaps: number[];     // unprobed control numbers inside known bands
  probes: number[];   // ordered union (frontier-first), deduped, capped to budget
  reason: string;
}

// Turn a city's coverage into an ordered list of control numbers to probe. `known`
// is the set of control numbers we've ALREADY probed in this env (any city) so we
// never re-probe. Frontier comes first (freshest), then gap-fill, capped to budget.
export function planCityProbe(coverage: CityCnsCoverage, known: Set<number>, opts: ProbePlanOpts): ProbePlan {
  const frontierSpan = Math.max(1, opts.frontierSpan ?? 1500);
  const gapCapPerBand = Math.max(0, opts.gapCapPerBand ?? 400);
  const overshoot = Math.max(0, opts.overshoot ?? 2000);
  // Ceiling: never probe beyond the highest plausibly-assigned control number.
  const ceiling = (opts.envMaxCns ?? coverage.maxCns) + overshoot;
  const budget = Math.max(0, Math.floor(opts.budget));

  // Build per-band candidate lists, biggest band first. We INTERLEAVE across bands
  // (round-robin) rather than draining one band's whole frontier first — so a small
  // budget still probes EVERY band's frontier, and one dead band can't starve the
  // others. Frontier (newest builds) is exhausted before gap-fill (existing area).
  const bandsBySize = [...coverage.bands].sort((a, b) => b.count - a.count);
  const claimed = new Set<number>();
  const frontierByBand = bandsBySize.map(band => {
    const list: number[] = [];
    for (let c = band.maxCns + 1; c <= band.maxCns + frontierSpan && c <= ceiling; c++) {
      if (known.has(c) || claimed.has(c)) continue;
      claimed.add(c); list.push(c);
    }
    return list;
  });
  const gapByBand = coverage.bands.map(band => {
    const list: number[] = [];
    for (let c = band.minCns; c <= band.maxCns && list.length < gapCapPerBand; c++) {
      if (known.has(c) || claimed.has(c)) continue;
      claimed.add(c); list.push(c);
    }
    return list;
  });

  const roundRobin = (lists: number[][]): number[] => {
    const out: number[] = [];
    const max = Math.max(0, ...lists.map(l => l.length));
    for (let i = 0; i < max; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
    return out;
  };
  const frontier = roundRobin(frontierByBand);
  const gaps = roundRobin(gapByBand);

  const probes: number[] = [];
  for (const c of [...frontier, ...gaps]) {
    probes.push(c);
    if (probes.length >= budget) break;
  }
  return {
    env: coverage.env, frontier, gaps, probes,
    reason: `${coverage.displayCity}: ${coverage.knownCount} known across ${coverage.bands.length} band(s); ` +
            `${frontier.length} frontier + ${gaps.length} gap candidate(s) → ${probes.length} probes`,
  };
}

// Reconstruct a df id from its env bucket + numeric part. `pad` is the tail width
// captured at parse time (7 for the ENV+CNS format, 9 for the long-numeric one),
// so round-tripping a real Kinetic id yields the exact original string.
export function dfIdFor(env: string, cns: number, pad = 7): string {
  return `${env}${String(cns).padStart(pad, "0")}`;
}

// Canonicalize a Kinetic ALL-CAPS address line to Title Case, matching the
// address-based scanner (server/scanner.ts). Ensures a CNS-discovered row and a
// scanner-discovered row for the SAME house collapse to one pool key rather than
// coexisting as "100 MAIN ST" and "100 Main St".
export function canonicalizeAddress(raw: string | null | undefined): string {
  return (raw ?? "").trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}
