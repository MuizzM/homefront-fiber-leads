import { describe, it, expect, vi, afterEach } from "vitest";
import {
  OUTCOMES,
  FIELD_OUTCOMES,
  OUTCOME_TO_STATUS,
  OUTCOME_META,
  isKnockOutcome,
  deriveWasHome,
  pinDisplayState,
  summarizeByDisplayState,
  BULK_STATUS_OUTCOMES,
  isBulkStatusOutcome,
  STATE_COLORS,
  haversineMeters,
  nearestUnworkedLead,
  distanceHint,
  retryDelayMs,
  makeClientId,
  KNOCK_QUEUE_MAX_ATTEMPTS,
  type RoutablePin,
  type PinDisplayState,
} from "@shared/knock";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * CONTRACT (shared/knock.ts — pure, framework-free door-knocking domain).
 * These tests pin the invariants BOTH server/routes.ts and the client rely on:
 *   - OUTCOMES remains total for backward compatibility; FIELD_OUTCOMES is the
 *     smaller set offered for new work.
 *     of the 6 canonical statuses (no 7th status may ever be invented here).
 *   - wasHome is derived (false only for not_home) — never client-supplied.
 *   - pinDisplayState projects {leadStatus, visited, lastOutcome} onto the 7
 *     map pin states; a knocked prospect must never read as unworked green.
 *   - nearestUnworkedLead routes to unworked OR not_home pins (a not-home
 *     door is a revisit, not a dead end), distance asc → leadScore desc →
 *     id asc, and never crashes on bad coords.
 *   - retryDelayMs backs off 2s → 60s cap; makeClientId works without crypto.
 * ────────────────────────────────────────────────────────────────────────────
 */

const CANONICAL_STATUSES = [
  "prospect", "contacted", "interested", "sold", "not_interested", "follow_up",
] as const;

const ALL_PIN_STATES: PinDisplayState[] = [
  "unworked", "not_home", "contacted", "interested", "follow_up", "callback", "sold", "not_interested",
];

describe("OUTCOMES — totality", () => {
  it("defines exactly 8 outcomes with unique keys (7 rep statuses + needs_verification)", () => {
    expect(OUTCOMES).toHaveLength(8);
    expect(new Set(OUTCOMES.map((o) => o.key)).size).toBe(8);
  });

  it("does not offer Callback or Needs Verification for new field entries", () => {
    expect(FIELD_OUTCOMES.map((outcome) => outcome.key)).toEqual([
      "not_home", "interested", "sold", "not_interested", "follow_up", "prospect",
    ]);
  });

  it("maps every outcome to one of the 6 canonical lead statuses", () => {
    for (const o of OUTCOMES) {
      expect(CANONICAL_STATUSES).toContain(o.leadStatus);
    }
  });

  it("OUTCOME_TO_STATUS carries the routing-critical mappings", () => {
    expect(OUTCOME_TO_STATUS.needs_verification).toBe("contacted");
    expect(OUTCOME_TO_STATUS.callback).toBe("follow_up");
    expect(OUTCOME_TO_STATUS.follow_up).toBe("follow_up");
    expect(OUTCOME_TO_STATUS.not_home).toBe("prospect");
    // "prospect" is the reset disposition — returns the door to the pool.
    expect(OUTCOME_TO_STATUS.prospect).toBe("prospect");
    expect(OUTCOME_TO_STATUS.sold).toBe("sold");
  });

  it("OUTCOME_META indexes every def by its key", () => {
    for (const o of OUTCOMES) {
      expect(OUTCOME_META[o.key]).toBe(o);
    }
  });
});

