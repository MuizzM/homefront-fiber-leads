import { describe, expect, it } from "vitest";
import {
  ICON_PREFIX, PIN_DATA_URLS, PIN_SVGS, STATUS_ICON,
  iconImageConcatExpression, registerPinImages, spriteDataUrl,
} from "../../client/src/lib/statusIcons";
import { LEAD_MAP_STATUSES, STATUS_CONFIG, toLeadMapStatus } from "../../shared/statusConfig";

describe("canonical lead status pins", () => {
  it("has exactly the six requested statuses and colors", () => {
    expect(LEAD_MAP_STATUSES).toEqual([
      "not_home", "interested", "sold", "not_interested", "prospect", "follow_up",
    ]);
    expect(STATUS_CONFIG.not_home.color).toBe("#EAB308");
    expect(STATUS_CONFIG.interested.color).toBe("#8B5CF6");
    expect(STATUS_CONFIG.sold.color).toBe("#22C55E");
    expect(STATUS_CONFIG.not_interested.color).toBe("#EF4444");
    expect(STATUS_CONFIG.prospect.color).toBe("#16A34A");
    expect(STATUS_CONFIG.follow_up.color).toBe("#F97316");
  });

  it("keeps every status distinct by shape, glyph, and color together", () => {
    const tuples = LEAD_MAP_STATUSES.map((status) => {
      const config = STATUS_CONFIG[status];
      return `${config.shape}/${config.glyph}/${config.color}`;
    });
    expect(new Set(tuples).size).toBe(6);
  });

  it("keeps Sold and Prospect visibly different under glare", () => {
    expect(STATUS_CONFIG.sold).toMatchObject({ shape: "teardrop", glyph: "dollar" });
    expect(STATUS_CONFIG.prospect).toMatchObject({ shape: "down_arrow", glyph: "none" });
    expect(PIN_SVGS.sold).toContain(">$</text>");
    expect(PIN_SVGS.prospect).toContain("M20 10v12");
  });

  it("uses red X for Not Interested and orange clock for Follow-up", () => {
    expect(PIN_SVGS.not_interested).toContain(STATUS_CONFIG.not_interested.color);
    expect(PIN_SVGS.not_interested).toContain("m13 13 14 14");
    expect(PIN_SVGS.follow_up).toContain(STATUS_CONFIG.follow_up.color);
    expect(PIN_SVGS.follow_up).toContain("<circle cx=\"20\" cy=\"20\" r=\"9\"");
  });

  it("provides one inline SVG/data URL named pin-<status> per status", () => {
    for (const status of LEAD_MAP_STATUSES) {
      expect(PIN_SVGS[status].startsWith("<svg")).toBe(true);
      expect(PIN_DATA_URLS[status].startsWith("data:image/svg+xml")).toBe(true);
      expect(`${ICON_PREFIX}${status}`).toBe(`pin-${status}`);
      expect(spriteDataUrl(status)).toBe(PIN_DATA_URLS[status]);
    }
  });
});

describe("data-driven Mapbox symbol mapping", () => {
  it("uses the required concat expression over feature status", () => {
    expect(iconImageConcatExpression()).toEqual(["concat", "pin-", ["get", "status"]]);
  });

  it("folds callback and legacy states into the six pin statuses", () => {
    expect(toLeadMapStatus("callback")).toBe("follow_up");
    expect(toLeadMapStatus("unworked")).toBe("prospect");
    expect(toLeadMapStatus("contacted")).toBe("prospect");
    expect(STATUS_ICON.callback.key).toBe("pin-follow_up");
    expect(STATUS_ICON.unworked.key).toBe("pin-prospect");
  });

  it("registers all six inline assets through loadImage + addImage", async () => {
    const images = new Set<string>();
    const loaded: string[] = [];
    const map = {
      hasImage: (id: string) => images.has(id),
      loadImage: (url: string, callback: (error: null, image: ImageData) => void) => {
        loaded.push(url);
        callback(null, {} as ImageData);
      },
      addImage: (id: string) => { images.add(id); },
    };
    await registerPinImages(map);
    expect(loaded).toHaveLength(6);
    expect([...images].sort()).toEqual(LEAD_MAP_STATUSES.map(status => `pin-${status}`).sort());
  });
});
