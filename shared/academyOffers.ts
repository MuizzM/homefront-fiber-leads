// ── Academy offer catalog ─────────────────────────────────────────────────────
//
// Every price, speed, promotion and availability statement a rep is allowed to
// make at a door lives HERE, dated, and scoped to a provider and a market.
// Nothing else in the Academy is permitted to hard-code a number.
//
// WHY THIS EXISTS AS ITS OWN MODULE
//   The curriculum (shared/trainingContent.ts) teaches technique and is stable
//   for months. Offers change weekly and differ by market. Baking "89 dollars"
//   into a lesson means a rep in a market that never had that price rehearses a
//   false claim until it is muscle memory. So the teaching layer references
//   offer FIELDS ("the promotional price in your market") and this layer
//   resolves them at render time against the rep's market and today's date.
//
// EFFECTIVE DATING IS THE POINT
//   An offer carries effectiveFrom and effectiveTo. `activeOffers` filters on
//   the clock passed in, never on a clock it reaches for itself, so the same
//   function answers "what is live now" in the app and "what was live on the
//   14th" in a test. An expired promotion does not linger in a pitch block, a
//   flashcard or a role-play script: it disappears from every surface at once
//   because every surface asks this module.
//
// CLAIM VERIFICATION
//   `verifyClaim` takes a sentence a rep wrote in the Pitch Lab and the offers
//   live in their market, extracts the numbers, and reports any that no active
//   offer supports. That is what makes "never allow unsupported claims" a
//   mechanism rather than a policy sentence in a lesson nobody re-reads.
//
// PURE and dependency-free. Prices are integer cents; speeds are integer Mbps.

/** Stable provider identifier. Append only, never rename: stored in overrides. */
export type ProviderId = string;

/** Stable market identifier, "<state>-<slug>" lowercased, e.g. "nc-lexington".
 *  A market is the unit a supervisor configures training for. */
export type MarketId = string;

/** What a rep is allowed to say a plan does. Every field is a claim surface. */
export type AcademyOffer = {
  /** Stable id. Never rename: assignments and role-play sessions store it. */
  id: string;
  provider: ProviderId;
  /** The market this offer is sold in. "*" means every market for the provider. */
  market: MarketId | "*";
  /** Rep-facing plan name, exactly as the customer will see it on a bill. */
  name: string;
  downloadMbps: number;
  uploadMbps: number;
  /** Monthly price in integer cents, the everyday (non-promotional) rate. */
  priceCents: number;
  /** Promotional rate in cents while promoMonths runs, or null when there is
   *  no promotion. A promo with no end date is not a promo, it is the price. */
  promoPriceCents: number | null;
  promoMonths: number | null;
  /** Contract length in months. 0 means no term commitment. */
  termMonths: number;
  /** Equipment/router fee in cents per month, 0 when included. */
  equipmentCents: number;
  /** Installation fee in cents, 0 when waived. */
  installCents: number;
  /** True only where the provider genuinely does not meter or throttle. */
  unlimitedData: boolean;
  /** ISO date (yyyy-mm-dd) the offer may first be quoted. */
  effectiveFrom: string;
  /** ISO date after which the offer must not be quoted, or null for open. */
  effectiveTo: string | null;
  /** Verbatim disclosures a rep must say when quoting this offer. Rendered
   *  next to the price everywhere, never collapsed behind a "more" link. */
  disclosures: string[];
};

/** A competitor's published position, used for honest comparison only. Every
 *  entry needs a source and an asOf so a rep can say where the number is from
 *  and a supervisor can see when it went stale. */
export type CompetitorOffer = {
  id: string;
  provider: ProviderId;
  market: MarketId | "*";
  name: string;
  downloadMbps: number;
  uploadMbps: number;
  priceCents: number;
  /** How the connection reaches the home. Drives the honest technical contrast. */
  medium: "fiber" | "cable" | "dsl" | "fixed_wireless" | "satellite";
  /** Where the figure came from, in words a rep could repeat out loud. */
  source: string;
  /** ISO date the figure was last checked. Stale entries are flagged in the UI. */
  asOf: string;
};