describe("deriveWasHome / isKnockOutcome", () => {
  it("wasHome is false ONLY for not_home", () => {
    for (const o of OUTCOMES) {
      expect(deriveWasHome(o.key)).toBe(o.key !== "not_home");
    }
  });

  it("isKnockOutcome accepts all 7 keys and rejects everything else", () => {
    for (const o of OUTCOMES) {
      expect(isKnockOutcome(o.key)).toBe(true);
    }
    expect(isKnockOutcome("walked_away")).toBe(false);
    expect(isKnockOutcome("")).toBe(false);
    expect(isKnockOutcome(null)).toBe(false);
    expect(isKnockOutcome(undefined)).toBe(false);
    expect(isKnockOutcome(42)).toBe(false);
  });
});

describe("pinDisplayState — truth table", () => {
  it("callback renders as its own display state even though it stores follow_up", () => {
    expect(
      pinDisplayState({ leadStatus: "follow_up", visited: 1, lastOutcome: "callback" }),
    ).toBe("callback");
    // A later follow_up knock reclaims the plain follow_up state.
    expect(
      pinDisplayState({ leadStatus: "follow_up", visited: 1, lastOutcome: "follow_up" }),
    ).toBe("follow_up");
  });

  it("a prospect reset reads as unworked orange again, even though it was knocked", () => {
    expect(
      pinDisplayState({ leadStatus: "prospect", visited: 1, lastOutcome: "prospect" }),
    ).toBe("unworked");
  });

  it("each non-prospect status maps to itself, beating visited/lastOutcome", () => {
    // sold beats visited+not_home: the status IS the disposition once set.
    for (const status of ["sold", "not_interested", "follow_up", "interested", "contacted"]) {
      expect(
        pinDisplayState({ leadStatus: status, visited: 1, lastOutcome: "not_home" }),
      ).toBe(status);
    }
  });

  it("prospect + lastOutcome not_home reads as not_home (visited or not)", () => {
    expect(
      pinDisplayState({ leadStatus: "prospect", visited: 1, lastOutcome: "not_home" }),
    ).toBe("not_home");
    expect(
      pinDisplayState({ leadStatus: "prospect", lastOutcome: "not_home" }),
    ).toBe("not_home");
  });

  it("prospect + visited (boolean OR sqlite 1) with another outcome reads as contacted, never green", () => {
    expect(
      pinDisplayState({ leadStatus: "prospect", visited: true, lastOutcome: "interested" }),
    ).toBe("contacted");
    expect(
      pinDisplayState({ leadStatus: "prospect", visited: 1, lastOutcome: null }),
    ).toBe("contacted");
  });

  it("an unvisited prospect is unworked", () => {
    expect(pinDisplayState({ leadStatus: "prospect" })).toBe("unworked");
    expect(pinDisplayState({ leadStatus: "prospect", visited: 0, lastOutcome: null })).toBe("unworked");
    expect(pinDisplayState({ leadStatus: "prospect", visited: false })).toBe("unworked");
  });

  it("STATE_COLORS covers all 8 pin states with valid hex colors", () => {
    expect(Object.keys(STATE_COLORS).sort()).toEqual([...ALL_PIN_STATES].sort());
    for (const state of ALL_PIN_STATES) {
      expect(STATE_COLORS[state]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("uses canonical field-map colors and aliases callback to Follow-up", () => {
    expect(STATE_COLORS.unworked).toBe("#16A34A");
    expect(STATE_COLORS.not_home).toBe("#EAB308");
    expect(STATE_COLORS.interested).toBe("#8B5CF6");
    expect(STATE_COLORS.callback).toBe("#F97316");
    expect(STATE_COLORS.follow_up).toBe("#F97316");
    expect(STATE_COLORS.sold).toBe("#22C55E");
    expect(STATE_COLORS.not_interested).toBe("#EF4444");
    const canonicalStates: PinDisplayState[] = [
      "unworked", "not_home", "interested", "follow_up", "sold", "not_interested",
    ];
    expect(new Set(canonicalStates.map(s => STATE_COLORS[s])).size).toBe(6);
  });
});

describe("summarizeByDisplayState (lasso breakdown)", () => {
  it("counts by display state in palette order, only present states", () => {
    const items = [
      { leadStatus: "prospect" },                                  // unworked
      { leadStatus: "prospect", lastOutcome: "not_home" },         // not_home
      { leadStatus: "prospect", lastOutcome: "not_home" },         // not_home
      { leadStatus: "sold" },                                      // sold
      { leadStatus: "follow_up", lastOutcome: "callback" },        // callback
    ];
    const out = summarizeByDisplayState(items);
    const asMap = Object.fromEntries(out.map(x => [x.ds, x.count]));
    expect(asMap).toEqual({ unworked: 1, not_home: 2, callback: 1, sold: 1 });
    // total equals input length
    expect(out.reduce((a, x) => a + x.count, 0)).toBe(items.length);
    // ordering follows STATE_COLORS key order (unworked before not_home before …)
    const order = Object.keys(STATE_COLORS);
    const idxs = out.map(x => order.indexOf(x.ds));
    expect(idxs).toEqual([...idxs].sort((a, b) => a - b));
  });

  it("is empty for no items", () => {
    expect(summarizeByDisplayState([])).toEqual([]);
  });
});

describe("BULK_STATUS_OUTCOMES (lasso Modify Status)", () => {
  it("only leadStatus-pure, non-commission dispositions — never sold/not_home/callback", () => {
    expect(BULK_STATUS_OUTCOMES).toContain("prospect");
    expect(BULK_STATUS_OUTCOMES).toContain("interested");
    expect(BULK_STATUS_OUTCOMES).toContain("follow_up");
    expect(BULK_STATUS_OUTCOMES).toContain("not_interested");
    for (const bad of ["sold", "not_home", "callback", "needs_verification"]) {
      expect(BULK_STATUS_OUTCOMES).not.toContain(bad);
      expect(isBulkStatusOutcome(bad)).toBe(false);
    }
  });
  it("every allowed bulk outcome is a real knock outcome with a leadStatus", () => {
    for (const o of BULK_STATUS_OUTCOMES) {
      expect(isKnockOutcome(o)).toBe(true);
      expect(OUTCOME_TO_STATUS[o]).toBeTruthy();
      expect(isBulkStatusOutcome(o)).toBe(true);
    }
  });
});

describe("haversineMeters", () => {
  it("returns 0 for identical points", () => {
    expect(haversineMeters({ lat: 34.9, lng: -79.9 }, { lat: 34.9, lng: -79.9 })).toBe(0);
  });

  it("matches the known distance of one degree of latitude within 1%", () => {
    // 1° of latitude ≈ 111,195 m on a 6,371 km sphere, independent of longitude.
    const d = haversineMeters({ lat: 34.9, lng: -79.9 }, { lat: 35.9, lng: -79.9 });
    expect(d).toBeGreaterThan(111_195 * 0.99);
    expect(d).toBeLessThan(111_195 * 1.01);
  });
});

describe("nearestUnworkedLead", () => {
  const HOME = { lat: 34.9, lng: -79.9 };
  const DEG_PER_METER = 1 / 111_195; // latitude degrees per meter — exact enough at street scale

  function pin(id: number, metersNorth: number, extra: Partial<RoutablePin> = {}): RoutablePin {
    return {
      id,
      lat: HOME.lat + metersNorth * DEG_PER_METER,
      lng: HOME.lng,
      leadStatus: "prospect",
      ...extra,
    };
  }

  it("picks the nearer of two unworked pins", () => {
    const best = nearestUnworkedLead(HOME, [pin(1, 200), pin(2, 50)]);
    expect(best?.id).toBe(2);
  });

  it("skips worked pins (all disposition statuses) in favor of a farther unworked one", () => {
    const worked: RoutablePin[] = [
      pin(1, 10, { leadStatus: "sold", visited: 1 }),
      pin(2, 20, { leadStatus: "not_interested", visited: 1 }),
      pin(3, 30, { leadStatus: "follow_up", visited: 1 }),
      pin(4, 40, { leadStatus: "interested", visited: 1 }),
      pin(5, 50, { leadStatus: "contacted", visited: 1 }),
    ];
    const best = nearestUnworkedLead(HOME, [...worked, pin(6, 300)]);
    expect(best?.id).toBe(6);
  });

  it("INCLUDES a not_home pin — a not-home door is a revisit, not a dead end", () => {
    const notHome = pin(1, 50, { leadStatus: "prospect", visited: 1, lastOutcome: "not_home" });
    const best = nearestUnworkedLead(HOME, [notHome, pin(2, 200)]);
    expect(best?.id).toBe(1);
  });

  it("respects excludeIds (skips the current/just-knocked door)", () => {
    const best = nearestUnworkedLead(HOME, [pin(1, 50), pin(2, 200)], new Set([1]));
    expect(best?.id).toBe(2);
  });

  it("returns null when everything is worked, and on an empty list", () => {
    const allWorked = [
      pin(1, 10, { leadStatus: "sold", visited: 1 }),
      pin(2, 20, { leadStatus: "not_interested", visited: 1 }),
    ];
    expect(nearestUnworkedLead(HOME, allWorked)).toBeNull();
    expect(nearestUnworkedLead(HOME, [])).toBeNull();
  });

  it("skips pins with NaN/undefined coordinates instead of crashing", () => {
    const bad: RoutablePin[] = [
      { id: 1, lat: NaN, lng: HOME.lng, leadStatus: "prospect" },
      { id: 2, lat: HOME.lat, lng: undefined as unknown as number, leadStatus: "prospect" },
    ];
    const best = nearestUnworkedLead(HOME, [...bad, pin(3, 100)]);
    expect(best?.id).toBe(3);
  });

  it("tie-breaks within 0.5m by higher leadScore, then lower id", () => {
    // Same coordinates = same distance: the better lead wins…
    const byScore = nearestUnworkedLead(HOME, [
      pin(9, 50, { leadScore: 10 }),
      pin(2, 50, { leadScore: 80 }),
    ]);
    expect(byScore?.id).toBe(2);
    // …and equal scores fall back to the lower id (stable ordering).
    const byId = nearestUnworkedLead(HOME, [
      pin(9, 50, { leadScore: 10 }),
      pin(3, 50, { leadScore: 10 }),
    ]);
    expect(byId?.id).toBe(3);
  });
});

describe("retryDelayMs", () => {
  it("starts at 2s, doubles per attempt, caps at 60s", () => {
    expect(retryDelayMs(0)).toBe(2_000);
    expect(retryDelayMs(1)).toBe(4_000);
    expect(retryDelayMs(2)).toBe(8_000);
    expect(retryDelayMs(4)).toBe(32_000);
    expect(retryDelayMs(5)).toBe(60_000); // 64s uncapped → clamped
    expect(retryDelayMs(20)).toBe(60_000);
    expect(KNOCK_QUEUE_MAX_ATTEMPTS).toBe(8);
  });
});

describe("distanceHint", () => {
  it("shows rounded meters under 400m, tenth-miles above", () => {
    expect(distanceHint(40)).toBe("40m");
    expect(distanceHint(250.4)).toBe("250m");
    expect(distanceHint(400)).toBe("0.2mi");
    expect(distanceHint(800)).toBe("0.5mi");
    expect(distanceHint(1609.34)).toBe("1.0mi");
    expect(distanceHint(5000)).toBe("3.1mi");
  });
});

describe("makeClientId", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns non-empty, unique-ish strings", () => {
    const ids = Array.from({ length: 100 }, () => makeClientId());
    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }
    expect(new Set(ids).size).toBe(100);
  });

  it("falls back to a k- prefixed id when crypto is unavailable", () => {
    vi.stubGlobal("crypto", undefined);
    const id = makeClientId();
    expect(id).toMatch(/^k-/);
    expect(id.length).toBeGreaterThan(10);
    expect(makeClientId()).not.toBe(id); // still unique without crypto
  });
});
