// ── Team announcements — what the floor hears when somebody wins ─────────────
//
// A rep on a dead street has no idea that two blocks over someone just closed
// one. That silence is the problem: door-knocking is solitary work with long
// stretches of nothing, and the single cheapest motivator available is the
// knowledge that the doors ARE converting today, for someone standing in the
// same weather.
//
// So this broadcasts two things, and only two:
//
//   SALE     — a teammate closed one. Proof the street is live.
//   STREAK   — a teammate is running hot. An invitation to race them.
//
// ── WHY THIS FILE IS PARANOID ABOUT WHAT IT CARRIES ────────────────────────
//
// Every other lead-shaped payload in this app is ROW-SCOPED: a rep sees their
// own doors and nobody else's, and the live lead bus re-checks access per pin
// before it writes a frame. An announcement is the deliberate exception — it
// crosses that wall on purpose, because a win nobody hears about motivates
// nobody.
//
// That makes it the single worst place in the codebase to put customer data.
// The rules, enforced by construction below rather than by reviewer memory:
//
//   · NEVER a house number, and never a full address. A street name is the most
//     precise location an announcement may carry, and only because a rep needs
//     to recognise the street to feel it.
//   · NEVER a contact name, phone, email, or note body.
//   · NEVER a lead id — an id is a lookup key, and a broadcast bus should not
//     hand every rep in the org a way to enumerate doors they cannot open.
//
// What it carries instead is the teammate's name, a coarse place, and a number.
// That is all a motivator needs.
//
// PURE: no clock, no database, no I/O.

import { usd } from "./moneyFormat";

export type AnnouncementKind =
  /** A teammate closed one. Proof the street is live. */
  | "sale"
  /** A teammate is running hot. An invitation to race them. */
  | "hot_streak"
  /** Money on the table, authored by a manager — a promo, a contest, a push. */
  | "promo"
  /** Something changed in the app, or something the floor needs to know. */
  | "update";

/** The two kinds a human writes, as opposed to the two the system emits. */
export const AUTHORED_KINDS = ["promo", "update"] as const;
export type AuthoredKind = typeof AUTHORED_KINDS[number];

export interface Announcement {
  kind: AnnouncementKind;
  /** Team member who did the thing. The viewer filter compares against this. */
  actorRepId: number;
  actorName: string;
  headline: string;
  body: string;
  /** Collision key for the UNIQUE index — one announcement per real event. */
  dedupeKey: string;
  /** Cents, when the event has money attached. Display only. */
  amountCents?: number;
}

