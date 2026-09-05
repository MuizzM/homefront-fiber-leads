// TODO: verify usage: this tested street-scoring model has no production caller; retain its documented scoring rules until its integration is confirmed.
// ── Street opportunity: what a rep should walk, and why ──────────────────────
//
// A ranked route list that survives the objections an audit of the naive
// version raised. Each rule below exists because the obvious approach was
// measured and found wrong, so the reasons are recorded next to the code.
//
//  1. RANK BY DOORS, NOT BY PENETRATION RATE. Take-up on new fiber is 0.6-4.6%
//     in every market measured, so a "least penetrated" ranking sorts streets
//     by how recently the fiber was lit. Nine of eleven headline streets from
//     the rate-ranked version were 100% newly-built, and none of their 0.0%
//     figures was distinguishable from the base rate.
//
//  2. BILLING 'A' IS NOT PROOF OF A CUSTOMER, BUT 'N' IS PROOF OF NONE.
//     Of 1,671 doors coded 'A', only 56 carry provider_billing_active_account;
//     where the provider's own words exist, 'A' means UNKNOWN 84% of the time.
//     'N' is never once contradicted: on 2,994 tenured doors with billing N the
//     provider said "no active account" 600 times and "active" zero times. So
//     `taken` is an upper bound and `confirmedOpen` is the number to trust.
//
//  3. TENURED IS NOT A CUSTOMER. It means the carrier has plant and history at
//     the address, not that anyone pays. 6,574 tenured doors carry no active
//     billing. Folding tenured into "taken" would have hidden them.
//
//  4. DEDUPLICATE. 10.9% of scanned rows are the same physical door imported
//     twice under two spellings (Concord 16.3%, Broadway 15.4%). They geocode
//     separately, so a coordinate test misses them; normalise the address.
//
//  5. A STREET IS NOT A CITY'S PROPERTY. Irish Potato Rd is one 60-door road
//     split across Kannapolis and Concord; Sapp Rd spans three cities. Merging
//     is opt-in because "Main St" in two towns is genuinely two roads.
//
//  6. SUBTRACT WHAT IS ALREADY DISPATCHED. This was the finding that inverted
//     the whole answer: every street the naive version recommended was already
//     100% assigned to a rep and un-knocked, while 3,009 open doors had no lead
//     record at all. A targeting list that returns dispatched inventory is
//     telling you to do what you have already done.
//
//  7. WALKABILITY DECIDES ORDER AMONG EQUALS. 89 doors spread over 13 km of
//     rural road is a drive route; 30 doors at 20 m spacing is an hour. Rank by
//     opportunities per hour of rep time, not by raw count.
//
//  8. FLAG THE TOO-DENSE. A median gap under ~12 m is an apartment building or
//     a coordinate collapse, not a dense street, and it will otherwise top any
//     density ranking.
//
//  9. SAY HOW OLD AND HOW COMPLETE. A verdict is a measurement with a date, and
//     a street whose scanned half is 40% of its doors is a fragment.
import { rawDb } from "./db";

export interface StreetOpportunity {
  city: string;
  street: string;
  /** Distinct physical doors with a conclusive answer. */
  scanned: number;
  /** Doors on the street we have never asked about. */
  unscanned: number;
  fiber: number;
  /** fiber present and not billed - the optimistic count. */
  open: number;
  /** billing 'N' at medium confidence: the provider said "no active account". */
  confirmedOpen: number;
  /** open doors with NO lead row at all - genuinely new inventory. */
  freshOpen: number;
  /** freshOpen that is also provider-confirmed. The number to act on. */
  freshConfirmed: number;
  /** open doors already in the CRM and assigned to a rep. */
  dispatched: number;
  /** knocks ever logged on this street. */
  knocks: number;
  newFiber: number;
  tenured: number;
  /** Median metres between adjacent open doors. Null when fewer than 3. */
  medianGapM: number | null;
  spanM: number;
  /** Estimated minutes to walk every fresh door on the street. */
  walkMinutes: number;
  /** freshOpen per hour of rep time - the ranking key. */
  doorsPerHour: number;
  scanAgeDays: number | null;
  coveragePct: number;
  competitorShare: number;
  flags: string[];
  score: number;
}

const R = 6_371_000;
function metres(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const p = Math.PI / 180;
  const dLat = (bLat - aLat) * p, dLng = (bLng - aLng) * p;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * p) * Math.cos(bLat * p) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Normalised full address, for the dedup in rule 4. */
