import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The Scan Inspector event store: durable per-address timeline, live counters that
// satisfy found = checked + queued + checking + retrying + unresolved, and SAFE
// diagnostics only (masked session + token last-4, never a full token).
let bus: typeof import("../../server/scanStageBus");
let events: typeof import("../../server/scanEvents");

const FULL_TOKEN = "eyJhbGciOiJIUzI1NiJ9.SUPERSECRETJWTPAYLOAD.sig123KvZo";

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-inspector-"));
  await import("../../server/db");
  bus = await import("../../server/scanStageBus");
  events = await import("../../server/scanEvents");
  events.startScanEvents(); // attach the persistence + relay subscriber
});

function emitLifecycle(key: string, addr: string, finalStage: "classified" | "retry" | "blocked", cls?: string) {
  const base = { addressKey: key, address: addr, city: "Inman", state: "SC", zip: "29349", runId: "run_test", source: "field", attempt: 1 } as const;
  const t = Date.now();
  bus.emitStage({ ...base, stage: "queued", status: "info", tsEpoch: t });
  bus.emitStage({ ...base, stage: "minting", status: "info", tsEpoch: t + 1 });
  bus.emitStage({ ...base, stage: "token_ready", status: "info", sessionId: "decodo-s3", tokenSuffix: FULL_TOKEN.slice(-4), tsEpoch: t + 2 });
  bus.emitStage({ ...base, stage: "searching", status: "info", sessionId: "decodo-s3", tokenSuffix: FULL_TOKEN.slice(-4), tsEpoch: t + 3 });
  if (finalStage === "classified") {
    bus.emitStage({ ...base, stage: "parsing", status: "info", httpStatus: 200, latencyMs: 480, tsEpoch: t + 4 });
    bus.emitStage({ ...base, stage: "classified", status: "ok", httpStatus: 200, latencyMs: 480, classification: cls ?? "fresh_fiber", tsEpoch: t + 5 });
  } else if (finalStage === "retry") {
    bus.emitStage({ ...base, stage: "retry", status: "pending_auth", httpStatus: 403, sessionId: "decodo-s3", tokenSuffix: FULL_TOKEN.slice(-4), retryReason: "auth 403 - token invalidated, Decodo session rotated", tsEpoch: t + 4 });
  } else {
    bus.emitStage({ ...base, stage: "blocked", status: "blocked", httpStatus: 429, retryReason: "rate-limited - requeued", tsEpoch: t + 4 });
  }
}

describe("Scan Inspector event store", () => {
  it("records a full timeline and derives balanced accounting counters", () => {
    emitLifecycle("k|fresh", "1 Fresh St", "classified", "fresh_fiber");
    emitLifecycle("k|retry", "2 Retry Rd", "retry");
    emitLifecycle("k|blocked", "3 Blocked Blvd", "blocked");

    const snap = events.getInspectorSnapshot({ runId: "run_test", limit: 50 });
    expect(snap.counters.found).toBe(3);
    expect(snap.counters.checked).toBe(1);   // classified
    expect(snap.counters.retrying).toBe(1);  // retry
    expect(snap.counters.unresolved).toBe(1); // blocked
    // INVARIANT: found = checked + queued + checking + retrying + unresolved
    const { checked, queued, checking, retrying, unresolved, found } = snap.counters;
    expect(checked + queued + checking + retrying + unresolved).toBe(found);
    expect(snap.counters.newNow).toBe(1); // fresh_fiber classification
  });

  it("scopes rows and counters to one city and state at the data boundary", () => {
    emitLifecycle("scope|concord", "10 Union St", "classified", "fresh_fiber");
    const t = Date.now();
    bus.emitStage({
      addressKey: "scope|ga", address: "20 Peach St", city: "Ball Ground", state: "GA", zip: "30107",
      runId: "run_test", source: "field", attempt: 1, stage: "error", status: "error", tsEpoch: t,
    });

    // The helper emits Inman rows, so add an explicit Concord lifecycle and
    // verify neither the Inman nor Georgia rows leak into the market snapshot.
    const base = { addressKey: "scope|concord-explicit", address: "30 Cabarrus Ave", city: "Concord", state: "NC", zip: "28025", runId: "run_concord", source: "market", attempt: 1 } as const;
    bus.emitStage({ ...base, stage: "queued", status: "info", tsEpoch: t + 1 });
    bus.emitStage({ ...base, stage: "classified", status: "ok", classification: "fresh_fiber", tsEpoch: t + 2 });

    const snap = events.getInspectorSnapshot({ city: " concord ", state: "nc", limit: 50 });
    expect(snap.rows.map((r) => r.addressKey)).toEqual(["scope|concord-explicit"]);
    expect(snap.counters).toMatchObject({ found: 1, checked: 1, newNow: 1, unresolved: 0 });
  });

  it("returns the per-address stage timeline in order", () => {
    const tl = events.getAddressTimeline("k|fresh", 20);
    expect(tl.map((e) => e.stage)).toEqual(["queued", "minting", "token_ready", "searching", "parsing", "classified"]);
  });

  it("NEVER persists a full token - only the masked last-4 suffix", () => {
    const tl = events.getAddressTimeline("k|fresh", 20);
    const serialized = JSON.stringify(tl);
    expect(serialized).not.toContain("SUPERSECRETJWTPAYLOAD");
    expect(serialized).not.toContain(FULL_TOKEN);
    const tokenReady = tl.find((e) => e.stage === "token_ready")!;
    expect(tokenReady.tokenSuffix).toBe("KvZo");         // last 4 only
    expect(tokenReady.sessionId).toBe("decodo-s3");      // masked session id
  });

  it("buffers events and persists them in ONE bulk transaction on flush (write-amplification control)", async () => {
    const { rawDb } = await import("../../server/db");
    const before = (rawDb.prepare("SELECT COUNT(*) c FROM scan_events WHERE address_key LIKE 'batch|%'").get() as any).c;
    // Emit a burst WITHOUT reading the snapshot (which would auto-flush). These sit
    // in the in-memory buffer, not yet written to the DB.
    const t = Date.now();
    for (let i = 0; i < 20; i++) {
      bus.emitStage({ addressKey: `batch|${i}`, address: `${i} Buffer Rd`, city: "Inman", state: "SC", zip: "29349", runId: "run_batch", source: "field", attempt: 1, stage: "queued", status: "info", tsEpoch: t + i });
    }
    const midDb = (rawDb.prepare("SELECT COUNT(*) c FROM scan_events WHERE address_key LIKE 'batch|%'").get() as any).c;
    expect(midDb).toBe(before); // still buffered — no per-event write transactions
    const flushed = events.flushScanEvents();
    expect(flushed).toBe(20);
    const afterDb = (rawDb.prepare("SELECT COUNT(*) c FROM scan_events WHERE address_key LIKE 'batch|%'").get() as any).c;
    expect(afterDb).toBe(before + 20); // all persisted in the single bulk transaction
  });
});
