import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "hf-calling-dnc-"));
const NOW = new Date("2026-07-14T16:00:00.000Z");
const signingKeyHex = "44".repeat(32);
let rawDb: import("better-sqlite3").Database;
let tenantId = 0;
let actorUserId = 0;
let store: typeof import("../../server/calling/store");
let cryptoModule: typeof import("../../server/calling/crypto");

const phoneChunks = [["3365551212", "3365551213"], ["3365551214"]];

function sourceManifestHash(): string {
  const descriptions = phoneChunks.map((chunk, index) => {
    const normalized = chunk.map((phone) => `+1${phone}`).sort();
    const hash = crypto.createHash("sha256").update(normalized.join("\n")).digest("hex");
    return `${index}:${hash}:${chunk.length}:${normalized.length}`;
  });
  return crypto.createHash("sha256").update(descriptions.join("\n")).digest("hex");
}

function signedManifest(versionLabel: string, override: Record<string, unknown> = {}) {
  const manifest = {
    tenantId,
    sourceType: "national" as const,
    state: null,
    versionLabel,
    authorizedAccountRef: "authorized-registry-account://test",
    coveredAreaCodes: ["ALL"],
    expectedRecordCount: 3,
    expectedChunkCount: 2,
    chunkSize: 2,
    sourceManifestSha256: sourceManifestHash(),
    sourceAsOf: "2026-07-14T12:00:00.000Z",
    sourceRetrievedAt: "2026-07-14T13:00:00.000Z",
    maxAgeDays: 31,
    ...override,
  };
  const signature = crypto.createHmac("sha256", Buffer.from(signingKeyHex, "hex"))
    .update(cryptoModule.canonicalDncImportManifest(manifest)).digest("hex");
  return { ...manifest, manifestSignature: signature, actorUserId };
}

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.DATA_DIR = dataDir;
  process.env.PHONE_HASH_KEY = "22".repeat(32);
  process.env.DNC_IMPORT_MANIFEST_SIGNING_KEY = signingKeyHex;
  const storage = await import("../../server/storage");
  ({ rawDb } = await import("../../server/db"));
  storage.runMigrations();
  tenantId = storage.getDefaultTenantId()!;
  (await import("../../server/calling/migrations")).runCallingMigrations();
  actorUserId = Number(rawDb.prepare(`INSERT INTO users
    (name,email,role,active,tenant_id,created_at) VALUES ('DNC Admin','dnc-admin@example.test','compliance_admin',1,?,?)`)
    .run(tenantId, NOW.toISOString()).lastInsertRowid);
  store = await import("../../server/calling/store");
  cryptoModule = await import("../../server/calling/crypto");
});

afterAll(() => {
  vi.useRealTimers();
  for (const key of ["DATA_DIR", "PHONE_HASH_KEY", "DNC_IMPORT_MANIFEST_SIGNING_KEY"]) delete process.env[key];
  try { rawDb.close(); } catch { /* already closed */ }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("signed resumable DNC import", () => {
  it("rejects a tampered signature before creating an import job", () => {
    expect(() => store.beginDncImport({ ...signedManifest("tampered-signature"), manifestSignature: "00".repeat(32) }))
      .toThrow(/signature is invalid/i);
    expect(rawDb.prepare("SELECT count(*) AS count FROM dnc_import_jobs").get()).toEqual({ count: 0 });
  });

  it("refuses missing chunks and a signed manifest checksum mismatch", () => {
    const missing = store.beginDncImport(signedManifest("missing-chunk"));
    store.appendDncImportChunk({ tenantId, importId: missing.importId, chunkIndex: 0, phones: phoneChunks[0] });
    expect(() => store.finalizeDncImport({ tenantId, importId: missing.importId, actorUserId }))
      .toThrow(/missing one or more signed chunks/i);

    const mismatch = store.beginDncImport(signedManifest("checksum-mismatch", {
      sourceManifestSha256: "ab".repeat(32),
    }));
    phoneChunks.forEach((phones, chunkIndex) => store.appendDncImportChunk({ tenantId, importId: mismatch.importId, chunkIndex, phones }));
    expect(() => store.finalizeDncImport({ tenantId, importId: mismatch.importId, actorUserId }))
      .toThrow(/manifest checksum does not match/i);
  });

  it("activates only a complete tenant-bound import and never stores raw phone numbers", () => {
    const manifest = signedManifest("complete-import");
    const job = store.beginDncImport(manifest);
    expect(store.beginDncImport(manifest)).toEqual({ ...job, replayed: true });
    phoneChunks.forEach((phones, chunkIndex) => store.appendDncImportChunk({ tenantId, importId: job.importId, chunkIndex, phones }));
    expect(() => store.finalizeDncImport({ tenantId: tenantId + 10_000, importId: job.importId, actorUserId }))
      .toThrow(/not found/i);
    const result = store.finalizeDncImport({ tenantId, importId: job.importId, actorUserId });
    expect(result).toMatchObject({ recordCount: 3 });
    expect(Date.parse(result.expiresAt)).toBe(Date.parse("2026-08-14T12:00:00.000Z"));
    expect(rawDb.prepare("SELECT count(*) AS count FROM dnc_suppressions WHERE tenant_id=? AND dataset_version_id=?")
      .get(tenantId, result.datasetId)).toEqual({ count: 3 });
    expect(rawDb.prepare("SELECT count(*) AS count FROM dnc_import_staging WHERE tenant_id=? AND import_id=?")
      .get(tenantId, job.importId)).toEqual({ count: 0 });
    const serialized = JSON.stringify(rawDb.prepare("SELECT * FROM dnc_import_jobs WHERE id=?").get(job.importId));
    expect(serialized).not.toContain("336555");
    expect(store.beginDncImport(manifest)).toEqual({
      importId: job.importId,
      status: "finalized",
      replayed: true,
      finalized: result,
    });
  });
});
