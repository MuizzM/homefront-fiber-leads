// The remaining "a failed fetch states a falsehood" sites, and two controls
// whose label could not be read.
//
// These four screens are expensive to mount (deep provider trees, wouter routes,
// GL contexts), so they are pinned at source level in the spirit of
// map-viewport-wiring.test.ts. The three cheap-to-mount ones live in
// tests/rtl/ErrorStatesAreNotEmpties.test.tsx.
//
// The shared defect: `data` destructured alone, `?? []` or `?? 0` downstream,
// and the empty branch left to speak for an outage. What makes it worth a test
// rather than a comment is that every instance reads as correct - the falsehood
// only appears when the request fails, which is exactly when nobody is looking.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("PropertyDetail: prior visits are unknown, not absent", () => {
  const src = read("client/src/pages/PropertyDetail.tsx");

  it("shows an error before the 'first at this door' empty state", () => {
    // A rep reads this ON the doorstep and decides how to open. A door another
    // rep marked "not interested" an hour ago read as untouched.
    const errAt = src.indexOf('testId="detail-history-error"');
    const emptyAt = src.indexOf('data-testid="detail-history-empty"');
    expect(errAt).toBeGreaterThan(-1);
    expect(emptyAt).toBeGreaterThan(-1);
    expect(errAt).toBeLessThan(emptyAt);           // the error branch is checked first
    expect(src).toContain("histQ.isError");
  });

  it("says visits are unknown rather than none, and offers a retry", () => {
    expect(src).toMatch(/unknown, not absent/i);
    expect(src).toContain("histQ.refetch()");
  });
});

describe("Leads: an unknown competitor is not 'no competitor'", () => {
  const src = read("client/src/pages/Leads.tsx");

  it("surfaces the enrichment error instead of falling through to the green panel", () => {
    // The green panel was the FALLTHROUGH branch, so a 500 rendered "No
    // competitor ISP detected at this address" and the rep pitched a switch
    // against an incumbent nobody told them about.
    expect(src).toContain("isError: isEnrichError");
    const errAt = src.indexOf('data-testid="lead-competition-error"');
    const greenAt = src.indexOf("No competitor ISP detected at this address");
    expect(errAt).toBeGreaterThan(-1);
    expect(errAt).toBeLessThan(greenAt);
    expect(src).toContain('data-testid="lead-competition-retry"');
  });
});

describe("Team: a failed leaderboard is not a team that did nothing", () => {
  const src = read("client/src/pages/Team.tsx");

  it("distinguishes unknown from zero", () => {
    // statsFor fell back to all-zeros, so every rep rendered 0 knocks / 0 sales
    // and a manager reads a performance problem into an outage.
    expect(src).toContain("isError: leaderboardError");
    expect(src).toContain("UNKNOWN_STATS");
    expect(src).toContain("leaderboardError ? UNKNOWN_STATS : NO_STATS");
  });

  it("renders a dash for unknown in BOTH the mobile and desktop metric cells", () => {
    // Two separate cells render the same numbers; fixing one is how half a fix
    // ships. Governance already uses the dash for this, so it is the app's
    // existing vocabulary for "we do not know".
    const dashes = src.match(/val == null \? "-" :/g) ?? [];
    expect(dashes.length).toBe(2);
  });

  it("still shows a real 0 for a rep absent from a LOADED leaderboard", () => {
    // A rep who genuinely has not knocked today has done zero, and must not be
    // hidden behind a dash.
    expect(src).toContain("statsById.get(repId) ?? (leaderboardError ? UNKNOWN_STATS : NO_STATS)");
  });
});

describe("LoginActivity: one answer at a time", () => {
  const src = read("client/src/pages/LoginActivity.tsx");

  it("does not print the empty state underneath its own error banner", () => {
    // It rendered "Couldn't load the audit trail" AND "No login activity
    // recorded yet" simultaneously - two contradictory statements about a
    // SECURITY log, on screen together.
    expect(src).toContain("summaryQuery.isError");
    const errAt = src.indexOf('data-testid="login-activity-unknown"');
    const emptyAt = src.indexOf("No login activity recorded yet");
    expect(errAt).toBeGreaterThan(-1);
    expect(errAt).toBeLessThan(emptyAt);
  });
});

// ── Contrast ────────────────────────────────────────────────────────────────
// Both measured against this repo's own tokens rather than eyeballed. The
// numbers in the comments are what the ratio actually is, computed from
// index.css: WCAG AA for body text is 4.5:1.
describe("controls whose label could be read at all", () => {
  it("MapLensNotice carries glass-ink-scope", () => {
    // .glass-opaque is a THEME-INVARIANT near-black navy, but text-foreground
    // still resolved to the light theme's navy ink: 1.02:1, which is not "hard
    // to read", it is invisible. glass-ink-scope exists for exactly this and
    // takes it to 14.40:1. Every glass surface in the app needs it.
    const src = read("client/src/components/map/MapLensNotice.tsx");
    expect(src).toMatch(/glass-capsule glass-opaque glass-ink-scope/);
  });

  it("the armed 'Confirm: Do not call?' label uses the semantic token", () => {
    // Near-white text-red-100 on a 15% destructive tint over a white card
    // measured 1.05:1 - on the CONFIRM step of the control that suppresses a
    // number. text-destructive is built to sit on its own tint: 4.69:1.
    const src = read("client/src/pages/CallingLead.tsx");
    expect(src).toContain('armed && "border-destructive bg-destructive/15 text-destructive ring-1 ring-destructive"');
    expect(src).not.toContain("text-red-100");
  });
});
