// Spreadsheet lead import: preview matches columns and says what would
// happen; import creates the ready rows, geocodes them from the county file,
// assigns by the rep named on each row, skips doors already on the map, and
// never takes a phone number.
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: Server; let baseUrl: string;
let storage: (typeof import("../../server/storage"))["storage"];
let rawDb: import("better-sqlite3").Database;
type Person = { userId: number; memberId: number; session: string };
const fx: Record<string, Person> = {};
const realFetch = globalThis.fetch;

function person(name: string, role: string, tenantId = 1): Person {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@import.example.test`;
  const member = storage.createTeamMember({ name, email, role, active: true, tenantId } as any);
  const user = storage.createUser({ name, email, role, active: true, tenantId, teamMemberId: member.id } as any);
  return { userId: user.id, memberId: member.id, session: storage.createSession(user.id).id };
}

// jsdom's FormData and Node's fetch disagree on Content-Length, so the
// multipart body is assembled by hand (the vendor-order import tests do the same).
let counter = 0;
function uploadCsv(path: string, session: string, csv: string, fields: Record<string, string> = {}, fileName = "leads.csv") {
  const boundary = `----hfboundary${counter += 1}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, "utf8"));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: text/csv\r\n\r\n`, "utf8"));
  parts.push(Buffer.from(csv, "utf8"));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  const body = Buffer.concat(parts);
  return realFetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "x-session-id": session, "x-csrf-token": session, "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": String(body.length) },
    body,
  });
}

const CSV = [
  "Address,City,ST,Zip,Homeowner,Assigned rep,Phone,Notes",
  "1842 Oak Ridge Dr,Salisbury,NC,28146,Marcus Hill,Jordan Price,(704) 555-0148,Asked about 1 Gig",
  "1846 Oak Ridge Dr,Salisbury,NC,,Priya Shah,Nobody Known,,",
  "1842 Oak Ridge Drive,Salisbury,nc,28146,,,,",
  "1838 Oak Ridge Dr,Salisbury,NC,28146,Renee Park,Jordan Price,,",
  ",Salisbury,NC,28146,,,,",
].join("\n");

beforeAll(async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "hf-leadimport-"));
  process.env.NODE_ENV = "test";
  const mod = await import("../../server/storage");
  mod.runMigrations(); storage = mod.storage;
  ({ rawDb } = await import("../../server/db"));
  const { upsertAddressPoints } = await import("../../server/addressPointStore");
  upsertAddressPoints([
    { source: "test", sourceId: "a", houseNumber: "1842", street: "1842 Oak Ridge Dr", fullAddress: "1842 Oak Ridge Dr, Salisbury NC, 28146", city: "Salisbury", state: "NC", zip: "28146", county: "ROWAN", lat: 35.67, lng: -80.47 },
    { source: "test", sourceId: "b", houseNumber: "1846", street: "1846 Oak Ridge Dr", fullAddress: "1846 Oak Ridge Dr, Salisbury NC, 28146", city: "Salisbury", state: "NC", zip: "28146", county: "ROWAN", lat: 35.6701, lng: -80.4697 },
  ]);
  fx.manager = person("Mara Manager", "manager");
  fx.jordan = person("Jordan Price", "rep");
  fx.rep = person("Saad Rep", "rep");
  // 1838 is already on the map.
  storage.createLead({ address: "1838 Oak Ridge Dr", city: "Salisbury", state: "NC", zip: "28146", lat: 35.67, lng: -80.471, tenantId: 1, leadStatus: "prospect" } as any);
  const { registerRoutes, registerSaasRoutes } = await import("../../server/routes");
  const app = express(); app.use(express.json({ limit: "64kb" }));
  server = createServer(app); registerRoutes(server, app); registerSaasRoutes(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => { if (server) await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))); });

describe("POST /api/leads/import/preview", () => {
  it("matches the columns, locks the phone column, masks it, and counts what would happen", async () => {
    const res = await uploadCsv("/api/leads/import/preview", fx.manager.session, CSV);
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p.columns).toEqual(["Address", "City", "ST", "Zip", "Homeowner", "Assigned rep", "Phone", "Notes"]);
    expect(p.mapping).toEqual({ "0": "address", "1": "city", "2": "state", "3": "zip", "4": "ownerName", "5": "assignedRep", "6": "ignore", "7": "notes" });
    expect(p.validation.ok).toBe(true);
    expect(p.rowCount).toBe(5);
    expect(p.sampleRows[0][6]).toBe("•••"); // the phone cell never leaves the server in clear
    expect(p.summary).toMatchObject({ rows: 5, ready: 2, duplicatesInFile: 1, alreadyOnMap: 1, missingAddress: 1, unknownReps: ["Nobody Known"], countyMatched: 2, addressNotFound: 0 });
    expect(p.needsFix.map((r: any) => r.status)).toEqual(["duplicate_in_file", "already_on_map", "missing_address"]);
  });

  it("refuses a mapping that points a phone column at a field", async () => {
    const res = await uploadCsv("/api/leads/import/preview", fx.manager.session, CSV, { mapping: JSON.stringify({ "0": "address", "1": "city", "6": "notes" }) });
    const p = await res.json();
    expect(p.validation.ok).toBe(false);
    expect(p.validation.issues[0].message).toContain("Phones come in through Calling only");
  });

  it("is a manager's tool: a rep gets 403", async () => {
    expect((await uploadCsv("/api/leads/import/preview", fx.rep.session, CSV)).status).toBe(403);
  });
});

describe("POST /api/leads/import", () => {
  it("creates the ready rows with county coordinates, assigns by the rep in the file, skips the rest", async () => {
    const res = await uploadCsv("/api/leads/import", fx.manager.session, CSV, { assign: "file" });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out).toMatchObject({ created: 2, existing: 0, geocoded: 2, ungeocoded: 0, assigned: 1, unknownReps: ["Nobody Known"] });
    expect(out.skipped).toEqual({ missingAddress: 1, missingCity: 0, duplicatesInFile: 1, alreadyOnMap: 1 });
    const a = rawDb.prepare("SELECT * FROM leads WHERE address = ? AND tenant_id = 1").get("1842 Oak Ridge Dr") as any;
    expect(a.lat).toBe(35.67); expect(a.lng).toBe(-80.47);
    expect(a.contact_name).toBe("Marcus Hill");
    expect(a.contact_phone).toBeNull();
    expect(a.notes).toBe("Asked about 1 Gig");
    expect(a.assigned_rep_id).toBe(fx.jordan.memberId);
    expect(a.assignment_source).toBe("import");
    const b = rawDb.prepare("SELECT assigned_rep_id r, zip FROM leads WHERE address = ? AND tenant_id = 1").get("1846 Oak Ridge Dr") as any;
    expect(b.r).toBeNull();          // unknown rep name falls back to the pool
    expect(b.zip).toBe("28146");     // zip filled from the county file
    expect((rawDb.prepare("SELECT COUNT(*) c FROM leads WHERE address LIKE '1838 Oak Ridge%'").get() as any).c).toBe(1);
  });

  it("is idempotent: importing the same file again creates nothing", async () => {
    const out = await (await uploadCsv("/api/leads/import", fx.manager.session, CSV, { assign: "file" })).json();
    expect(out.created).toBe(0);
    expect(out.skipped.alreadyOnMap).toBe(3);
  });

  it("can send every new door to one rep or to the pool", async () => {
    const csv = "Address,City\n1850 Oak Ridge Dr,Salisbury\n1854 Oak Ridge Dr,Salisbury";
    const one = await (await uploadCsv("/api/leads/import", fx.manager.session, csv, { assign: `rep:${fx.rep.memberId}` })).json();
    expect(one).toMatchObject({ created: 2, assigned: 2, geocoded: 0, ungeocoded: 2 });
    expect((rawDb.prepare("SELECT assigned_rep_id r FROM leads WHERE address = '1850 Oak Ridge Dr'").get() as any).r).toBe(fx.rep.memberId);
    const pool = await (await uploadCsv("/api/leads/import", fx.manager.session, "Address,City\n1858 Oak Ridge Dr,Salisbury", { assign: "pool" })).json();
    expect(pool).toMatchObject({ created: 1, assigned: 0 });
  });

  it("refuses an import whose mapping is not valid, and a rep it cannot see", async () => {
    const bad = await uploadCsv("/api/leads/import", fx.manager.session, "Street,Town\n1 A St,Salisbury", { mapping: JSON.stringify({ "0": "ignore", "1": "ignore" }) });
    expect(bad.status).toBe(400);
    const nope = await uploadCsv("/api/leads/import", fx.manager.session, "Address,City\n2 A St,Salisbury", { assign: "rep:999999" });
    expect([403, 404]).toContain(nope.status);
  });
});
