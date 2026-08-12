// Marking a door is answered by the door, not by a toast.
//
// Owner rule (2026-08-12): "no need for notifications when we mark leads as
// long as it changes the shape on leads, and it should be instant."
//
// So the contract has two halves, and the FIRST one is conditional on the
// second: a marking path may stay silent only because the pin itself moves,
// and it must move on the tap rather than after a round trip. Anything the
// map cannot show still speaks - a refused door, a reverted door, a triage
// mark that draws nothing, money.
//
// These are source-level assertions for the same reason map-chrome-minimal
// is: MapView is ~9,000 lines behind mapbox + geolocation, and what these pin
// down is which code path exists, not what a rendered pixel looks like.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const mapView = readFileSync(join(ROOT, "client/src/pages/MapView.tsx"), "utf8");
const reconcile = readFileSync(
  join(ROOT, "client/src/features/knocking/savedKnockReconciliation.ts"),
  "utf8",
);
const knockLogger = readFileSync(join(ROOT, "client/src/lib/useKnockLogger.ts"), "utf8");

/** The body of a named `const x = useMutation({ … })` block. */
function mutationBody(src: string, name: string): string {
  const start = src.indexOf(`const ${name} = useMutation({`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = src.indexOf("\n  });", start);
  return src.slice(start, end);
}

describe("a single door: silent, and painted before the network", () => {
  it("the rep knock never toasts an ordinary save", () => {
    // The reconciler speaks for `superseded` and for a SPIFF only.
    const ordinary = reconcile.slice(reconcile.indexOf("if (superseded)"));
    expect(ordinary).toContain("Deliberately silent on the ordinary save");
    const notifies = (reconcile.match(/effects\.notify\(/g) ?? []).length;
    expect(notifies, "only superseded + SPIFF may notify").toBe(2);
  });

  it("the rep knock recolours before it enqueues", () => {
    const optimistic = knockLogger.indexOf('qc.setQueryData(["/api/leads/map"]');
    const enqueue = knockLogger.indexOf("queue.stage({");
    expect(optimistic).toBeGreaterThan(-1);
    expect(optimistic, "the pin must move before the queue call").toBeLessThan(enqueue);
  });

  it("a manager's central mark is silent on success but speaks on revert", () => {
    const fn = mapView.slice(
      mapView.indexOf("const handleCentralMark = useCallback("),
      mapView.indexOf("// DELETE LEAD"),
    );
    expect(fn.length).toBeGreaterThan(500);
    expect(fn, "no success toast on an ordinary central mark").not.toContain('title: "Marked centrally"');
    // A pin snapping BACK is the case the map cannot explain.
    expect(fn).toContain('title: "Central mark failed - reverted"');
    // …and it still paints before awaiting the server.
    const paint = fn.indexOf("feature.properties.ds = optimisticDs");
    const network = fn.indexOf("await apiRequest");
    expect(paint).toBeGreaterThan(-1);
    expect(paint).toBeLessThan(network);
  });
});

describe("a lassoed selection: same rule, same instant", () => {
  const bulkStatus = mutationBody(mapView, "bulkStatusMutation");

  it("repaints the whole selection on the tap, not after the response", () => {
    expect(bulkStatus).toContain("onMutate:");
    const onMutate = bulkStatus.indexOf("onMutate:");
    const onSuccess = bulkStatus.indexOf("onSuccess:");
    expect(onMutate).toBeLessThan(onSuccess);
    // Both layers move: the features the map draws from AND the shared cache.
    expect(bulkStatus).toContain("featureByIdRef.current.get(id)");
    expect(bulkStatus).toContain('qc.setQueryData(["/api/leads/map"]');
    expect(bulkStatus).toContain("scheduleClusterSetData()");
  });

  it("costs one pass over the pins, never one array copy per lead", () => {
    // The O(n^2) shape: slicing the pin array inside a per-lead loop. On a
    // 5,000-door selection that is 25M copies on the main thread - a freeze
    // dressed up as an optimistic update.
    const onMutateBlock = bulkStatus.slice(bulkStatus.indexOf("onMutate:"), bulkStatus.indexOf("onSuccess:"));
    expect(onMutateBlock).toContain("new Set(leadIds)");
    expect(onMutateBlock).toContain("old.pins.map(");
    expect(onMutateBlock, "no per-lead array slice").not.toContain("old.pins.slice()");
  });

  it("says nothing when every door took, and names the skips when they did not", () => {
    expect(bulkStatus).toContain("if (data.skipped) {");
    const success = bulkStatus.slice(bulkStatus.indexOf("onSuccess:"), bulkStatus.indexOf("onError:"));
    // The only toast in the success path is inside the skipped branch.
    const toasts = (success.match(/toast\(\{/g) ?? []).length;
    expect(toasts, "exactly one toast, the skipped one").toBe(1);
    expect(success.indexOf("if (data.skipped)")).toBeLessThan(success.indexOf("toast({"));
  });

  it("rolls both layers back when the write fails", () => {
    const err = bulkStatus.slice(bulkStatus.indexOf("onError:"));
    expect(err).toContain("ctx?.prevProps");
    expect(err).toContain("ctx?.prevPins");
    expect(err).toContain("variant: \"destructive\"");
  });
});

describe("what the map cannot draw still speaks", () => {
  it("a triage mark keeps its toast, because no pin renders it", () => {
    // bulk-mark sets a priority/hold flag. Nothing in the pin pipeline reads
    // it, so silence here would leave the action with no feedback at all.
    const pins = readFileSync(join(ROOT, "client/src/lib/leadGeoJson.ts"), "utf8");
    expect(pins.toLowerCase()).not.toContain("leadmark");
    const bulkMark = mutationBody(mapView, "bulkMarkMutation");
    expect(bulkMark).toContain("toast({");
    expect(bulkMark).toMatch(/marked \$\{label\}|cleared/);
  });
});
