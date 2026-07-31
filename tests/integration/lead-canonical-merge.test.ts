import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Duplicate-pin root fix: canonical_key backfill + merge of existing dupes +
// UNIQUE index that makes a new duplicate structurally impossible. Uses the REAL
// runMigrations path (which calls migrateLeadsCanonicalKey).

let rawDb: import("better-sqlite3").Database;
let storage: typeof import("../../server/storage").storage;
const TENANT = 1;

const insertRawLead = (fields: Record<string, unknown>) => {
  const cols = Object.keys(fields);
  return Number(rawDb.prepare(
    `INSERT INTO leads (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
  ).run(...Object.values(fields)).lastInsertRowid);
};

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-canon-merge-"));
  ({ rawDb } = await import("../../server/db"));
  const s = await import("../../server/storage");
  s.runMigrations(); // establishes schema incl. leads.canonical_key + the migration fn
  storage = s.storage;
  // Ensure default tenant exists for getDefaultTenantId-backed inserts.
});

describe("lead canonical merge migration", () => {
  it("merges suffix/case duplicate leads, repoints child rows, keeps the richest survivor, adds the UNIQUE index", async () => {
    const now = new Date().toISOString();
    // Two rows for the SAME house: an untagged bulk-scan copy (older, has a knock)
    // and a projector copy (newer, source_scan_target_id set, richer). "Road" vs "RD".
    const bulk = insertRawLead({
      address: "742 Evergreen Road", city: "Terrace", state: "NC", zip: "28110",
      lead_status: "prospect", tenant_id: TENANT, created_at: "2026-07-08T00:00:00.000Z", updated_at: now,
      canonical_key: null, // pre-migration rows have no key — backfill must fill it
    });
    const proj = insertRawLead({
      address: "742 EVERGREEN RD", city: "Terrace", state: "NC", zip: "28110",
      lead_status: "prospect", tenant_id: TENANT, source_scan_target_id: 555,
      contact_phone: "704-555-0100", lead_tag: "fresh_fiber_confirmed",
      created_at: "2026-07-14T00:00:00.000Z", updated_at: now, canonical_key: null,
    });
    // A child record on the LOSER must survive by repointing to the survivor.
    rawDb.prepare(`INSERT INTO knock_log (lead_id, rep_id, was_home, outcome) VALUES (?, 18, 0, 'not_home')`).run(bulk);
    // A distinct address that must NOT be merged.
    const other = insertRawLead({ address: "9 Solo St", city: "Terrace", state: "NC", zip: "28110", lead_status: "prospect", tenant_id: TENANT, created_at: now, updated_at: now, canonical_key: null });

    const before = (rawDb.prepare(`SELECT COUNT(*) c FROM leads WHERE lower(city)='terrace'`).get() as any).c;
    expect(before).toBe(3);

    // Re-run migrations → triggers migrateLeadsCanonicalKey (idempotent).
    const s = await import("../../server/storage");
    s.runMigrations();

    // Exactly ONE lead remains for the merged address; the distinct one is untouched.
    const evergreen = rawDb.prepare(`SELECT * FROM leads WHERE canonical_key = (SELECT canonical_key FROM leads WHERE id=?)`).all(other === bulk ? proj : bulk) as any[];
    const merged = rawDb.prepare(`SELECT * FROM leads WHERE address LIKE '742 EVERGREEN%' OR address LIKE '742 Evergreen%'`).all() as any[];
    expect(merged).toHaveLength(1);
    const survivor = merged[0];
    // Survivor is the projector row (has source_scan_target_id) and inherits nothing missing.
    expect(survivor.source_scan_target_id).toBe(555);
    expect(survivor.contact_phone).toBe("704-555-0100");
    expect(survivor.lead_tag).toBe("fresh_fiber_confirmed");
    // The knock_log child was repointed from the deleted bulk row to the survivor.
    const knock = rawDb.prepare(`SELECT lead_id FROM knock_log WHERE outcome='not_home'`).get() as any;
    expect(knock.lead_id).toBe(survivor.id);
    // The distinct address is still there.
    expect((rawDb.prepare(`SELECT COUNT(*) c FROM leads WHERE address='9 Solo St'`).get() as any).c).toBe(1);
    // The UNIQUE index exists.
    expect(rawDb.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_leads_canonical'`).get()).toBeTruthy();
    // canonical_key was backfilled on all rows.
    expect((rawDb.prepare(`SELECT COUNT(*) c FROM leads WHERE canonical_key IS NULL`).get() as any).c).toBe(0);
  });

  it("survivor keeps already_customer over a richer prospect duplicate", async () => {
    const now = new Date().toISOString();
    const markedAt = "2026-07-20T15:30:00.000Z";
    // The worked copy: centrally marked "Already a Customer" (stored as
    // not_interested + last_outcome=already_customer — a terminal, worked door).
    const worked = insertRawLead({
      address: "31 Custer Avenue", city: "Terrace", state: "NC", zip: "28110",
      lead_status: "not_interested", last_outcome: "already_customer", last_outcome_at: markedAt,
      tenant_id: TENANT, created_at: "2026-07-01T00:00:00.000Z", updated_at: now, canonical_key: null,
    });
    // A RICHER prospect duplicate — under the old ranking (no not_interested /
    // already_customer entries → rank 0) this row won and the door re-opened.
    insertRawLead({
      address: "31 CUSTER AVE", city: "Terrace", state: "NC", zip: "28110",
      lead_status: "prospect", contact_name: "Riche Prospect", contact_phone: "704-555-0199",
      notes: "bulk scan copy", tenant_id: TENANT,
      created_at: "2026-07-10T00:00:00.000Z", updated_at: now, canonical_key: null,
    });

    const s = await import("../../server/storage");
    s.runMigrations();

    const merged = rawDb.prepare(`SELECT * FROM leads WHERE address LIKE '31 %'`).all() as any[];
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(worked);
    expect(merged[0].lead_status).toBe("not_interested");
    expect(merged[0].last_outcome).toBe("already_customer");
    expect(merged[0].last_outcome_at).toBe(markedAt);
    // Loser's useful contact data still coalesced onto the survivor.
    expect(merged[0].contact_name).toBe("Riche Prospect");
  });

  it("a projector survivor inherits lead_status AND last_outcome from an already_customer loser", async () => {
    const now = new Date().toISOString();
    const markedAt = "2026-07-21T09:00:00.000Z";
    // Projector row (source_scan_target_id) always survives — but it is a bare prospect.
    const proj = insertRawLead({
      address: "77 Keeper Road", city: "Terrace", state: "NC", zip: "28110",
      lead_status: "prospect", source_scan_target_id: 777, tenant_id: TENANT,
      created_at: "2026-07-05T00:00:00.000Z", updated_at: now, canonical_key: null,
    });
    // The worked duplicate: already a customer. Its disposition must transfer —
    // lead_status alone is ambiguous (not_interested vs already_customer is
    // disambiguated by last_outcome on every surface).
    insertRawLead({
      address: "77 KEEPER RD", city: "Terrace", state: "NC", zip: "28110",
      lead_status: "not_interested", last_outcome: "already_customer", last_outcome_at: markedAt,
      tenant_id: TENANT, created_at: "2026-07-12T00:00:00.000Z", updated_at: now, canonical_key: null,
    });

    const s = await import("../../server/storage");
    s.runMigrations();

    const merged = rawDb.prepare(`SELECT * FROM leads WHERE address LIKE '77 %'`).all() as any[];
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(proj);                       // projector row still the survivor
    expect(merged[0].lead_status).toBe("not_interested");  // promoted from the worked loser
    expect(merged[0].last_outcome).toBe("already_customer");
    expect(merged[0].last_outcome_at).toBe(markedAt);
  });

  it("createLead attaches to an existing canonical match instead of duplicating", () => {
    const a = storage.createLead({ address: "12 Once Ln", city: "Terrace", state: "NC", zip: "28110", tenantId: TENANT } as any);
    // Suffix/case variant → same canonical key → returns the SAME lead, no new row.
    const b = storage.createLead({ address: "12 ONCE LANE", city: "Terrace", state: "NC", zip: "28110", tenantId: TENANT } as any);
    expect(b.id).toBe(a.id);
    expect((rawDb.prepare(`SELECT COUNT(*) c FROM leads WHERE lower(replace(replace(address,'lane','ln'),'LANE','LN')) LIKE '12 once%'`).get() as any).c).toBe(1);
  });

  it("upsertLeadByAddress attaches on canonical match (never a second pin)", () => {
    const first = storage.upsertLeadByAddress({ address: "50 Twice Dr", city: "Terrace", state: "NC", zip: "28110", tenantId: TENANT } as any);
    expect(first.created).toBe(true);
    const second = storage.upsertLeadByAddress({ address: "50 Twice Drive", city: "Terrace", state: "NC", zip: "28110", tenantId: TENANT } as any);
    expect(second.created).toBe(false);
    expect(second.lead.id).toBe(first.lead.id);
  });
});
