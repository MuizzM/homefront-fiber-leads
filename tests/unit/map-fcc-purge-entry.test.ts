// "Remove FCC imports" — the More-menu entry's gate, pinned at source level
// (same spirit as map-chrome-minimal.test.ts: rendering MapView for real needs
// mapbox + ~8k lines of page, and these are wiring properties the source
// states directly).
//
// Contract: the entry and the FccPurgeDialog mount both sit behind
// canReclaimAll — the SAME permission-table check the reclaim-all sweep uses
// (admin / super_admin), never a wider or hard-coded role list. The menu tap
// only OPENS the staged dialog; the destructive POST lives behind the typed
// confirm inside it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const src = readFileSync(join(ROOT, "client/src/pages/MapView.tsx"), "utf8");

describe("Remove FCC imports - More-menu entry", () => {
  it("exists as a More-menu entry with the destructive label", () => {
    expect(src).toContain('testid: "ctl-fcc-purge"');
    expect(src).toContain('label: "Remove FCC imports"');
  });

  it("is gated by canReclaimAll - the reclaim-all permission check, never a new/wider gate", () => {
    // canReclaimAll must come from the shared permission table…
    expect(src).toContain('const canReclaimAll = roleCan(user?.role, "reclaim_all_territories")');
    // …and the entry's spread must sit directly behind it.
    const entry = src.indexOf('testid: "ctl-fcc-purge"');
    expect(entry).toBeGreaterThan(-1);
    const gate = src.lastIndexOf("...(canReclaimAll", entry);
    expect(gate, "fcc-purge entry must be spread behind canReclaimAll").toBeGreaterThan(-1);
    // No other conditional spread starts between the gate and the entry.
    expect(src.slice(gate + "...(canReclaimAll".length, entry)).not.toContain("...(can");
  });

  it("the menu tap only opens the dialog - the purge itself stays behind the typed confirm", () => {
    const entry = src.slice(src.indexOf('key: "fcc-purge"'), src.indexOf('testid: "ctl-fcc-purge"') + 400);
    expect(entry).toContain("setFccPurgeOpen(true)");
    expect(entry).not.toContain("apiRequest");
  });

  it("the FccPurgeDialog mounts behind the same canReclaimAll gate", () => {
    const mount = src.indexOf("<FccPurgeDialog");
    expect(mount).toBeGreaterThan(-1);
    const before = src.slice(mount - 400, mount);
    expect(before).toContain("{canReclaimAll && (");
  });
});
