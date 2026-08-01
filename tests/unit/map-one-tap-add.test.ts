// One-tap add-lead is OPTIMISTIC (owner directive: "make add-leads fast: no
// loading or syncing shown") — the pin lands at the tapped rooftop before any
// network await; reverse-geocode + POST reconcile in the background.
//
// Source-level assertions in the same spirit as map-instant-actions.test.ts:
// rendering MapView for real needs mapbox + ~8k lines of page, and "the cache
// insert precedes the awaits" is an ordering property the source states
// directly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const src = readFileSync(join(ROOT, "client/src/pages/MapView.tsx"), "utf8");

// The full __onTapAddress handler body — from its assignment to the effect's
// dependency array (coarse but stable for ordering assertions).
function tapAddBody(): string {
  const start = src.indexOf("__onTapAddress = (lat: number, lng: number) =>");
  expect(start, "__onTapAddress handler must exist").toBeGreaterThan(-1);
  const end = src.indexOf("}, [addMode,", start);
  expect(end, "handler effect must close over addMode").toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("one-tap add drops the pin BEFORE any network await", () => {
  const body = tapAddBody();

  it("is not an async handler — the tap itself never awaits anything", () => {
    expect(src).not.toContain("__onTapAddress = async");
  });

  it("inserts the temp pin into the map cache before the reverse-geocode and the POST", () => {
    const cacheInsert = body.indexOf('qc.setQueryData(["/api/leads/map"]');
    const geocodeAwait = body.indexOf("await reverseGeocode");
    const postAwait = body.indexOf('await apiRequest("POST", "/api/leads"');
    expect(cacheInsert).toBeGreaterThan(-1);
    expect(geocodeAwait).toBeGreaterThan(-1);
    expect(postAwait).toBeGreaterThan(-1);
    expect(cacheInsert, "cache insert must precede the geocode").toBeLessThan(geocodeAwait);
    expect(cacheInsert, "cache insert must precede the POST").toBeLessThan(postAwait);
  });

  it("uses a temp NEGATIVE id (monotonic ref) for the optimistic pin", () => {
    expect(src).toContain("const tempPinIdRef = useRef(-1)");
    expect(body).toContain("const tempId = tempPinIdRef.current--");
  });

  it("reconciles temp → real id in the query cache AND the GeoJSON feature map", () => {
    // Cache: the temp pin is replaced in place with the server row.
    expect(body).toContain("p.id === tempId");
    expect(body).toContain("id: added.id");
    // GeoJSON: same refs handleDeleteLead uses, re-keyed to the real id.
    expect(body).toContain("featureByIdRef.current.get(tempId)");
    expect(body).toContain("featureByIdRef.current.delete(tempId)");
    expect(body).toContain("featureByIdRef.current.set(added.id, tempFeature)");
    expect(body).toContain("scheduleClusterSetData()");
  });

  it("duplicate path (existed:true) removes the temp pin and selects the existing lead", () => {
    const dup = body.indexOf("added.existed === true");
    expect(dup).toBeGreaterThan(-1);
    const arm = body.slice(dup, body.indexOf("} else {", dup));
    expect(arm).toContain("removeTempPin()");
    expect(arm).toContain("setSelectedLeadId(added.id)");
    expect(arm).toContain("ringFlashRef.current"); // flash the real pin
    expect(arm).toContain("Already on the map");
  });

  it("failure removes the temp pin with ONE destructive toast naming the street", () => {
    // POST failure names the resolved street. (`} catch {` followed by a
    // newline is the last real catch ARM — the inline `catch {}` cursor guard
    // and best-effort one-liners don't match.)
    const postCatch = body.lastIndexOf("} catch {\n");
    expect(postCatch).toBeGreaterThan(body.indexOf('await apiRequest("POST"'));
    const after = body.slice(postCatch);
    expect(after).toContain("removeTempPin()");
    expect(after).toContain("didn't save");
    expect(after).toContain("${resolved.address}");
    expect(after).toContain('variant: "destructive"');
    // Geocode failure also rolls the pin back before its (single) toast.
    const geoCatchArm = body.slice(body.indexOf("await reverseGeocode"), body.indexOf('await apiRequest("POST"'));
    expect(geoCatchArm).toContain("removeTempPin()");
    expect(geoCatchArm).toContain("No address there");
  });

  it("the halo flash is confirmation on a timer — never cleared by the network path", () => {
    const flash = body.indexOf("SEARCH_RESULT_SOURCE");
    const timerClear = body.indexOf("window.setTimeout");
    const firstAwait = body.indexOf("await reverseGeocode");
    expect(flash).toBeGreaterThan(-1);
    expect(timerClear).toBeGreaterThan(flash);
    expect(timerClear).toBeLessThan(firstAwait);
  });
});

describe("the knock sheet can never open on a temp pin", () => {
  it("__openLeadSheet blocks non-positive ids (selection follows the reconcile)", () => {
    const open = src.slice(
      src.indexOf("(window as any).__openLeadSheet = (id: number) =>"),
      src.indexOf("delete (window as any).__openLeadSheet"),
    );
    expect(open).toContain("if (!(id > 0)) return;");
  });

  it("flyToLead (panel rows / search) ignores temp pins too", () => {
    const flyStart = src.indexOf("const flyToLead = useCallback");
    expect(flyStart).toBeGreaterThan(-1);
    const fly = src.slice(flyStart, src.indexOf("setSelectedLeadId(lead.id)", flyStart));
    expect(fly).toContain("if (!(lead.id > 0)) return;");
  });
});

describe("no loading / syncing chrome during background map work", () => {
  it('the "Finding that address" spinner phase is gone entirely', () => {
    expect(src).not.toContain("Finding that address");
    expect(src).not.toContain("tapResolving");
  });

  it("the armed tap-hint is static copy, never a resolving state", () => {
    const hint = src.slice(src.indexOf('data-testid="tap-hint"'), src.indexOf('data-testid="tap-hint-cancel"'));
    expect(hint).toContain("Tap a house to add a lead");
    expect(hint).not.toContain("Loader2");
    expect(hint).not.toContain("animate-spin");
  });

  it("no blocking overlay while the GL map spins up — the canvas is the loading state", () => {
    expect(src).not.toContain("Loading map…");
    expect(src).not.toContain("{!mapReady && !noToken && (");
    // The unrecoverable missing-token config error is the only full-cover state.
    expect(src).toContain("{noToken && (");
  });

  it("viewport window fetches are invisible: no React state flips, no toasts, no spinner", () => {
    const body = src.slice(
      src.indexOf("const fetchViewportPins = useCallback"),
      src.indexOf("const fetchViewportPinsRef"),
    );
    expect(body.length).toBeGreaterThan(100);
    // The only `set*` call is the cache write — never a setState/spinner/toast.
    expect(body).not.toMatch(/\bset(?!QueryData\b)[A-Z]\w*\(/);
    expect(body).not.toContain("toast(");
    expect(body).not.toContain("Loader");
  });

  it('the offline knock badge ("N to sync") STAYS, gated on a genuinely non-empty queue', () => {
    expect(src).toContain("{queueSnap.pendingCount} to sync");
    expect(src).toContain("{useSheet && queueSnap.pendingCount > 0 && (");
  });
});
