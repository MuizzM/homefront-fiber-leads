// Pin glyphs and card legibility.
//
// Two field-reported symptoms, both real and both measurable:
//   "the dollar sign isn't showing on sold pins"
//   "SOLD is unreadable on the card"
//
// The first was the only glyph in the set drawn with <text> instead of a path.
// These SVGs are rasterized as data-URL images, where font resolution is not
// guaranteed — Arial is absent on most Android devices, which is exactly the
// hardware reps carry. A glyph that fails to draw leaves a blank pin, with no
// error anywhere.
//
// The second is arithmetic: sold's pin colour used as TEXT on the dark card
// gives 2.1:1, well under the 4.5:1 readable minimum.
import { describe, expect, it } from "vitest";
import {
  KNOCK_BADGE_BUCKETS, PIN_SVGS, PIN_DATA_URLS, pinCountSvg,
} from "../../client/src/lib/statusIcons";
import { STATUS_CONFIG, LEAD_MAP_STATUSES } from "../../shared/statusConfig";

/** WCAG relative luminance. */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  const f = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The dark surface the lead card is drawn on. */
const CARD_BG = "#0B0F14";
const MIN_TEXT_CONTRAST = 4.5;

describe("pin glyphs are vectors, never text", () => {
  it("no pin SVG depends on a font being installed", () => {
    // The whole point: a device without Arial must still show a $ on a sold pin.
    // The knock-count badge digits are held to the same rule — they are the
    // most tempting place to sneak a <text> back in.
    for (const status of LEAD_MAP_STATUSES) {
      expect(PIN_SVGS[status], `${status} pin uses <text>`).not.toMatch(/<text[\s>]/);
      expect(PIN_SVGS[status], `${status} pin references a font`).not.toMatch(/font-family/);
      for (const bucket of KNOCK_BADGE_BUCKETS) {
        const badged = pinCountSvg(status, bucket);
        expect(badged, `${status} k${bucket} uses <text>`).not.toMatch(/<text[\s>]/);
        expect(badged, `${status} k${bucket} references a font`).not.toMatch(/font-family/);
      }
    }
  });

  it("the sold pin still draws a dollar - vector strokes, not a glyph name", () => {
    const sold = PIN_SVGS.sold;
    // A vertical bar plus the S-curve: two stroked paths over the circle.
    const strokedPaths = sold.match(/<path[^>]*stroke="#fff"/g) ?? [];
    expect(strokedPaths.length).toBeGreaterThanOrEqual(2);
    expect(sold).toContain(STATUS_CONFIG.sold.color); // the disc keeps its fill
  });

  it("the prospect pin keeps its down arrow - now as the glyph inside the circle", () => {
    // The silhouette went flat-circle for every status (SalesRabbit reference);
    // the arrow survived as prospect's inner glyph so the learned vocabulary holds.
    expect(PIN_SVGS.prospect).toMatch(/M20 12\.5v13m-5\.5-5\.5 5\.5 5\.5 5\.5-5\.5/);
    expect(STATUS_CONFIG.prospect.shape).toBe("circle");
    expect(STATUS_CONFIG.prospect.glyph).toBe("arrow");
  });

  it("every status still produces a loadable data URL", () => {
    for (const status of LEAD_MAP_STATUSES) {
      expect(PIN_DATA_URLS[status]).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
      // Encoded payload must round-trip — a stray unescaped char breaks the image
      // silently, which is the same failure mode as the missing glyph.
      const decoded = decodeURIComponent(PIN_DATA_URLS[status].split(",")[1]);
      expect(decoded).toBe(PIN_SVGS[status]);
    }
  });
});

describe("card text is readable on the dark sheet", () => {
  it("every status label clears the 4.5:1 minimum", () => {
    for (const status of LEAD_MAP_STATUSES) {
      const cfg = STATUS_CONFIG[status];
      const cardColor = cfg.onDark ?? cfg.color;
      const ratio = contrast(cardColor, CARD_BG);
      expect(ratio, `${status} renders at ${ratio.toFixed(2)}:1 on the card`)
        .toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  });

  it("sold specifically - the one that failed - is now legible", () => {
    // Before: #14532D at 2.11:1, effectively invisible.
    expect(STATUS_CONFIG.sold.onDark).toBeTruthy();
    expect(contrast(STATUS_CONFIG.sold.onDark!, CARD_BG)).toBeGreaterThan(7);
  });

  it("the MAP colour is untouched - pins must stay distinguishable from prospect", () => {
    // The fix must not leak into the map: sold's deep green exists so a sold pin
    // never reads as a prospect pin at zoom.
    expect(STATUS_CONFIG.sold.color).toBe("#14532D");
    expect(STATUS_CONFIG.sold.color).not.toBe(STATUS_CONFIG.prospect.color);
  });

  it("sold and prospect stay tellable apart on the card too", () => {
    // Both are green; if the readable variant drifted toward prospect's green the
    // card would lose the distinction the map deliberately keeps.
    const soldCard = STATUS_CONFIG.sold.onDark!;
    expect(Math.abs(luminance(soldCard) - luminance(STATUS_CONFIG.prospect.color)))
      .toBeGreaterThan(0.1);
  });

  it("only statuses that need an override have one", () => {
    // onDark is a correction, not a second palette — if a pin colour is already
    // readable it must keep using it, so the two can't drift apart.
    for (const status of LEAD_MAP_STATUSES) {
      const cfg = STATUS_CONFIG[status];
      if (!cfg.onDark) continue;
      expect(contrast(cfg.color, CARD_BG), `${status} has an override it doesn't need`)
        .toBeLessThan(MIN_TEXT_CONTRAST);
    }
  });
});

describe("every status has a card icon to render", () => {
  it("so the status line can always show its glyph", () => {
    for (const status of LEAD_MAP_STATUSES) {
      expect(STATUS_CONFIG[status].cardIcon).toBeTruthy();
    }
    expect(STATUS_CONFIG.sold.cardIcon).toBe("DollarSign");
    expect(STATUS_CONFIG.prospect.cardIcon).toBe("ArrowDown");
  });
});
