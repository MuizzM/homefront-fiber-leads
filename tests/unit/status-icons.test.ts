import { describe, expect, it } from "vitest";
import {
  ICON_PREFIX, KNOCK_BADGE_BUCKETS, KNOCK_BADGE_MAX, KNOCK_BADGE_MIN,
  PIN_DATA_URLS, PIN_PIXEL_RATIO, PIN_SVGS, STATUS_ICON,
  iconImageConcatExpression, knockBadgeBucket, pinCountSvg, pinIconId,
  registerPinImages, spriteDataUrl,
} from "../../client/src/lib/statusIcons";
import { LEAD_MAP_STATUSES, STATUS_CONFIG, toLeadMapStatus } from "../../shared/statusConfig";

describe("canonical lead status pins", () => {
  it("has exactly the seven statuses and colors", () => {
    expect(LEAD_MAP_STATUSES).toEqual([
      "not_home", "interested", "sold", "not_interested", "prospect", "follow_up", "already_customer",
    ]);
    expect(STATUS_CONFIG.already_customer.color).toBe("#2563EB");
    expect(STATUS_CONFIG.not_home.color).toBe("#EAB308");
    expect(STATUS_CONFIG.interested.color).toBe("#8B5CF6");
    expect(STATUS_CONFIG.sold.color).toBe("#14532D");
    expect(STATUS_CONFIG.not_interested.color).toBe("#EF4444");
    expect(STATUS_CONFIG.prospect.color).toBe("#16A34A");
    expect(STATUS_CONFIG.follow_up.color).toBe("#F97316");
  });

  it("renders every status as a flat circle — identity lives in glyph + color", () => {
    // SalesRabbit reference: one silhouette, seven glyph/colour identities.
    for (const status of LEAD_MAP_STATUSES) {
      expect(STATUS_CONFIG[status].shape).toBe("circle");
      expect(PIN_SVGS[status]).toContain(`r="16" fill="${STATUS_CONFIG[status].color}"`);
    }
    const tuples = LEAD_MAP_STATUSES.map((status) => {
      const config = STATUS_CONFIG[status];
      return `${config.glyph}/${config.color}`;
    });
    expect(new Set(tuples).size).toBe(7);
  });

  it("keeps Sold and Prospect visibly different under glare", () => {
    expect(STATUS_CONFIG.sold).toMatchObject({ shape: "circle", glyph: "dollar" });
    expect(STATUS_CONFIG.prospect).toMatchObject({ shape: "circle", glyph: "arrow" });
    // Asserts a dollar is DRAWN, not how. This previously pinned `>$</text>`,
    // which locked in the one font-dependent glyph in the set — the reason sold
    // pins came up blank on devices without Arial. Vector strokes now.
    expect(PIN_SVGS.sold).not.toMatch(/<text[\s>]/);
    expect(PIN_SVGS.sold).toContain("M20 9.5v21");
    expect(PIN_SVGS.prospect).toContain("M20 12.5v13");
  });

  it("uses red X for Not Interested and orange clock for Follow-up", () => {
    expect(PIN_SVGS.not_interested).toContain(STATUS_CONFIG.not_interested.color);
    expect(PIN_SVGS.not_interested).toContain("m13 13 14 14");
    expect(PIN_SVGS.follow_up).toContain(STATUS_CONFIG.follow_up.color);
    expect(PIN_SVGS.follow_up).toContain("<circle cx=\"20\" cy=\"20\" r=\"9\"");
  });

  it("gives every pin the crisp white outer ring, bolder once worked", () => {
    // Same 2.5/1.5 semantics as the circle fallback layer's visited case —
    // the two renderers must agree about what a heavier ring means.
    expect(PIN_SVGS.prospect).toContain('stroke="#fff" stroke-width="1.5"');
    for (const status of LEAD_MAP_STATUSES) {
      if (status === "prospect") continue;
      expect(PIN_SVGS[status]).toContain('stroke="#fff" stroke-width="2.5"');
    }
  });

  it("marks the unworked door with the white top-right badge — and only that door", () => {
    // The reference's "?" disc; ours is a neutral vector dot on the white disc.
    expect(PIN_SVGS.prospect).toContain('cx="32" cy="8" r="7" fill="#fff"');
    expect(PIN_SVGS.prospect).toContain('r="2.2" fill="#334155"');
    for (const status of LEAD_MAP_STATUSES) {
      if (status === "prospect") continue;
      expect(PIN_SVGS[status], `${status} must carry no unworked badge`).not.toContain('r="7" fill="#fff"');
    }
  });

  it("provides one inline SVG/data URL named pin-<status> per status", () => {
    for (const status of LEAD_MAP_STATUSES) {
      expect(PIN_SVGS[status].trimStart().startsWith("<svg")).toBe(true);
      expect(PIN_DATA_URLS[status].startsWith("data:image/svg+xml")).toBe(true);
      expect(`${ICON_PREFIX}${status}`).toBe(`pin-${status}`);
      expect(spriteDataUrl(status)).toBe(PIN_DATA_URLS[status]);
    }
  });
});