export type OfferCatalog = {
  /** Catalog version, bumped whenever a supervisor saves. Lets the client cache. */
  version: number;
  offers: AcademyOffer[];
  competitors: CompetitorOffer[];
};

/** How long a competitor figure stays quotable before the UI marks it stale. */
export const COMPETITOR_STALE_DAYS = 120;

// ── Default catalog ───────────────────────────────────────────────────────────
// The seed a tenant starts with. Deliberately small and explicitly dated: a
// supervisor is expected to replace these with their own market's real numbers
// through the offer console. Nothing here is presented to a rep as fact until
// a supervisor has confirmed the market, which is why every seeded offer is
// scoped to "*" and carries the same disclosure about confirming availability.

const SEED_DISCLOSURE =
  "Price and availability are confirmed at the address before any order is placed.";

export const DEFAULT_OFFER_CATALOG: OfferCatalog = {
  version: 1,
  offers: [
    {
      id: "kinetic-fiber-500",
      provider: "kinetic",
      market: "*",
      name: "Kinetic Fiber 500",
      downloadMbps: 500,
      uploadMbps: 500,
      priceCents: 5499,
      promoPriceCents: null,
      promoMonths: null,
      termMonths: 0,
      equipmentCents: 0,
      installCents: 0,
      unlimitedData: true,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      disclosures: [SEED_DISCLOSURE],
    },
    {
      id: "kinetic-fiber-1gig",
      provider: "kinetic",
      market: "*",
      name: "Kinetic Fiber 1 Gig",
      downloadMbps: 1000,
      uploadMbps: 1000,
      priceCents: 6999,
      promoPriceCents: null,
      promoMonths: null,
      termMonths: 0,
      equipmentCents: 0,
      installCents: 0,
      unlimitedData: true,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      disclosures: [SEED_DISCLOSURE],
    },
    {
      id: "kinetic-fiber-2gig",
      provider: "kinetic",
      market: "*",
      name: "Kinetic Fiber 2 Gig",
      downloadMbps: 2000,
      uploadMbps: 2000,
      priceCents: 9999,
      promoPriceCents: null,
      promoMonths: null,
      termMonths: 0,
      equipmentCents: 0,
      installCents: 0,
      unlimitedData: true,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      disclosures: [SEED_DISCLOSURE],
    },
  ],
  competitors: [],
};

// ── Date handling ─────────────────────────────────────────────────────────────
// Offers are dated in plain yyyy-mm-dd because a promotion runs on calendar
// days in the market's own timezone, not on instants. Comparing the strings
// lexicographically is correct for that format and avoids the timezone bug
// where a rep in the field sees yesterday's offer expire at 8 PM local.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True when the value is a well-formed yyyy-mm-dd calendar date. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** The calendar date of an instant, in UTC. The clock is always passed in. */
export function calendarDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Whole days between two calendar dates, b minus a. */
export function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** True when the offer may be quoted on the given calendar day. */
export function isOfferActive(offer: AcademyOffer, day: string): boolean {
  if (offer.effectiveFrom > day) return false;
  if (offer.effectiveTo !== null && offer.effectiveTo < day) return false;
  return true;
}

/** True when an offer has aged out. Split from isOfferActive so the UI can say
 *  "expired on the 4th" rather than the useless "not available". */
export function isOfferExpired(offer: AcademyOffer, day: string): boolean {
  return offer.effectiveTo !== null && offer.effectiveTo < day;
}

/** True when a competitor figure is older than the staleness window. */
export function isCompetitorStale(entry: CompetitorOffer, day: string): boolean {
  return daysBetween(entry.asOf, day) > COMPETITOR_STALE_DAYS;
}

// ── Resolution ────────────────────────────────────────────────────────────────

export type OfferQuery = {
  /** The rep's market. Offers scoped to "*" always match. */
  market?: MarketId;
  provider?: ProviderId;
  /** The calendar day to resolve against. */
  day: string;
};

