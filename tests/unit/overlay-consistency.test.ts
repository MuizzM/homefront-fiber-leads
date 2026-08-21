import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * ONE scrim behind every dialog, sheet and drawer.
 *
 * The same effect had drifted into six spellings - bg-black/40, /50, /55, /60,
 * /80 and /90 - across 17 files, so how dark the app went behind a modal
 * depended on which screen you opened it from. Nothing looks wrong in any one
 * file; it is only visible by comparing screens, which is what a test can do
 * and a reviewer cannot.
 *
 * `bg-overlay` carries its own alpha (see --overlay in index.css), so a call
 * site cannot pick an opacity even by accident.
 */
const clientDir = path.resolve(__dirname, "../../client/src");

/** Every .tsx under client/src, recursively. */
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith(".tsx") ? [full] : [];
  });
}

// The photo lightbox is not a scrim. It is a full-screen viewer whose backdrop
// is deliberately near-opaque black so nothing of the app tints the image, and
// it stays black in both themes. Exactly ONE component may be that viewer —
// every photo surface (PropertyDetail, the map card) renders it — so the
// exemption is a single shared file, never a growing list.
const LIGHTBOX = "components/PhotoLightbox.tsx";

describe("one modal scrim app-wide", () => {
  it("no screen hand-rolls a black scrim", () => {
    const offenders: string[] = [];
    for (const file of sources(clientDir)) {
      const rel = path.relative(clientDir, file);
      if (rel.split(path.sep).join("/") === LIGHTBOX) continue;
      const source = fs.readFileSync(file, "utf8");
      for (const hit of source.matchAll(/bg-black\/\d+/g)) {
        offenders.push(`${rel}: ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the scrim's opacity in the token, not at the call site", () => {
    // `bg-overlay/50` would re-open the drift by multiplying the token's alpha.
    const offenders: string[] = [];
    for (const file of sources(clientDir)) {
      const source = fs.readFileSync(file, "utf8");
      for (const hit of source.matchAll(/bg-overlay\/\d+/g)) {
        offenders.push(`${path.relative(clientDir, file)}: ${hit[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
