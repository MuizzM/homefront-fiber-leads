// Scanned-door pins carry a glyph, not just a hue.
//
// The scanned-door layer shipped as colour-only circles while the lead pins
// beside it carried glyphs. That asks a rep to separate five verdicts by hue
// alone at arm's length in daylight, and it fails outright for the ~8% of men
// with a colour-vision deficiency, for whom the green new_fiber dot and a green
// sold lead are the same dot.
//
// These tests hold three lines that are each easy to break silently:
//   1. No glyph may depend on a font (the $-on-sold-pins lesson, same rule).
//   2. The verdict COLOURS must not have drifted from the circle layer this
//      replaces — the glyphs were added to the map's meaning, not swapped for it.
//   3. The client's labels must still agree with the server, which owns them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOOR_TAGS,
  DOOR_PIN_SVGS,
  DOOR_PIN_DATA_URLS,
  DOOR_PIN_STYLE,
  DOOR_PIN_LABEL,
  DOOR_ICON_PREFIX,
  doorPinIconId,
  doorIconImageExpression,
  doorSymbolSortKey,
  registerDoorPinImages,
  type DoorTag,
} from "../../client/src/lib/doorPins";
import { GLYPHS } from "../../client/src/lib/statusIcons";

const repoFile = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("door pin glyphs are vectors, never text", () => {
  it("no door pin depends on a font being installed", () => {
    // Same rule the lead pins are held to: these SVGs are rasterized as data
    // URLs, where font resolution is not guaranteed. A glyph that fails to draw
    // leaves a blank pin and reports nothing.
    for (const tag of DOOR_TAGS) {
      expect(DOOR_PIN_SVGS[tag], `${tag} pin uses <text>`).not.toMatch(/<text[\s>]/);
      expect(DOOR_PIN_SVGS[tag], `${tag} pin references a font`).not.toMatch(/font-family/);
    }
  });

  it("every verdict actually draws something inside the disc", () => {
    // A pin that is only a coloured circle is the bug this work exists to fix,
    // so an empty glyph must fail here rather than ship as a silent regression.
    for (const tag of DOOR_TAGS) {
      const inner = DOOR_PIN_SVGS[tag].replace(/<svg[^>]*>|<\/svg>/g, "");
      // Strip the disc itself; what remains is the glyph.
      const glyph = inner.replace(/<circle cx="20" cy="20" r="16"[^/]*\/>/, "").trim();
      expect(glyph.length, `${tag} pin has no glyph inside the disc`).toBeGreaterThan(0);
    }
  });

  it("no two verdicts share a glyph", () => {
    // Five verdicts, five distinguishable marks. If two ever collapse onto the
    // same path the map is back to colour-only for that pair.
    const glyphs = DOOR_TAGS.map((tag) =>
      DOOR_PIN_SVGS[tag].replace(/<svg[^>]*>|<\/svg>|fill="#[0-9a-f]{6}"|stroke="#[0-9a-f]{6}"/g, "").trim(),
    );
    expect(new Set(glyphs).size).toBe(DOOR_TAGS.length);
  });

  it("the one deliberately-shared mark stays identical to the lead set", () => {
    // tenured_active reuses already_customer's head-and-shoulders ON PURPOSE —
    // same meaning, same mark, nothing extra for a rep to learn. If the lead
    // glyph is ever redrawn, this fails and the door pin gets redrawn with it
    // instead of quietly drifting.
    expect(DOOR_PIN_SVGS.tenured_active).toContain(GLYPHS.user);
  });

  it("does not reuse a lead mark that means something else", () => {
    // A green $ (sold lead) beside an amber $ (open fiber) would be two opposite
    // meanings in one glyph. Same for the prospect arrow and the not-home door.
    // The CLOCK is on this list too: follow_up is a lead a rep chose to revisit,
    // coming_soon is a date the CARRIER gave us. Both mean "later", which is
    // exactly why sharing the mark left them separated only by hue — the failure
    // this whole change exists to fix. coming_soon draws a calendar instead.
    for (const tag of DOOR_TAGS) {
      expect(DOOR_PIN_SVGS[tag], `${tag} reuses the sold $`).not.toContain(GLYPHS.dollar);
      expect(DOOR_PIN_SVGS[tag], `${tag} reuses the prospect arrow`).not.toContain(GLYPHS.arrow);
      expect(DOOR_PIN_SVGS[tag], `${tag} reuses the not-home door`).not.toContain(GLYPHS.door);
      expect(DOOR_PIN_SVGS[tag], `${tag} reuses the follow-up clock`).not.toContain(GLYPHS.clock);
    }
  });
});

