// Equivalence guards for the perf rewrites (2026-07): several read models were
// rewritten from full-hydration / window-function passes into grouped
// aggregates + indexed latest-row seeks. The rewrites must be byte-identical
// in behavior — these tests pin the edges that could regress silently:
//   - getLeadsForMap: latest-knock tie-break (same knocked_at → higher id wins),
//     knock counts, and null visit fields for unknocked doors;
//   - getLeaderboard: a sale only counts while the sold knock is the lead's
//     latest APPLIED knock and the lead still IS sold;
//   - getVisitSummary: superseded knocks excluded from the count but included
//     in lastAt; latest APPLIED row owns the outcome;
//   - getLatestPingPerRep: newest ping per rep, tenant-walled;
//   - getLatestLocatedKnockByRep: effective-timestamp pick (deviceTs over
//     knockedAt), unlocated rows ignored.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let storage: any;
let rawDb: any;
const T1 = 1;
let T2: number;

let repA: any, repB: any, repOther: any;
let userA: any;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-eqv-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations();
  storage = mod.storage;
  rawDb = (await import("../../server/db")).rawDb;
  T2 = storage.createTenant({
    slug: "other-org", companyName: "Other Org", ownerName: "O", ownerEmail: "owner@other.test", brandName: "Other",
  }).id;
  repA = storage.createTeamMember({ name: "Ann", email: "ann@eq.test", role: "rep", active: true, tenantId: T1 });
  repB = storage.createTeamMember({ name: "Bob", email: "bob@eq.test", role: "rep", active: true, tenantId: T1 });
  repOther = storage.createTeamMember({ name: "Cara", email: "cara@eq.test", role: "rep", active: true, tenantId: T2 });
  userA = storage.createUser({ name: "Ann", email: "ann@eq.test", role: "rep", active: true, tenantId: T1, teamMemberId: repA.id });
});

let seq = 0;
function lead(over: any = {}) {
  return storage.createLead({
    address: `${++seq} Equivalence St`, city: "Rockwell", state: "NC", zip: "28138",
    lat: 35.5 + seq * 0.0001, lng: -80.4, fiberStatus: "fiber", leadStatus: "prospect",
    tenantId: T1, ...over,
  });
}
function insertKnock(k: {
  leadId: number; repId: number; outcome: string; knockedAt: string;
  superseded?: number; wasHome?: number; deviceTs?: string | null;
  repLat?: number | null; repLng?: number | null; tenantId?: number;
}) {
  return Number(rawDb.prepare(
    `INSERT INTO knock_log (lead_id, rep_id, outcome, was_home, knocked_at, tenant_id, pass_number, superseded, device_ts, rep_lat, rep_lng)
     VALUES (?,?,?,?,?,?,1,?,?,?,?)`
  ).run(
    k.leadId, k.repId, k.outcome, k.wasHome ?? 1, k.knockedAt, k.tenantId ?? T1,
    k.superseded ?? 0, k.deviceTs ?? null, k.repLat ?? null, k.repLng ?? null,
  ).lastInsertRowid);
}

describe("getLeadsForMap visit aggregate", () => {
  it("breaks exact-timestamp ties by id (later knock wins) and counts every knock", () => {
    const l = lead();
    const ts = "2026-07-01T12:00:00.000Z";
    insertKnock({ leadId: l.id, repId: repA.id, outcome: "not_home", knockedAt: ts });
    insertKnock({ leadId: l.id, repId: repA.id, outcome: "callback", knockedAt: ts }); // same ts, higher id
    const pin = storage.getLeadsForMap(T1).find((p: any) => p.id === l.id);
    expect(pin).toBeTruthy();
    expect(pin.knockCount).toBe(2);
    expect(pin.lastOutcome).toBe("callback");
    expect(pin.lastKnockedAt).toBe(ts);
  });

  it("newer timestamp beats higher id, and unknocked doors carry null visit fields", () => {
    const knocked = lead();
    insertKnock({ leadId: knocked.id, repId: repA.id, outcome: "interested", knockedAt: "2026-07-02T09:00:00.000Z" });
    insertKnock({ leadId: knocked.id, repId: repA.id, outcome: "not_home", knockedAt: "2026-07-01T09:00:00.000Z" });
    const fresh = lead();
    const pins = storage.getLeadsForMap(T1);
    const kp = pins.find((p: any) => p.id === knocked.id);
    expect(kp.lastOutcome).toBe("interested");
    expect(kp.knockCount).toBe(2);
    const fp = pins.find((p: any) => p.id === fresh.id);
    expect(fp.knockCount).toBeNull();
    expect(fp.lastOutcome).toBeNull();
    expect(fp.lastKnockedAt).toBeNull();
  });
});

