// ── Objection Taxonomy ────────────────────────────────────────────────────────
// The frozen 14-key objection taxonomy for the drill-card contract (lane CE-3).
// Every objection heard at a door buckets into exactly one of these keys; the
// coaching engine (CE-1 server, CE-2 client) filters drill cards by them. Keys
// are stable identifiers — never rename, only append. Chip labels are the short
// UI strings rendered on filter chips and card badges.
//
// Sources: the objection content of modules m5 (Objection Psychology), m12
// (Objection Killers), and m18 (Advanced Objection Mastery), plus the m20
// one-liner vault's objection bridges, which reuse the same canonical set.

/** The 14 canonical objection keys. Order is display order for chip rows. */
export const OBJECTION_KEYS = [
  "not_interested",
  "happy_provider",
  "price",
  "spouse",
  "think_about_it",
  "too_busy",
  "scam",
  "bad_experience",
  "competitor_fiber",
  "renter",
  "no_card",
  "leave_something",
  "already_have",
  "hoa",
] as const;

export type ObjectionKey = (typeof OBJECTION_KEYS)[number];

/** One taxonomy entry: the stable key, the short chip label, and the canonical
 *  verbatim cue (how the homeowner actually says it). */
export type ObjectionTaxonomyEntry = {
  key: ObjectionKey;
  /** Short label for filter chips / card badges. Keep under ~22 chars. */
  chip: string;
  /** The objection as heard at the door. */
  cue: string;
};

export const OBJECTION_TAXONOMY: readonly ObjectionTaxonomyEntry[] = [
  { key: "not_interested", chip: "Not interested", cue: "Not interested." },
  { key: "happy_provider", chip: "Happy w/ provider", cue: "I'm happy with my provider." },
  { key: "price", chip: "Price", cue: "It's too expensive. / What's the price?" },
  { key: "spouse", chip: "Spouse", cue: "I need to ask my spouse." },
  { key: "think_about_it", chip: "Think about it", cue: "Let me think about it." },
  { key: "too_busy", chip: "Too busy", cue: "I'm busy right now." },
  { key: "scam", chip: "Scam?", cue: "Is this a scam?" },
  { key: "bad_experience", chip: "Bad experience", cue: "I had a bad experience." },
  { key: "competitor_fiber", chip: "Competitor fiber", cue: "We just got fiber from a competitor." },
  { key: "renter", chip: "Renter", cue: "I'm renting." },
  { key: "no_card", chip: "No card", cue: "I don't give my card out." },
  { key: "leave_something", chip: "Leave something", cue: "Just leave me something / your card." },
  { key: "already_have", chip: "Already have it", cue: "My internet works fine." },
  { key: "hoa", chip: "HOA", cue: "The HOA doesn't allow this / you can't knock here." },
];

const OBJECTION_KEY_SET: ReadonlySet<string> = new Set(OBJECTION_KEYS);

/** Type guard for untrusted input (route params, stored progress rows). */
export function isObjectionKey(value: unknown): value is ObjectionKey {
  return typeof value === "string" && OBJECTION_KEY_SET.has(value);
}

/** Chip label lookup for UI badges. */
export function objectionChip(key: ObjectionKey): string {
  return OBJECTION_TAXONOMY.find((e) => e.key === key)!.chip;
}

// ── Section-heading → key map ─────────────────────────────────────────────────
// Objection drill cards are extracted from objection-titled sections — sections
// whose heading IS the objection (usually quoted verbatim) — inside the three
// objection modules m5, m12, and m18. This map is the single source of truth
// for which headings count and which key each maps to. Headings must match the
// authored strings in shared/trainingContent.ts exactly (tests pin this).
// Technique-titled sections ("The forced-choice isolate", "The Spectrum pivot")
// are deliberately absent: they teach method, not a single objection's words.
export const OBJECTION_SECTION_HEADINGS: Readonly<Record<string, ObjectionKey>> = {
  // m5-big-six-1 / m5-big-six-2 — the big six brush-offs.
  "I'm busy right now": "too_busy",
  "I'm happy with my provider": "happy_provider",
  "I need to ask my spouse": "spouse",
  "It's too expensive": "price",
  "I had a bad experience with a switch": "bad_experience",
  "Not interested, and the walk-away line": "not_interested",
  // m12-happy-price-works — the satisfaction wall.
  '"I\'m happy with my provider"': "happy_provider",
  '"What\'s the price?" and "that\'s too expensive"': "price",
  '"My internet works fine"': "already_have",
  // m12-renting-spouse-think — the deferral family.
  '"I\'m renting"': "renter",
  '"My spouse handles that"': "spouse",
  '"Let me think about it"': "think_about_it",
  // m12-scam-bad-notinterested — the trust family.
  '"Is this a scam?"': "scam",
  '"I had a bad experience"': "bad_experience",
  '"Not interested"': "not_interested",
  // m18-money-competitor — the graduate money / competitor deep-dives.
  '"Too expensive" — isolate before you reframe': "price",
  '"We just got fiber from a competitor"': "competitor_fiber",
  "The bad-experience win-back": "bad_experience",
  // m18-book-it — the push-out family.
  '"I need to ask my wife": book the visit, not the verdict': "spouse",
  '"Let me think about it": name it or park it': "think_about_it",
};

/** Resolve a lesson section heading to its objection key, or null when the
 *  section is not objection-titled. Exact match after trimming. */
export function objectionKeyForHeading(heading: string): ObjectionKey | null {
  return OBJECTION_SECTION_HEADINGS[heading.trim()] ?? null;
}

// ── Named coverage gaps ───────────────────────────────────────────────────────
// Keys with no objection-titled section in m5/m12/m18 today, and therefore no
// objection drill card. Each gap is named with its reason and where the content
// lives, so CE lanes can render the chip honestly instead of an empty state.
export const OBJECTION_CARD_GAPS: Readonly<Record<ObjectionKey, string | null>> = {
  not_interested: null,
  happy_provider: null,
  price: null,
  spouse: null,
  think_about_it: null,
  too_busy: null,
  scam: null,
  bad_experience: null,
  competitor_fiber: null,
  renter: null,
  already_have: null,
  no_card:
    "Covered by lesson m13-no-card-objection (payment-compliance module), whose sections are technique-titled, not objection-titled — outside the m5/m12/m18 objection-section source set.",
  leave_something:
    "Appears only as a brush-off line inside callback content (m6-callback quiz: 'Leave your card and we will call you'); no dedicated objection section exists yet.",
  hoa:
    "Handled as compliance content in m22-territory-law and m15-compliance-safety (leave instantly, flag to lead), not as an objection-response section.",
};