describe("knock-count badge", () => {
  it("buckets the count: none below 2, exact through 9, then the 9+ bucket", () => {
    expect(knockBadgeBucket(undefined)).toBe(0);
    expect(knockBadgeBucket(null)).toBe(0);
    expect(knockBadgeBucket(0)).toBe(0);
    expect(knockBadgeBucket(1)).toBe(0);
    for (let n = 2; n <= 9; n++) expect(knockBadgeBucket(n)).toBe(n);
    expect(knockBadgeBucket(10)).toBe(KNOCK_BADGE_MAX);
    expect(knockBadgeBucket(47)).toBe(KNOCK_BADGE_MAX);
  });

  it("names icons pin-<status> plain and pin-<status>-k<bucket> once knocked twice", () => {
    expect(pinIconId("sold")).toBe("pin-sold");
    expect(pinIconId("sold", 1)).toBe("pin-sold");
    expect(pinIconId("sold", 2)).toBe("pin-sold-k2");
    expect(pinIconId("not_home", 12)).toBe(`pin-not_home-k${KNOCK_BADGE_MAX}`);
  });

  it("draws the count as vector strokes on the white disc — dark on white, no fonts", () => {
    for (const bucket of KNOCK_BADGE_BUCKETS) {
      const svg = pinCountSvg("not_home", bucket);
      expect(svg).toContain('cx="32" cy="8" r="7" fill="#fff"');
      expect(svg).toContain('stroke="#0f172a"');
      expect(svg).not.toMatch(/<text[\s>]/);
      expect(svg).not.toMatch(/font-family/);
    }
  });

  it("renders the overflow bucket as 9-plus (a nine AND a plus stroke)", () => {
    const svg = pinCountSvg("follow_up", KNOCK_BADGE_MAX);
    expect(svg).toContain("M1.9 0H-1.9V-3.2H1.9V3.2H-1.9"); // the nine
    expect(svg).toContain("M33.8 8H36.6M35.2 6.6V9.4");     // the plus
  });

  it("count badge replaces the unworked dot on a re-pooled prospect", () => {
    const svg = pinCountSvg("prospect", 3);
    expect(svg).not.toContain('r="2.2" fill="#334155"');
    expect(svg).toContain('stroke="#0f172a"');
  });
});

describe("data-driven Mapbox symbol mapping", () => {
  it("keys the icon off status plus the bucketed knock count", () => {
    const knocks = ["coalesce", ["get", "knocks"], 0];
    expect(iconImageConcatExpression()).toEqual([
      "concat", "pin-", ["get", "status"],
      [
        "case",
        [">=", knocks, KNOCK_BADGE_MIN],
        ["concat", "-k", ["to-string", ["min", knocks, KNOCK_BADGE_MAX]]],
        "",
      ],
    ]);
  });

  it("folds callback and legacy states into the six pin statuses", () => {
    expect(toLeadMapStatus("callback")).toBe("follow_up");
    expect(toLeadMapStatus("unworked")).toBe("prospect");
    expect(toLeadMapStatus("contacted")).toBe("prospect");
    expect(STATUS_ICON.callback.key).toBe("pin-follow_up");
    expect(STATUS_ICON.unworked.key).toBe("pin-prospect");
  });

  it("registers the base pins AND every count variant via the browser decoder, never a data: fetch", async () => {
    // The pins are inline data: SVGs. map.loadImage would fetch() them, and the
    // app's CSP connect-src has no data: entry — so registerOne now decodes
    // data: URLs with an <img> element and NEVER touches map.loadImage. Stub a
    // synchronously-loading Image so the decode path resolves under jsdom.
    const RealImage = globalThis.Image;
    class InstantImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_v: string) { queueMicrotask(() => this.onload?.()); }
    }
    // @ts-expect-error test stub
    globalThis.Image = InstantImage;
    try {
      const images = new Map<string, { pixelRatio?: number } | undefined>();
      const loaded: string[] = [];
      const map = {
        hasImage: (id: string) => images.has(id),
        loadImage: (url: string, callback: (error: null, image: ImageData) => void) => {
          loaded.push(url);
          callback(null, {} as ImageData);
        },
        addImage: (id: string, _image: unknown, options?: { pixelRatio?: number }) => { images.set(id, options); },
      };
      await registerPinImages(map as any);
      // Every URL is a data: URL, so the CSP-blocked Mapbox fetch path must
      // never be exercised.
      expect(loaded).toHaveLength(0);
      const ids = [...images.keys()].sort();
      const expected = LEAD_MAP_STATUSES.flatMap((status) => [
        `pin-${status}`,
        ...KNOCK_BADGE_BUCKETS.map((bucket) => `pin-${status}-k${bucket}`),
      ]).sort();
      expect(ids).toEqual(expected);
      // 2x raster + pixelRatio keeps the ring/digits crisp at 40 logical px.
      for (const options of images.values()) {
        expect(options).toEqual({ pixelRatio: PIN_PIXEL_RATIO });
      }
    } finally {
      globalThis.Image = RealImage;
    }
  });
});
