// ── Daily mindset quotes ──────────────────────────────────────────────────────
//
// One quote a day on the Academy home, themed on the one trait that decides
// door-to-door outcomes: consistency. The rotation is deterministic from the
// calendar date, so every rep on a crew sees the same line on the same day and
// it can be quoted at a morning huddle without anyone's phone disagreeing.
//
// ATTRIBUTION IS A PROMISE
//   A quote with a name on it is a factual claim. Everything attributed here is
//   a line its person is widely documented saying; nothing is invented and put
//   in a famous mouth. The unattributed lines are ours, written for this job,
//   and they carry no name on purpose.
//
// House copy rules apply (no emoji, no em dashes, no arrows), and this list is
// swept by tests/unit/academy-content.test.ts like every other content file.

export type AcademyQuote = {
  text: string;
  /** Who said it, or null for a house line written for this program. */
  attribution: string | null;
};

export const ACADEMY_QUOTES: readonly AcademyQuote[] = [
  { text: "I didn't come this far to only come this far.", attribution: "Tom Brady" },
  { text: "You wanna know which ring is my favorite? The next one.", attribution: "Tom Brady" },
  { text: "If you don't believe in yourself, why is anyone else going to believe in you?", attribution: "Tom Brady" },
  { text: "Success isn't always about greatness. It's about consistency. Consistent hard work leads to success.", attribution: "Dwayne Johnson" },
  { text: "Long-term consistency trumps short-term intensity.", attribution: "Bruce Lee" },
  { text: "Today I will do what others won't, so tomorrow I can accomplish what others can't.", attribution: "Jerry Rice" },
  { text: "Success is neither magical nor mysterious. Success is the natural consequence of consistently applying the basic fundamentals.", attribution: "Jim Rohn" },
  { text: "We are what we repeatedly do. Excellence, then, is not an act, but a habit.", attribution: "Will Durant" },
  { text: "Winning is not a sometime thing; it's an all the time thing.", attribution: "Vince Lombardi" },
  { text: "Don't count the days; make the days count.", attribution: "Muhammad Ali" },
  { text: "Every strike brings me closer to the next home run.", attribution: "Babe Ruth" },
  { text: "The next door has not heard a single no today.", attribution: null },
  { text: "Doors do not remember yesterday. Neither should you.", attribution: null },
  { text: "Consistency is knocking the tenth door with the energy you brought to the first.", attribution: null },
  { text: "Ten honest conversations beat forty rushed ones, today and every day after.", attribution: null },
  { text: "Nobody closes every door. Everybody who lasts knocks every day.", attribution: null },
];

/**
 * Deterministic index for a calendar date. Day-of-year plus a year offset, so
 * the sequence does not repeat on the same dates every year, modulo the list.
 *
 * Computed from calendar fields via UTC, never from elapsed milliseconds: a
 * DST transition makes an elapsed-time day-of-year change mid-day, and the
 * whole point is that every check on the same local date sees the same line.
 */
export function quoteIndexFor(date: Date): number {
  const dayOfYear = Math.floor(
    (Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 1)) / 86_400_000,
  );
  const seed = date.getFullYear() * 366 + dayOfYear;
  return ((seed % ACADEMY_QUOTES.length) + ACADEMY_QUOTES.length) % ACADEMY_QUOTES.length;
}

/** The quote for a given local date. Same date, same quote, on every device. */
export function quoteForDay(date: Date): AcademyQuote {
  return ACADEMY_QUOTES[quoteIndexFor(date)];
}
