import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// When the address normalization expands (a new suffix synonym), existing leads
// were keyed under the OLD rules. The version-gated re-key migration must
// recompute every key and MERGE the newly-equivalent rows into one pin — exactly
// once (idempotent via schema_meta.address_norm_version).

let rawDb: import("better-sqlite3").Database;
let storage: typeof import("../../server/storage");
let NORM_VERSION: number;
const TENANT = 1;

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-rekey-"));
  ({ rawDb } = await import("../../server/db"));
  storage = await import("../../server/storage");
  ({ NORMALIZATION_VERSION: NORM_VERSION } = await import("../../server/addressKey"));
  storage.runMigrations(); // fresh schema; sets address_norm_version = current
});

describe("normalization-version re-key + merge", () => {
  it("re-keys stale keys so 'Oak Circle' and 'Oak Cir' collapse to one lead, idempotently", async () => {
    // Simulate two pre-expansion leads: the SAME house, but keyed under the OLD
    // normalization where CIRCLE and CIR did not fold — so they carry DIFFERENT
    // keys and both survived the original UNIQUE index.
    const insert = (address: string, key: string, extra: Record<string, unknown> = {}) => {
      const f: Record<string, unknown> = {
        address, city: "Terrace", state: "NC", zip: "28110", tenant_id: TENANT,
        lead_status: "prospect", canonical_key: key,
        created_at: "2026-07-10T00:00:00.000Z", updated_at: "2026-07-10T00:00:00.000Z", ...extra,
      };
      const cols = Object.keys(f);
      return Number(rawDb.prepare(`INSERT INTO leads (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
        .run(...Object.values(f)).lastInsertRowid);
    };
    const a = insert("123 Oak Circle", "123 OAK CIRCLE|TERRACE|NC|28110", { lead_tag: "fresh_fiber_confirmed", source_scan_target_id: 77 });
    const b = insert("123 Oak Cir", "123 OAK CIR|TERRACE|NC|28110", { lead_status: "sold" }); // more advanced status
    // A genuinely different neighbour that must NOT be merged.
    const other = insert("125 Oak Cir", "125 OAK CIR|TERRACE|NC|28110");

    expect(rawDb.prepare("SELECT COUNT(*) c FROM leads WHERE lower(city)='terrace'").get() as any).toMatchObject({ c: 3 });

    // Force the stored version backwards to simulate an alias expansion, then re-run.
    rawDb.prepare(`INSERT INTO schema_meta (key,value) VALUES ('address_norm_version','1')
                   ON CONFLICT(key) DO UPDATE SET value='1'`).run();
    storage.runMigrations();

    // The two 'Oak Circle/Cir' rows collapse to ONE; the neighbour survives.
    const rows = rawDb.prepare("SELECT id, canonical_key, lead_status, lead_tag FROM leads WHERE lower(city)='terrace' ORDER BY id").all() as any[];
    expect(rows.length).toBe(2);
    const survivor = rows.find((r) => r.id === a || r.id === b);
    expect(survivor).toBeTruthy();
    // Survivor keeps the fresh tag AND is promoted to the more-advanced 'sold' status.
    expect(survivor.lead_tag).toBe("fresh_fiber_confirmed");
    expect(survivor.lead_status).toBe("sold");
    // Both merged rows now share the recomputed key; the neighbour differs.
    expect(rows.every((r) => r.canonical_key.startsWith("123 OAK CIR|") || r.canonical_key.startsWith("125 OAK CIR|"))).toBe(true);
    expect(rawDb.prepare("SELECT value FROM schema_meta WHERE key='address_norm_version'").get() as any).toMatchObject({ value: String(NORM_VERSION) });

    // Idempotent: running again changes nothing.
    const countAfter = () => (rawDb.prepare("SELECT COUNT(*) c FROM leads WHERE lower(city)='terrace'").get() as any).c;
    const before = countAfter();
    storage.runMigrations();
    expect(countAfter()).toBe(before);
    void other;
  });
});