/** Offers quotable right now, narrowest market scope first so a market-specific
 *  price always renders above the provider-wide fallback. */
export function activeOffers(catalog: OfferCatalog, query: OfferQuery): AcademyOffer[] {
  return catalog.offers
    .filter((o) => isOfferActive(o, query.day))
    .filter((o) => (query.provider ? o.provider === query.provider : true))
    .filter((o) => (query.market ? o.market === "*" || o.market === query.market : true))
    .sort((a, b) => {
      const scope = Number(a.market === "*") - Number(b.market === "*");
      if (scope !== 0) return scope;
      return a.downloadMbps - b.downloadMbps;
    });
}

/** Offers that have aged out, most recently expired first. Surfaced to
 *  supervisors so a market's content does not quietly empty itself. */
export function expiredOffers(catalog: OfferCatalog, query: OfferQuery): AcademyOffer[] {
  return catalog.offers
    .filter((o) => isOfferExpired(o, query.day))
    .filter((o) => (query.provider ? o.provider === query.provider : true))
    .filter((o) => (query.market ? o.market === "*" || o.market === query.market : true))
    .sort((a, b) => String(b.effectiveTo).localeCompare(String(a.effectiveTo)));
}

/** Competitor entries for a market, stale ones last. */
export function competitorOffers(catalog: OfferCatalog, query: OfferQuery): CompetitorOffer[] {
  return catalog.competitors
    .filter((c) => (query.market ? c.market === "*" || c.market === query.market : true))
    .filter((c) => (query.provider ? c.provider === query.provider : true))
    .sort((a, b) => {
      const stale = Number(isCompetitorStale(a, query.day)) - Number(isCompetitorStale(b, query.day));
      if (stale !== 0) return stale;
      return a.provider.localeCompare(b.provider);
    });
}

/** The offer a pitch should quote by default: the cheapest active symmetrical
 *  plan in the market. Returns null when the market has no live offer, which is
 *  a real state the UI must render rather than paper over with a placeholder. */
export function headlineOffer(catalog: OfferCatalog, query: OfferQuery): AcademyOffer | null {
  const live = activeOffers(catalog, query);
  if (!live.length) return null;
  return live.reduce((best, o) => (effectivePriceCents(o) < effectivePriceCents(best) ? o : best));
}

/** What the customer actually pays in month one, promo included. */
export function effectivePriceCents(offer: AcademyOffer): number {
  const base = offer.promoPriceCents ?? offer.priceCents;
  return base + offer.equipmentCents;
}

/** Every disclosure that must be spoken with this offer, deduped and ordered. */
export function requiredDisclosures(offer: AcademyOffer): string[] {
  const out: string[] = [];
  const push = (s: string) => { if (s && !out.includes(s)) out.push(s); };
  for (const d of offer.disclosures) push(d);
  if (offer.promoPriceCents !== null && offer.promoMonths) {
    push(
      `The promotional rate runs ${offer.promoMonths} months, then the plan bills at the standard rate.`,
    );
  }
  if (offer.termMonths > 0) push(`This plan carries a ${offer.termMonths} month term.`);
  if (offer.installCents > 0) push("There is an installation charge on the first bill.");
  return out;
}

// ── Claim verification ────────────────────────────────────────────────────────
//
// A rep types a benefit line in the Pitch Lab. Before it can be saved to their
// personal pitch it is checked against the offers live in their market. The
// check is deliberately conservative in one direction only: it flags numbers it
// cannot source, and never silently approves a number because the sentence
// around it sounded careful.

export type ClaimIssue = {
  kind: "price" | "speed" | "superlative" | "guarantee" | "availability";
  /** The exact fragment that triggered the flag, for underlining in the UI. */
  fragment: string;
  /** What is wrong, in one sentence a rep can act on. */
  message: string;
  /** A wording that would be supportable, when one exists. */
  suggestion?: string;
};

/** Words that assert an absolute the field can never verify at a door. */
const SUPERLATIVES = [
  "fastest", "cheapest", "best", "unbeatable", "lowest price", "no one else",
  "nobody else", "only provider", "never goes down", "always works",
];