describe("getLeaderboard sold gating", () => {
  it("counts a sale only while the sold knock is the latest applied knock AND the lead is still sold", () => {
    const l = lead();
    insertKnock({ leadId: l.id, repId: repB.id, outcome: "sold", knockedAt: "2026-07-03T10:00:00.000Z" });
    storage.updateLead(l.id, { leadStatus: "sold" });
    let row = storage.getLeaderboard(undefined, T1).find((r: any) => r.rep.id === repB.id);
    expect(row.sales).toBe(1);

    // A corrective NEWER knock demotes the sold knock even though its row remains.
    insertKnock({ leadId: l.id, repId: repB.id, outcome: "not_interested", knockedAt: "2026-07-03T11:00:00.000Z" });
    storage.updateLead(l.id, { leadStatus: "not_interested" });
    row = storage.getLeaderboard(undefined, T1).find((r: any) => r.rep.id === repB.id);
    expect(row.sales).toBe(0);
    // Effort history still counts both applied knocks.
    expect(row.knocks).toBe(2);
  });

  it("ignores superseded knocks entirely", () => {
    const l = lead();
    insertKnock({ leadId: l.id, repId: repB.id, outcome: "sold", knockedAt: "2026-07-04T10:00:00.000Z", superseded: 1 });
    const row = storage.getLeaderboard(undefined, T1).find((r: any) => r.rep.id === repB.id);
    // The superseded row adds nothing to knocks or sales.
    expect(row.knocks).toBe(2);
    expect(row.sales).toBe(0);
  });
});

describe("getVisitSummary", () => {
  it("excludes superseded rows from the count but keeps them in lastAt; applied row owns the outcome", () => {
    const l = lead();
    insertKnock({ leadId: l.id, repId: repA.id, outcome: "callback", knockedAt: "2026-07-05T10:00:00.000Z" });
    // Newer but SUPERSEDED: must not own the outcome, must not count, but its
    // timestamp is still the raw MAX(knocked_at) exactly as the old window computed.
    insertKnock({ leadId: l.id, repId: repA.id, outcome: "sold", knockedAt: "2026-07-05T12:00:00.000Z", superseded: 1 });
    const m = storage.getVisitSummary(T1);
    const v = m.get(l.id);
    expect(v).toBeTruthy();
    expect(v.count).toBe(1);
    expect(v.lastOutcome).toBe("callback");
    expect(v.lastAt).toBe("2026-07-05T12:00:00.000Z");
  });
});

describe("getLatestPingPerRep", () => {
  it("returns exactly the newest ping per rep, tenant-walled, within the live window", () => {
    const mk = (repId: number, at: string, lat: number) =>
      rawDb.prepare("INSERT INTO location_pings (rep_id, user_id, lat, lng, accuracy, ping_at) VALUES (?,?,?,?,?,?)")
        .run(repId, userA.id, lat, -80.4, 5, at);
    // The query now carries a shift-length (8h) recency window, so fixtures use
    // now-relative instants: a rep who last pinged weeks ago must NOT render as
    // a live green marker on the map.
    const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    mk(repA.id, minsAgo(120), 35.1);
    mk(repA.id, minsAgo(60), 35.2); // newest for A
    mk(repB.id, minsAgo(180), 35.3);
    mk(repOther.id, minsAgo(30), 35.4); // other tenant
    const rows = storage.getLatestPingPerRep(T1);
    expect(rows.map((r: any) => r.repId).sort()).toEqual([repA.id, repB.id].sort());
    expect(rows.find((r: any) => r.repId === repA.id).lat).toBe(35.2);
    // Unscoped call still sees every tenant's reps (super_admin view).
    const all = storage.getLatestPingPerRep();
    expect(all.some((r: any) => r.repId === repOther.id)).toBe(true);
  });

  it("drops reps whose newest ping is older than the live window", () => {
    rawDb.prepare("DELETE FROM location_pings").run(); // isolate from the test above
    const mk = (repId: number, at: string, lat: number) =>
      rawDb.prepare("INSERT INTO location_pings (rep_id, user_id, lat, lng, accuracy, ping_at) VALUES (?,?,?,?,?,?)")
        .run(repId, userA.id, lat, -80.4, 5, at);
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    mk(repA.id, hoursAgo(1), 36.0);   // live
    mk(repB.id, hoursAgo(200), 36.1); // stale — the "4380h ago green dot" bug
    const rows = storage.getLatestPingPerRep(T1);
    expect(rows.some((r: any) => r.repId === repA.id)).toBe(true);
    expect(rows.some((r: any) => r.repId === repB.id)).toBe(false);
  });
});

describe("getLatestLocatedKnockByRep", () => {
  it("picks by effective timestamp (deviceTs ?? knockedAt) and skips unlocated rows", () => {
    const l = lead();
    // Unlocated (no rep GPS) — must never be picked even though it is newest.
    insertKnock({ leadId: l.id, repId: repA.id, outcome: "not_home", knockedAt: "2026-07-08T12:00:00.000Z" });
    // Located, older knockedAt but NEWER deviceTs — the effective timestamp wins.
    insertKnock({ leadId: l.id, repId: repA.id, outcome: "not_home", knockedAt: "2026-07-07T10:00:00.000Z", deviceTs: "2026-07-08T11:00:00.000Z", repLat: 35.9, repLng: -80.9 });
    insertKnock({ leadId: l.id, repId: repA.id, outcome: "not_home", knockedAt: "2026-07-08T10:00:00.000Z", repLat: 35.8, repLng: -80.8 });
    const prior = storage.getLatestLocatedKnockByRep(repA.id);
    expect(prior).toBeTruthy();
    expect(prior.repLat).toBe(35.9);
    expect(prior.deviceTs).toBe("2026-07-08T11:00:00.000Z");
    expect(storage.getLatestLocatedKnockByRep(repB.id + repOther.id + 999)).toBeUndefined();
  });
});
