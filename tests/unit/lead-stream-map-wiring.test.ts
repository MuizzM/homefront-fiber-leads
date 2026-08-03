// ── MapView wiring for live lead pushes — source-level assertions ────────────
// The merge rule itself is unit-tested in lead-stream-merge.test.ts and the
// gate in lead-stream.test.ts; what remains is that MapView actually WIRES
// them: a received push must repaint through the same imperative single-pin
// path a local knock uses (featureByIdRef mutation + coalesced
// scheduleClusterSetData), never by waiting for the next /api/leads/map
// refetch — and the paths that CANNOT patch (lost cursor, degraded stream,
// backgrounded phone) must refetch instead. Source assertions in the same
// spirit as map-instant-actions.test.ts: rendering MapView for real needs
// mapbox + ~8k lines of page, and "this handler calls that path" is a property
// the source states directly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mergePendingOutcomes } from "../../client/src/lib/pendingKnockOverlay";

const ROOT = join(__dirname, "..", "..");
const src = readFileSync(join(ROOT, "client/src/pages/MapView.tsx"), "utf8");
const knockLoggerSrc = readFileSync(join(ROOT, "client/src/lib/useKnockLogger.ts"), "utf8");

// The body of a `const NAME = useCallback(` block, bounded by the next
// top-level `const ` declaration — coarse but stable for ordering assertions.
function callbackBody(name: string): string {
  const start = src.indexOf(`const ${name} = useCallback(`);
  expect(start, `${name} must exist`).toBeGreaterThan(-1);
  const end = src.indexOf("\n  const ", start + 10);
  return src.slice(start, end > start ? end : start + 6000);
}

describe("a pushed event paints immediately — no refetch on the hot path", () => {
  const body = callbackBody("applyLeadEvent");

  it("merges through the shared, unit-tested merge (no local fork of the rule)", () => {
    expect(body).toContain("mergePushedPin(prev, pushed)");
    expect(body).toContain("pinFromPushedLead(pushed)");
    // The merge lives in the lib so tests and MapView share ONE rule.
    expect(src).toContain('import { mergePushedPin, pinFromPushedLead } from "@/lib/leadStreamMerge"');
    // No second definition creeping back into the page.
    expect(src.includes("function mergePushedPin")).toBe(false);
  });

  it("recolors the one feature imperatively and coalesces the re-cluster — the local-knock path", () => {
    expect(body).toContain("featureByIdRef.current.get(pushed.id)");
    expect(body).toContain("pinDisplayState(merged)");
    expect(body).toContain("pendingKnockPaintRef.current = pushed.id");
    expect(body).toContain("scheduleClusterSetData()");
  });

  it("updates the shared map cache in the same tick", () => {
    expect(body).toContain('qc.setQueryData(["/api/leads/map"]');
  });

  it("never waits on the network to apply a push", () => {
    expect(body.includes("await ")).toBe(false);
    expect(body.includes("invalidateQueries")).toBe(false);
    expect(body.includes("refetch")).toBe(false);
  });
});

describe("the stream subscription and its recovery edges", () => {
  const start = src.indexOf("subscribeLeadStream({");
  const block = src.slice(start, src.indexOf("setLeadStream(handle)", start));

  it("events flow into applyLeadEvent", () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain("onEvent: (evt) => applyLeadEventRef.current(evt)");
  });

  it("a lost cursor (resync) refetches the whole scope — a hole nothing can detect otherwise", () => {
    const resyncAt = block.indexOf("onResync:");
    expect(resyncAt).toBeGreaterThan(-1);
    expect(block.slice(resyncAt, resyncAt + 400)).toContain('invalidateQueries({ queryKey: ["/api/leads/map"] })');
  });

  it("a degraded stream (fallback) refetches so the map is never a minute stale on the way down", () => {
    const fallbackAt = block.indexOf("onFallback:");
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(block.slice(fallbackAt)).toContain('invalidateQueries({ queryKey: ["/api/leads/map"] })');
  });

  it("uses the header-auth fetch transport (native EventSource would 401 forever here)", () => {
    expect(block).toContain("createFetchEventSource(");
    expect(block).toContain("x-session-id");
  });
});

describe("do-not-repaint-while-saving hold discipline", () => {
  // The effect that mirrors the knock queue's byLead states into stream holds.
  const start = src.indexOf("const held = streamHoldsRef.current");
  const block = src.slice(start, start + 900);

  it("holds every unsettled (saving/queued) lead and releases on settle", () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain('byLead[id] === "saving" || byLead[id] === "queued"');
    expect(block).toContain("leadStream.hold(leadId)");
    expect(block).toContain("release()");
  });

  it("clears holds when the stream handle dies, so stale release closures cannot leak", () => {
    expect(src).toContain("streamHoldsRef.current.clear()");
  });
});

describe("background/foreground convergence", () => {
  it("a rep returning to the tab pulls the ETag-backed map query", () => {
    const at = src.indexOf('document.visibilityState === "visible"');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 300)).toContain('invalidateQueries({ queryKey: ["/api/leads/map"] })');
  });
});

describe("optimistic writes stamp the CAS clock", () => {
  it("a rep's own tap sets lastOutcomeAt so an older push cannot repaint their door", () => {
    // useKnockLogger is the one shared field-logging path; its optimistic cache
    // write must carry the same clock the server CAS will record.
    //
    // Asserted through the shared merge rather than by grepping the hook for a
    // literal, because the stamping now lives in mergePendingOutcomes — the same
    // function the post-refetch overlay uses, which is precisely what stops a
    // poll from reverting the pin. A source-text assertion would have gone green
    // on a hook that stamped the clock and then had it overwritten anyway.
    expect(knockLoggerSrc).toContain("mergePendingOutcomes");
    const at = "2026-08-03T12:00:00.000Z";
    const merged = mergePendingOutcomes(
      { pins: [{ id: 7, leadStatus: "new", visited: false, lastOutcome: null, lastOutcomeAt: null }] },
      { 7: { outcome: "not_home", at } },
    )!;
    expect(merged.pins[0].lastOutcomeAt).toBe(at);

    // …and the clock is what makes an OLDER teammate push lose, exactly as it
    // loses the server's outcome CAS.
    const older = mergePendingOutcomes(
      { pins: [{ id: 7, leadStatus: "sold", visited: true, lastOutcome: "sold", lastOutcomeAt: "2026-08-03T13:00:00.000Z" }] },
      { 7: { outcome: "not_home", at } },
    )!;
    expect(older.pins[0].lastOutcome).toBe("sold");
  });

  it("a central mark's optimistic write carries the clock too", () => {
    const body = callbackBody("handleCentralMark");
    expect(body).toContain("lastOutcomeAt: optimisticAt");
  });
});