const SUFFIX: Record<string, string> = {
  rd: "RD", road: "RD", dr: "DR", drive: "DR", st: "ST", street: "ST", ln: "LN", lane: "LN",
  ave: "AVE", avenue: "AVE", ct: "CT", court: "CT", cir: "CIR", circle: "CIR", blvd: "BLVD",
  hwy: "HWY", highway: "HWY", pl: "PL", place: "PL", trl: "TRL", trail: "TRL", tr: "TRL",
  way: "WAY", pkwy: "PKWY", parkway: "PKWY", loop: "LOOP", ter: "TER", terrace: "TER",
  run: "RUN", ext: "EXT", mount: "MT", mt: "MT", route: "ROUTE", rt: "ROUTE",
  north: "N", south: "S", east: "E", west: "W", northeast: "NE", northwest: "NW",
  southeast: "SE", southwest: "SW", n: "N", s: "S", e: "E", w: "W",
  ne: "NE", nw: "NW", se: "SE", sw: "SW",
};
export function normalizeAddress(raw: string | null | undefined): string {
  const a = String(raw ?? "").replace(/\s+(apt|unit|ste|suite|lot|#)\s*\S*$/i, "").trim();
  return a.split(/\s+/).map((t) => {
    const k = t.replace(/[.,]/g, "").toLowerCase();
    return SUFFIX[k] ?? t.replace(/[.,]/g, "").toUpperCase();
  }).join(" ");
}

export interface StreetOpportunityOptions {
  city?: string;
  state?: string;
  /** Merge a road that spans city labels into one row (rule 5). */
  mergeAcrossCities?: boolean;
  /** Ignore streets with fewer than this many fresh open doors. */
  minFreshOpen?: number;
  /** Median gap below this reads as an MDU, not a street (rule 8). */
  mduGapM?: number;
  limit?: number;
  nowMs?: number;
}

export function rankStreetOpportunities(
  tenantId: number,
  opts: StreetOpportunityOptions = {},
): StreetOpportunity[] {
  const minFresh = opts.minFreshOpen ?? 5;
  const mduGap = opts.mduGapM ?? 12;
  const now = opts.nowMs ?? Date.now();

  const where: string[] = ["s.tenant_id = ?"];
  const args: any[] = [tenantId];
  if (opts.state) { where.push("s.state = ?"); args.push(opts.state); }
  if (opts.city) { where.push("lower(trim(s.city)) = ?"); args.push(opts.city.toLowerCase().trim()); }

  // ONE pass. The lead join is a LEFT JOIN on the normalised address rather than
  // converted_to_lead_id, because that link is populated on 93 of 10,024 scanned
  // rows - the pipeline's own scan-to-lead pointer is effectively dead, which is
  // how the already-dispatched inventory went unnoticed in the first place.
  const rows = rawDb.prepare(
    `SELECT s.id, s.address, s.city, s.street_key, s.lat, s.lng,
            s.last_scanned_at, s.last_fiber_status, s.last_is_new_fiber,
            s.last_billing_status, s.last_fiber_available, s.last_customer_confidence,
            l.id AS lead_id, l.assigned_rep_id, l.in_competitor_area,
            (SELECT COUNT(*) FROM knock_log k WHERE k.lead_id = l.id) AS knocks
       FROM scan_targets s
       LEFT JOIN leads l
         ON lower(l.city) = lower(s.city)
        AND upper(trim(l.address)) = upper(trim(s.address))
      WHERE ${where.join(" AND ")} AND s.street_key IS NOT NULL`,
  ).all(...args) as any[];

  type Acc = {
    city: string; street: string; seen: Set<string>;
    scanned: number; unscanned: number; fiber: number; open: number; confirmed: number;
    fresh: number; freshConfirmed: number; dispatched: number; knocks: number;
    newFiber: number; tenured: number; competitor: number; leads: number;
    pts: Array<[number, number]>; newest: number | null;
  };
  const acc = new Map<string, Acc>();

  for (const r of rows) {
    // Normalise the stored street_key too: 1,912 of 1,924 duplicate address
    // groups already share it, but 12 split on Mount/Mt, and a street that
    // exists twice is counted twice.
    const street = normalizeAddress(r.street_key);
    if (!street) continue;
    const city = String(r.city ?? "").trim();
    const key = opts.mergeAcrossCities ? street : `${city.toLowerCase()}|${street}`;
    let a = acc.get(key);
    if (!a) {
      a = {
        city: opts.mergeAcrossCities ? "(multiple)" : city, street, seen: new Set(),
        scanned: 0, unscanned: 0, fiber: 0, open: 0, confirmed: 0, fresh: 0,
        freshConfirmed: 0, dispatched: 0, knocks: 0, newFiber: 0, tenured: 0,
        competitor: 0, leads: 0, pts: [], newest: null,
      };
      acc.set(key, a);
    }
    // Rule 4: one physical door, however many times it was imported.
    const norm = `${city.toLowerCase()}|${normalizeAddress(r.address)}`;
    if (a.seen.has(norm)) continue;
    a.seen.add(norm);

    if (!r.last_scanned_at) { a.unscanned++; continue; }
    a.scanned++;
    const t = Date.parse(String(r.last_scanned_at).replace(" ", "T") + "Z");
    if (Number.isFinite(t)) a.newest = a.newest == null ? t : Math.max(a.newest, t);
  }

  // Second pass over fiber doors: the first loop only established dedup and
  // per-street identity. Splitting them keeps each rule readable.
  const seen2 = new Map<string, Set<string>>();
  for (const r of rows) {
    const street = normalizeAddress(r.street_key);
    if (!street || !r.last_scanned_at) continue;
    const city = String(r.city ?? "").trim();
    const key = opts.mergeAcrossCities ? street : `${city.toLowerCase()}|${street}`;
    const a = acc.get(key);
    if (!a) continue;
    const norm = `${city.toLowerCase()}|${normalizeAddress(r.address)}`;
    let s2 = seen2.get(key); if (!s2) { s2 = new Set(); seen2.set(key, s2); }
    if (s2.has(norm)) continue;
    s2.add(norm);

    const hasFiber = r.last_is_new_fiber === 1 || r.last_fiber_available === 1 ||
      ["new_fiber", "tenured_fiber", "existing_fiber"].includes(String(r.last_fiber_status));
    if (!hasFiber) continue;
    a.fiber++;
    if (r.last_fiber_status === "new_fiber") a.newFiber++;
    if (r.last_fiber_status === "tenured_fiber") a.tenured++;
    if (r.lead_id != null) a.leads++;
    if (r.in_competitor_area === 1) a.competitor++;
    a.knocks += Number(r.knocks ?? 0);

    // `continue`, not `return`: this is a loop over every door, and returning
    // here would have ended the whole ranking at the first already-billed door.
    if (r.last_billing_status === "A") continue;               // rule 2: upper bound
    a.open++;
    const confirmed = r.last_billing_status === "N" && r.last_customer_confidence === "medium";
    if (confirmed) a.confirmed++;
    if (r.lead_id == null) {                                    // rule 6
      a.fresh++;
      if (confirmed) a.freshConfirmed++;
      if (r.lat != null && r.lng != null) a.pts.push([Number(r.lat), Number(r.lng)]);
    } else if (r.assigned_rep_id != null) {
      a.dispatched++;
    }
  }

  const out: StreetOpportunity[] = [];
  for (const a of acc.values()) {
    if (a.fresh < minFresh) continue;
    // Rule 7: walk order along the street, so gaps are real walking distance.
    const pts = [...a.pts].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    const gaps: number[] = [];
    for (let i = 1; i < pts.length; i++) gaps.push(metres(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
    const gap = gaps.length >= 2 ? median(gaps) : null;
    const span = gaps.reduce((x, y) => x + y, 0);
    // 1.5 min per door plus walking at 5 km/h.
    const walkMinutes = a.fresh * 1.5 + (span / 1000) / 5 * 60;
    const doorsPerHour = walkMinutes > 0 ? a.fresh / (walkMinutes / 60) : 0;
    const ageDays = a.newest == null ? null : Math.round((now - a.newest) / 86_400_000);
    const total = a.scanned + a.unscanned;
    const coverage = total ? (100 * a.scanned) / total : 0;

    const flags: string[] = [];
    if (gap != null && gap < mduGap) flags.push("possible-MDU");         // rule 8
    if (a.freshConfirmed === 0) flags.push("unverified");                 // rule 2
    if (ageDays != null && ageDays > 30) flags.push(`stale-${ageDays}d`); // rule 9
    if (coverage < 60) flags.push(`partial-${coverage.toFixed(0)}pct`);   // rule 9
    if (a.dispatched > a.fresh) flags.push("mostly-dispatched");          // rule 6
    if (a.knocks > 0) flags.push(`worked-${a.knocks}`);

    // Score: opportunities per hour, trusted in proportion to verification, and
    // discounted for age. Deliberately NOT a rate - see rule 1.
    const verified = a.fresh > 0 ? a.freshConfirmed / a.fresh : 0;
    const trust = 0.4 + 0.6 * verified;
    const decay = ageDays == null ? 1 : Math.max(0.5, 1 - ageDays / 180);
    const mduPenalty = flags.includes("possible-MDU") ? 0.6 : 1;
    out.push({
      city: a.city, street: a.street, scanned: a.scanned, unscanned: a.unscanned,
      fiber: a.fiber, open: a.open, confirmedOpen: a.confirmed, freshOpen: a.fresh,
      freshConfirmed: a.freshConfirmed, dispatched: a.dispatched, knocks: a.knocks,
      newFiber: a.newFiber, tenured: a.tenured,
      medianGapM: gap == null ? null : Math.round(gap), spanM: Math.round(span),
      walkMinutes: Math.round(walkMinutes), doorsPerHour: Number(doorsPerHour.toFixed(1)),
      scanAgeDays: ageDays, coveragePct: Number(coverage.toFixed(1)),
      competitorShare: a.fiber ? Number(((100 * a.competitor) / a.fiber).toFixed(1)) : 0,
      flags,
      score: Number((doorsPerHour * trust * decay * mduPenalty).toFixed(2)),
    });
  }
  out.sort((x, y) => y.score - x.score || y.freshOpen - x.freshOpen);
  return opts.limit ? out.slice(0, opts.limit) : out;
}