/** The most precise location an announcement may carry. */
export function coarsePlace(address: string | null | undefined, areaName?: string | null): string | null {
  // An AREA NAME is always preferred: it is an internal label a manager typed,
  // not customer data, and it is the unit reps actually think in.
  const area = (areaName ?? "").trim();
  if (area) return area;

  const raw = (address ?? "").trim();
  if (!raw) return null;
  // Street only. Drop the leading house number and anything past the first
  // comma (city/state/zip), then drop unit designators.
  const street = raw.split(",")[0]!.trim().replace(/^[\d\-#]+\s+/, "").replace(/\s+(apt|unit|ste|suite|#)\s*\S+$/i, "").trim();
  // A bare number, or something that still looks like a full street address
  // with a house number in it, is dropped rather than guessed at.
  if (!street || /^\d+$/.test(street) || /\d{3,}/.test(street)) return null;
  return street;
}

/** First name plus last initial. Enough to know who; short enough for a toast. */
export function shortName(fullName: string | null | undefined): string {
  const parts = String(fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A teammate";
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}

/** The one definition lives in ./moneyFormat (dependency-free, see its header
 *  for the bundle rationale). Re-exported here so existing importers keep
 *  working — the import flows INTO this module, never out of it. */
export { usd };

export interface SaleFacts {
  repId: number;
  repName: string | null | undefined;
  knockId: number;
  address?: string | null;
  areaName?: string | null;
  /** This rep's sale count today INCLUDING this one. Drives the streak line. */
  salesToday: number;
  /** The whole org's sale count today including this one. */
  teamSalesToday: number;
}

/**
 * "Marcus T. just closed one on Bellhaven Dr."
 *
 * The second line is the part that actually moves someone: a bare win is a fact,
 * a win plus "that's 3 today" is a target. When the team number is the
 * interesting one (someone else's first sale of the day, say) it leads with the
 * team instead, so a quiet rep still hears that the day is working.
 */
export function announceSale(f: SaleFacts): Announcement {
  const who = shortName(f.repName);
  const place = coarsePlace(f.address, f.areaName);
  const headline = place ? `${who} just closed one on ${place}` : `${who} just closed one`;

  const mine = Math.max(1, Math.trunc(f.salesToday) || 1);
  const team = Math.max(mine, Math.trunc(f.teamSalesToday) || mine);
  const body = mine >= 2
    ? `That's ${mine} for ${who} today — ${team} on the board.`
    : `${team} on the board today. Next one's out there.`;

  return {
    kind: "sale",
    actorRepId: f.repId,
    actorName: who,
    headline,
    body,
    // The knock is the event. A retried submit re-derives the same key and
    // collides on the UNIQUE index instead of announcing the sale twice.
    dedupeKey: `sale:knock:${f.knockId}`,
  };
}

export interface StreakFacts {
  repId: number;
  repName: string | null | undefined;
  /** The armed momentum offer — this IS the hot-streak signal. */
  offerId: number;
  offerAmountCents: number;
  /** 0..100 momentum score that armed it. */
  score: number;
  minutesLeft: number;
}

/**
 * "Marcus T. is running hot — $40 on the line for the next 45 min."
 *
 * Rides the momentum engine's arming decision rather than re-deriving "hot" from
 * scratch. That matters for a reason beyond DRY: momentum's floors are what stop
 * a rep sandbagging their way to a bonus, and a second, looser definition of
 * "streak" living here would be a way around them.
 */
export function announceStreak(f: StreakFacts): Announcement {
  const who = shortName(f.repName);
  const mins = Math.max(1, Math.round(f.minutesLeft));
  return {
    kind: "hot_streak",
    actorRepId: f.repId,
    actorName: who,
    headline: `${who} is running hot`,
    body: `${usd(f.offerAmountCents)} on the line if they close in the next ${mins} min. Catch up.`,
    amountCents: f.offerAmountCents,
    // One announcement per offer. An offer that expires and re-arms is a NEW
    // streak and gets a new id, so a rep who runs hot twice in a day is heard
    // twice — but a single streak is never announced twice.
    dedupeKey: `streak:offer:${f.offerId}`,
  };
}

/**
 * Should this viewer see this announcement?
 *
 * A rep does not need to be told about their own sale — they were there, and the
 * app already celebrated it at the door. Announcing it back reads as noise and
 * teaches people to ignore the feed, which costs the announcements that ARE
 * about somebody else.
 */
export function visibleTo(a: Pick<Announcement, "actorRepId">, viewerRepId: number | null | undefined): boolean {
  return viewerRepId == null || Number(viewerRepId) !== Number(a.actorRepId);
}

/** Relative time for the feed. Short, because it sits in a dense list. */
export function agoLabel(createdAtMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - createdAtMs) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}


// ── Announcements a manager writes ──────────────────────────────────────────
// The sale and streak kinds are emitted by the system from facts. These two are
// authored, which makes them the only place in the feed where a human chooses
// the words — and therefore the only place that needs limits.
//
// A promo interrupts (there is money attached and a rep should act now); an
// update does not (it is news, and news that buzzes a phone mid-pitch is how
// people turn notifications off).

export const ANNOUNCEMENT_TITLE_MAX = 80;
export const ANNOUNCEMENT_BODY_MAX = 240;

export interface AuthoredAnnouncementInput {
  kind: AuthoredKind;
  title: string;
  body: string;
  /** Optional money, for a promo. Display only — it does not pay anything by
   *  itself, and the copy must not imply it does. */
  amountCents?: number;
}

/** Shared by the API and the compose form, so the button disables for exactly
 *  the reasons the server would reject. Returns null when valid. */
export function validateAuthoredAnnouncement(input: unknown): string | null {
  const a = input as AuthoredAnnouncementInput | null;
  if (!a || typeof a !== "object") return "Nothing to post.";
  if (!AUTHORED_KINDS.includes(a.kind)) return "Pick promo or update.";

  const title = String(a.title ?? "").trim();
  const body = String(a.body ?? "").trim();
  if (!title) return "Give it a headline.";
  // Length caps are not cosmetic: this text becomes a phone notification, and
  // anything past ~80 characters is truncated by the OS mid-word.
  if (title.length > ANNOUNCEMENT_TITLE_MAX) return `Headline is over ${ANNOUNCEMENT_TITLE_MAX} characters.`;
  if (!body) return "Say what it means for them.";
  if (body.length > ANNOUNCEMENT_BODY_MAX) return `Message is over ${ANNOUNCEMENT_BODY_MAX} characters.`;

  if (a.amountCents != null) {
    const c = Number(a.amountCents);
    if (!Number.isInteger(c) || c < 0) return "Amount must be a whole number.";
    // Same ceiling every other incentive here enforces. A four-figure promo is
    // a fat finger, and this one goes to every phone in the org.
    if (c > 100_000) return "A promo cannot advertise more than $1,000.";
  }
  return null;
}

export function buildAuthoredAnnouncement(
  input: AuthoredAnnouncementInput, authorName: string | null | undefined, seq: number,
): Announcement {
  const title = String(input.title).trim();
  const body = String(input.body).trim();
  return {
    kind: input.kind,
    // Authored announcements have no actor REP — they come from the org, not
    // from a rep's activity. -1 keeps them out of the "don't show me my own
    // win" filter, which would otherwise hide a manager's promo from the
    // manager who wrote it (and from nobody else, which is worse than useless).
    actorRepId: -1,
    actorName: shortName(authorName) || "Homefront",
    headline: title,
    body,
    amountCents: input.amountCents,
    // Sequence rather than content: two identical "Push tonight" promos on
    // consecutive Fridays are both real, and hashing the text would silently
    // swallow the second.
    dedupeKey: `${input.kind}:authored:${seq}`,
  };
}