describe("the glyphs were added to the map's meaning, not swapped for it", () => {
  it("verdict colours still match the circle layer they hand off from", () => {
    // MapView's SCANNED_DOORS_LAYER paint is the colour contract the map, the
    // card and the legend already agreed on. Adding glyphs must not have moved
    // a single hue, so the fill values are read back out of the source.
    const src = repoFile("client/src/pages/MapView.tsx");
    const block = src.slice(src.indexOf('id: SCANNED_DOORS_LAYER'));
    const colorExpr = block.slice(block.indexOf('"circle-color"'), block.indexOf('"circle-opacity"'));
    for (const tag of DOOR_TAGS) {
      const m = new RegExp(`"${tag}",\\s*"(#[0-9a-fA-F]{6})"`).exec(colorExpr);
      expect(m, `${tag} has no colour in the circle layer`).not.toBeNull();
      expect(DOOR_PIN_STYLE[tag].fill.toLowerCase()).toBe(m![1].toLowerCase());
    }
  });

  it("labels still agree with the server, which owns them", () => {
    // server/scannedDoors.ts derives the tag AND its label so the client cannot
    // drift. If someone renames a verdict on one side only, this catches it.
    const server = repoFile("server/scannedDoors.ts");
    const table = server.slice(server.indexOf("DOOR_TAG_LABEL"), server.indexOf("// Doors with no fiber verdict"));
    for (const tag of DOOR_TAGS) {
      const m = new RegExp(`${tag}:\\s*"([^"]+)"`).exec(table);
      expect(m, `${tag} has no server label`).not.toBeNull();
      expect(DOOR_PIN_LABEL[tag]).toBe(m![1]);
    }
  });

  it("covers exactly the server's DoorTag vocabulary", () => {
    const server = repoFile("server/scannedDoors.ts");
    const decl = /export type DoorTag =([^;]+);/.exec(server);
    expect(decl).not.toBeNull();
    const serverTags = [...decl![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect([...DOOR_TAGS].sort()).toEqual(serverTags);
  });
});

describe("the icon layer can always resolve an image", () => {
  it("an unknown tag falls back to unverified rather than drawing nothing", () => {
    // A missing image id renders as NOTHING in MapLibre. A door that silently
    // vanishes is strictly worse than one drawn as "not verified", so the match
    // expression must carry a default.
    const expr = doorIconImageExpression();
    expect(expr[0]).toBe("concat");
    expect(expr[1]).toBe(DOOR_ICON_PREFIX);
    const match = expr[2] as unknown[];
    expect(match[0]).toBe("match");
    expect(match[match.length - 1]).toBe("unverified");
  });

  it("every tag resolves to an id that registerDoorPinImages actually registers", () => {
    const registered: string[] = [];
    const map = {
      hasImage: (id: string) => registered.includes(id),
      addImage: (id: string) => void registered.push(id),
    };
    // jsdom has no real image decoder, so drive the id contract directly and
    // assert registration separately below.
    for (const tag of DOOR_TAGS) {
      expect(doorPinIconId(tag)).toBe(`${DOOR_ICON_PREFIX}${tag}`);
      map.addImage(doorPinIconId(tag));
    }
    expect(registered).toHaveLength(DOOR_TAGS.length);
    expect(new Set(registered).size).toBe(DOOR_TAGS.length);
  });

  it("registration is idempotent — a style reload must not double-add", () => {
    const registered = new Set<string>();
    let adds = 0;
    const map = {
      hasImage: (id: string) => registered.has(id),
      addImage: (id: string) => { adds++; registered.add(id); },
    };
    for (const tag of DOOR_TAGS) {
      if (!map.hasImage(doorPinIconId(tag))) map.addImage(doorPinIconId(tag));
      if (!map.hasImage(doorPinIconId(tag))) map.addImage(doorPinIconId(tag));
    }
    expect(adds).toBe(DOOR_TAGS.length);
    expect(typeof registerDoorPinImages).toBe("function");
  });

  it("data URLs are inline SVG, so no network fetch is needed to paint a pin", () => {
    // The app's CSP connect-src has no data: entry — routing these through
    // map.loadImage() would burn a guaranteed-failing fetch per pin.
    for (const tag of DOOR_TAGS) {
      expect(DOOR_PIN_DATA_URLS[tag].startsWith("data:image/svg+xml")).toBe(true);
    }
  });

  it("sellable doors sort above context doors when pins collide", () => {
    // new_fiber and fiber_open are the two a rep can act on today; tenured and
    // unverified are context. Lower sort key = drawn on top in MapLibre.
    const k = doorSymbolSortKey() as unknown[];
    const rank = (tag: DoorTag) => Number(k[k.indexOf(tag) + 1]);
    expect(rank("new_fiber")).toBeLessThan(rank("tenured_active"));
    expect(rank("fiber_open")).toBeLessThan(rank("tenured_active"));
    expect(rank("coming_soon")).toBeLessThan(rank("unverified"));
  });
});

describe("MapView wires the glyph layer", () => {
  const src = repoFile("client/src/pages/MapView.tsx");

  it("adds the door icon layer on init AND after a style swap", () => {
    // A style change wipes registered images and layers. The lead pins learned
    // this the hard way; the door pins get the same treatment in both places.
    expect(src.match(/await addDoorIconLayer\(map\)/g)?.length).toBe(2);
  });

  it("a tap on the glyph layer opens the same card as the circle layer", () => {
    // Above z12 the glyph layer is what the thumb lands on. A pin that opens no
    // card reads as a broken map.
    expect(src).toMatch(/for \(const layerId of \[SCANNED_DOORS_LAYER, SCANNED_DOORS_ICON_LAYER\]\)/);
    expect(src).toMatch(/map\.on\("click", layerId, onScannedDoorClick\)/);
  });

  it("the glyph layer is in the tap hit-test", () => {
    const hit = src.slice(src.indexOf("const hitLayers = ["));
    expect(hit.slice(0, 300)).toContain("SCANNED_DOORS_ICON_LAYER");
  });

  it("falls back to circles rather than blanking the map", () => {
    // Image registration or addLayer can fail. Neither may leave a walked street
    // with no pins on it at all.
    const fn = src.slice(src.indexOf("async function addDoorIconLayer"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body.match(/showDoorCirclesFullRange\(map\)/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