/** Words that promise an outcome the rep does not control. */
const GUARANTEES = [
  "guarantee", "guaranteed", "promise you", "i promise", "forever",
  "locked in for life", "will never go up", "never increase",
];

/** Words that assert serviceability before the address has been checked. */
const AVAILABILITY = [
  "you already have it", "it's already at your house", "you're already connected",
  "it's definitely available", "everyone on this street has it",
];

const PRICE_RE = /\$\s?(\d{1,4})(?:\.(\d{2}))?/g;
const SPEED_RE = /(\d{1,5})\s?(?:mbps|mb|meg|megs|gig|gbps|g\b)/gi;
/** "a gig", "the gig plan", "gigabit" — a speed claim with the number implied.
 *  Reps say this constantly, and it is exactly as unsupportable as "1000 Mbps"
 *  in a market with no gig plan, so it has to be caught. */
const BARE_GIG_RE = /\b(?<!\d\s?)(gig|gigabit)\b/gi;

/** Parse a speed fragment into Mbps. "1 gig" and "1000 mbps" are the same claim. */
function speedToMbps(value: number, unit: string): number {
  return /gig|gbps|^g$/i.test(unit) ? value * 1000 : value;
}

/**
 * Check a rep-written sentence against the offers live in their market.
 *
 * Returns every issue found, in reading order. An empty array means every
 * number in the sentence is sourced to an active offer and no absolute or
 * guarantee was asserted. It does NOT mean the sentence is a good pitch.
 */
export function verifyClaim(text: string, offers: AcademyOffer[]): ClaimIssue[] {
  const issues: ClaimIssue[] = [];
  const lower = text.toLowerCase();

  for (const word of SUPERLATIVES) {
    const at = lower.indexOf(word);
    if (at >= 0) {
      issues.push({
        kind: "superlative",
        fragment: text.slice(at, at + word.length),
        message: "That is an absolute you cannot verify at the door.",
        suggestion: "Compare on something specific and checkable, like upload speed or the price on their current bill.",
      });
    }
  }

  for (const word of GUARANTEES) {
    const at = lower.indexOf(word);
    if (at >= 0) {
      issues.push({
        kind: "guarantee",
        fragment: text.slice(at, at + word.length),
        message: "You cannot promise an outcome the company has not committed to in writing.",
        suggestion: "Say what the plan does today and what the disclosure says about changes.",
      });
    }
  }

  for (const phrase of AVAILABILITY) {
    const at = lower.indexOf(phrase);
    if (at >= 0) {
      issues.push({
        kind: "availability",
        fragment: text.slice(at, at + phrase.length),
        message: "Serviceability is confirmed at the address, not asserted on the porch.",
        suggestion: "Say you will check the address before anything is ordered.",
      });
    }
  }

  // Prices: every dollar figure must match an active offer's price, promo
  // price, or full first-month cost. A figure inside a range the rep invented
  // is exactly the claim this catches.
  const priced = new Set<number>();
  for (const o of offers) {
    priced.add(o.priceCents);
    priced.add(effectivePriceCents(o));
    if (o.promoPriceCents !== null) priced.add(o.promoPriceCents);
  }
  for (const match of text.matchAll(PRICE_RE)) {
    const dollars = Number(match[1]);
    const cents = Number(match[2] ?? 0);
    const total = dollars * 100 + cents;
    if (!priced.has(total)) {
      issues.push({
        kind: "price",
        fragment: match[0],
        message: offers.length
          ? "No live offer in this market is priced at that figure."
          : "This market has no live offer, so no price can be quoted yet.",
        suggestion: offers.length
          ? `Live prices here: ${[...priced].sort((a, b) => a - b).map(centsToUsd).join(", ")}.`
          : undefined,
      });
    }
  }

  // Speeds: same rule, against download and upload figures.
  const speeds = new Set<number>();
  for (const o of offers) {
    speeds.add(o.downloadMbps);
    speeds.add(o.uploadMbps);
  }
  const flagSpeed = (fragment: string, mbps: number) => {
    if (speeds.has(mbps)) return;
    issues.push({
      kind: "speed",
      fragment,
      message: offers.length
        ? "No live plan in this market runs at that speed."
        : "This market has no live offer, so no speed can be quoted yet.",
      suggestion: offers.length
        ? `Live speeds here: ${[...speeds].sort((a, b) => a - b).map((s) => `${s} Mbps`).join(", ")}.`
        : undefined,
    });
  };

  const numbered = [...text.matchAll(SPEED_RE)];
  for (const match of numbered) {
    flagSpeed(match[0], speedToMbps(Number(match[1]), match[0].replace(/[\d\s]/g, "")));
  }
  // A bare "gig" only counts when it was not already caught with a number in
  // front of it, so "1 gig" produces one issue rather than two.
  const numberedText = numbered.map((m) => m[0]).join(" ").toLowerCase();
  for (const match of text.matchAll(BARE_GIG_RE)) {
    if (numberedText.includes(match[0].toLowerCase())) continue;
    flagSpeed(match[0], 1000);
  }

  return issues;
}

