import crypto from "node:crypto";
import { z } from "zod";
import { rawDb } from "./db";
import { parseCsvRows } from "./csv";
import {
  hashKineticEvidence,
  importedKineticEvidenceSchema,
  normalizeImportedKineticEvidence,
  type ImportedKineticEvidence,
} from "./kineticProviderAdapter";
import { upsertKineticAddress } from "./kineticScannerStore";

export const KINETIC_IMPORT_PARSER_VERSION = "kinetic-import-v1";
const MAX_RECORDS = 10_000;

export const importEnvelopeSchema = z
  .discriminatedUnion("format", [
    z
      .object({
        format: z.literal("json"),
        sourceName: z.string().trim().min(2).max(100),
        records: z.array(z.unknown()).min(1).max(MAX_RECORDS),
      })
      .strict(),
    z
      .object({
        format: z.literal("csv"),
        sourceName: z.string().trim().min(2).max(100),
        content: z
          .string()
          .min(1)
          .max(10 * 1024 * 1024),
      })
      .strict(),
  ])
  .and(
    z.object({
      parserVersion: z
        .literal(KINETIC_IMPORT_PARSER_VERSION)
        .default(KINETIC_IMPORT_PARSER_VERSION),
    }),
  );

export const manualVerificationSchema = importedKineticEvidenceSchema
  .omit({ sourceName: true, evidenceId: true })
  .extend({
    reviewerNote: z.string().trim().min(10).max(2_000),
  })
  .strict();

export interface EvidenceIngestSummary {
  batchId: string;
  total: number;
  accepted: number;
  rejected: number;
  replays: number;
  issues: Array<{ index: number; message: string }>;
}

// Header adapter over the shared row tokenizer. This importer's contract:
// headers trimmed + lowercased, every cell trimmed, short rows padded to "".
//
// Blank-row handling deliberately does NOT use csv.ts's `isBlankCsvRow` — that
// helper drops only literally-empty fields, whereas an uploaded evidence sheet
// has always had its whitespace-only rows (" , ") dropped too. The filter runs
// before the header is read, so a leading blank line is skipped and the first
// row with content is the header, exactly as before.
function parseCsv(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text).filter((row) =>
    row.some((value) => value.trim()),
  );
  if (!rows.length) return [];
  const headers = rows[0].map((value) => value.trim().toLowerCase());
  if (new Set(headers).size !== headers.length)
    throw new Error("CSV contains duplicate headers");
  return rows
    .slice(1)
    .map((values) =>
      Object.fromEntries(
        headers.map((header, index) => [header, values[index]?.trim() ?? ""]),
      ),
    );
}

function nullableBoolean(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}
function nullableNumber(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value);
  if (!Number.isFinite(number))
    throw new Error(`Invalid number value: ${value}`);
  return number;
}

function rowToEvidence(
  row: Record<string, string>,
  sourceName: string,
): ImportedKineticEvidence {
  const allowed = new Set([
    "evidence_id",
    "source_reference",
    "address",
    "city",
    "state",
    "zip",
    "unit",
    "observed_at",
    "latitude",
    "longitude",
    "technology_type",
    "maximum_qualification",
    "is_live",
    "is_coming_soon",
    "is_copper_upgrade_candidate",
  ]);
  const unknown = Object.keys(row).filter((key) => !allowed.has(key));
  if (unknown.length)
    throw new Error(`Unsupported CSV headers: ${unknown.join(", ")}`);
  return importedKineticEvidenceSchema.parse({
    evidenceId: row.evidence_id || undefined,
    sourceReference: row.source_reference || undefined,
    address: row.address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    unit: row.unit || null,
    observedAt: row.observed_at,
    latitude: nullableNumber(row.latitude ?? ""),
    longitude: nullableNumber(row.longitude ?? ""),
    technologyType: row.technology_type || null,
    maximumQualification: nullableNumber(row.maximum_qualification ?? ""),
    isLive: nullableBoolean(row.is_live ?? ""),
    isComingSoon: nullableBoolean(row.is_coming_soon ?? ""),
    isCopperUpgradeCandidate: nullableBoolean(
      row.is_copper_upgrade_candidate ?? "",
    ),
    sourceName,
  });
}