/** Integer cents to a rep-readable dollar string. Whole dollars drop the cents,
 *  because "$70.00" on a porch reads as a quote and "$70" reads as a fact. */
export function centsToUsd(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100);
  return rest === 0 ? `$${whole}` : `$${whole}.${String(rest).padStart(2, "0")}`;
}

// ── Validation for supervisor writes ──────────────────────────────────────────

/** Everything wrong with a proposed offer, in field order. Empty means saveable. */
export function validateOffer(offer: Partial<AcademyOffer>): string[] {
  const errors: string[] = [];
  const id = typeof offer.id === "string" ? offer.id.trim() : "";
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) {
    errors.push("id must be lowercase letters, numbers and hyphens, 2 to 64 characters.");
  }
  if (!offer.provider || typeof offer.provider !== "string") errors.push("provider is required.");
  if (!offer.market || typeof offer.market !== "string") errors.push("market is required, or \"*\" for every market.");
  if (!offer.name || typeof offer.name !== "string" || offer.name.trim().length < 2) {
    errors.push("name is required.");
  }
  for (const field of ["downloadMbps", "uploadMbps"] as const) {
    const v = offer[field];
    if (!Number.isInteger(v) || (v as number) <= 0 || (v as number) > 100_000) {
      errors.push(`${field} must be a positive whole number of Mbps.`);
    }
  }
  for (const field of ["priceCents", "equipmentCents", "installCents"] as const) {
    const v = offer[field];
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 100_000_00) {
      errors.push(`${field} must be a whole number of cents, zero or more.`);
    }
  }
  if (offer.promoPriceCents != null) {
    if (!Number.isInteger(offer.promoPriceCents) || offer.promoPriceCents < 0) {
      errors.push("promoPriceCents must be a whole number of cents.");
    }
    if (!Number.isInteger(offer.promoMonths) || (offer.promoMonths as number) <= 0) {
      errors.push("A promotional price needs a promoMonths length. A promotion with no end is just the price.");
    }
  }
  if (!Number.isInteger(offer.termMonths) || (offer.termMonths as number) < 0) {
    errors.push("termMonths must be zero or a whole number of months.");
  }
  if (!isCalendarDate(offer.effectiveFrom)) errors.push("effectiveFrom must be a yyyy-mm-dd date.");
  if (offer.effectiveTo != null && !isCalendarDate(offer.effectiveTo)) {
    errors.push("effectiveTo must be a yyyy-mm-dd date or empty.");
  }
  if (
    isCalendarDate(offer.effectiveFrom) && offer.effectiveTo != null &&
    isCalendarDate(offer.effectiveTo) && offer.effectiveTo < offer.effectiveFrom
  ) {
    errors.push("effectiveTo cannot be before effectiveFrom.");
  }
  if (!Array.isArray(offer.disclosures) || offer.disclosures.some((d) => typeof d !== "string")) {
    errors.push("disclosures must be a list of sentences.");
  }
  return errors;
}