export function ingestApprovedImport(input: {
  tenantId: number;
  actorId: number | null;
  payload: unknown;
}): EvidenceIngestSummary {
  const envelope = importEnvelopeSchema.parse(input.payload),
    rawRecords =
      envelope.format === "json"
        ? envelope.records
        : parseCsv(envelope.content);
  if (rawRecords.length > MAX_RECORDS)
    throw new Error(`Import exceeds ${MAX_RECORDS.toLocaleString()} records`);
  const batchId = crypto.randomUUID(),
    contentHash = hashKineticEvidence(input.payload);
  rawDb
    .prepare(
      `INSERT INTO kinetic_import_batches (id,tenant_id,mode,source_name,format,parser_version,record_count,content_hash,created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      batchId,
      input.tenantId,
      "authorized_import",
      envelope.sourceName,
      envelope.format,
      KINETIC_IMPORT_PARSER_VERSION,
      rawRecords.length,
      contentHash,
      input.actorId,
    );
  let accepted = 0,
    rejected = 0,
    replays = 0;
  const issues: Array<{ index: number; message: string }> = [];
  rawRecords.forEach((raw, index) => {
    try {
      const parsed =
        envelope.format === "csv"
          ? rowToEvidence(raw as Record<string, string>, envelope.sourceName)
          : importedKineticEvidenceSchema.parse({
              ...(raw as object),
              sourceName: envelope.sourceName,
            });
      const stored = upsertKineticAddress(
        input.tenantId,
        null,
        normalizeImportedKineticEvidence(
          parsed,
          "authorized_import",
          KINETIC_IMPORT_PARSER_VERSION,
        ),
        batchId,
      );
      if (stored.transitionAction === "REPLAY") replays++;
      else accepted++;
    } catch (error) {
      rejected++;
      if (issues.length < 100)
        issues.push({
          index,
          message: error instanceof Error ? error.message : String(error),
        });
    }
  });
  rawDb
    .prepare(
      `UPDATE kinetic_import_batches SET accepted_count=?,rejected_count=?,completed_at=datetime('now') WHERE id=?`,
    )
    .run(accepted + replays, rejected, batchId);
  return {
    batchId,
    total: rawRecords.length,
    accepted,
    rejected,
    replays,
    issues,
  };
}

export function ingestManualVerification(input: {
  tenantId: number;
  actorId: number;
  payload: unknown;
}) {
  const parsed = manualVerificationSchema.parse(input.payload),
    sourceName = `manual:user:${input.actorId}`;
  const evidenceInput = { ...parsed, sourceName };
  delete (evidenceInput as any).reviewerNote;
  const normalized = normalizeImportedKineticEvidence(
      evidenceInput,
      "manual_verification",
      KINETIC_IMPORT_PARSER_VERSION,
    ),
    raw = { ...evidenceInput, reviewerNote: parsed.reviewerNote };
  normalized.rawResponse = raw;
  normalized.responseHash = hashKineticEvidence(raw);
  normalized.evidenceId = normalized.responseHash;
  const batchId = crypto.randomUUID();
  rawDb
    .prepare(
      `INSERT INTO kinetic_import_batches (id,tenant_id,mode,source_name,format,parser_version,record_count,content_hash,created_by,completed_at) VALUES (?,?,?,?,?,?,1,?,?,datetime('now'))`,
    )
    .run(
      batchId,
      input.tenantId,
      "manual_verification",
      sourceName,
      "manual",
      KINETIC_IMPORT_PARSER_VERSION,
      normalized.responseHash,
      input.actorId,
    );
  const stored = upsertKineticAddress(
    input.tenantId,
    null,
    normalized,
    batchId,
  );
  rawDb
    .prepare(`UPDATE kinetic_import_batches SET accepted_count=? WHERE id=?`)
    .run(stored.transitionAction === "REPLAY" ? 0 : 1, batchId);
  return {
    batchId,
    addressId: stored.id,
    discoveryState: stored.discoveryState,
    fresh: stored.fresh,
    replay: stored.transitionAction === "REPLAY",
  };
}
