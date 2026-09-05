// ── Lead import: a spreadsheet onto the map ──────────────────────────────────
// Two routes, one parse. PREVIEW reads the file, suggests (or applies) a
// column mapping, evaluates every row against the tenant's existing doors and
// rep roster, and says what would happen. IMPORT does the same and then
// creates the ready rows in chunked transactions, geocoding each address
// against the county address file first (exact, free, the same points that
// draw the house numbers) and leaving the rest for the geocode backfill.
//
// Bounded on purpose: one file, 8 MB, 5,000 rows, chunked writes with the
// event loop yielded between chunks. Phone columns are never imported: the
// app only takes phone data through the licensed Calling workspace.
// Tenant scoping: every read and write goes through the caller's tenant.
import { type Express, type Request, type Response } from "express";
import multer from "multer";
import { storage } from "./storage";
import { rawDb } from "./db";
import { parseCsvRows, isBlankCsvRow } from "./csv";
import { looksLikeXlsx, readXlsxFirstSheet, XlsxError } from "./xlsx";
import { lookupAddressPointsByKeys } from "./addressPointStore";
import { premiseBaseKey } from "../shared/addressKey";
import {
  evaluateLeadImportRows, suggestLeadImportMapping, validateLeadImportMapping, normalizeRepName,
  isPhoneHeader, isEmailHeader, MAX_LEAD_IMPORT_ROWS,
  type LeadImportMapping, type EvaluatedLeadRow,
} from "../shared/leadImport";
import type { Capability } from "../shared/capabilities";
import type { TeamMember } from "../shared/schema";

export const MAX_LEAD_IMPORT_BYTES = 8 * 1024 * 1024;
const IMPORT_CHUNK = 500;
const SAMPLE_ROWS = 5;
const NEEDS_FIX_ROWS = 500;

interface Deps {
  requireCapability: (cap: Capability) => any;
  repInVisibilityScope: (user: any, repId: number) => boolean;
  repInCallerTenant: (user: any, repId: number) => boolean;
  leadVisibilityScope: (user: any, roster: TeamMember[]) => number | number[] | undefined;
  bustMapCache: (tenantId?: number) => void;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LEAD_IMPORT_BYTES, files: 1, fields: 8 },
});
function uploadOnce(req: Request, res: Response, next: any) {
  upload.single("file")(req, res, (err: any) => {
    if (!err) return next();
    const tooBig = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE";
    return res.status(400).json({
      error: tooBig ? `That file is larger than ${Math.round(MAX_LEAD_IMPORT_BYTES / (1024 * 1024))} MB. Split it and import the halves.` : "That upload could not be read.",
    });
  });
}

interface ParsedFile { columns: string[]; rows: string[][]; rowCount: number; truncated: boolean }

/** Sniffed, not trusted: the bytes decide whether this is a workbook or text. */
export function parseLeadFile(buffer: Buffer): ParsedFile {
  let grid: string[][];
  if (looksLikeXlsx(buffer.subarray(0, 8))) {
    grid = readXlsxFirstSheet(buffer).rows;
  } else {
    const text = buffer.toString("utf8").replace(/^﻿/, "");
    grid = parseCsvRows(text);
  }
  let columns: string[] | undefined;
  const rows: string[][] = [];
  let rowCount = 0;
  // Preview reports the full row count, but only retained rows need copying.
  for (const row of grid) {
    if (isBlankCsvRow(row)) continue;
    if (columns === undefined) {
      columns = row.map((cell) => String(cell ?? "").trim());
      continue;
    }
    rowCount++;
    if (rows.length < MAX_LEAD_IMPORT_ROWS) rows.push(row.map((cell) => String(cell ?? "")));
  }
  return { columns: columns ?? [], rows, rowCount, truncated: rowCount > MAX_LEAD_IMPORT_ROWS };
}

function parseMapping(raw: unknown): LeadImportMapping | null {
  if (raw == null || raw === "") return null;
  try {
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    const out: LeadImportMapping = {};
    for (const [k, v] of Object.entries(obj)) out[String(k)] = String(v) as any;
    return out;
  } catch { return null; }
}

/** Canonical keys the tenant already holds, among the candidates. */
function existingKeysFor(tenantId: number | undefined, keys: string[]): Set<string> {
  const out = new Set<string>();
  const list = [...new Set(keys.filter(Boolean))];
  for (let i = 0; i < list.length; i += 500) {
    const chunk = list.slice(i, i + 500);
    const tenantSql = tenantId == null ? "1=1" : "tenant_id = ?";
    const rows = rawDb.prepare(
      `SELECT canonical_key AS k FROM leads WHERE ${tenantSql} AND canonical_key IN (${chunk.map(() => "?").join(",")})`,
    ).all(...(tenantId == null ? [] : [tenantId]), ...chunk) as Array<{ k: string }>;
    for (const r of rows) out.add(r.k);
  }
  return out;
}

/** Reps this caller may assign to, keyed by normalized name and by e-mail. */
function rosterFor(user: any, deps: Deps): { byName: Map<string, number>; names: Map<number, string> } {
  const byName = new Map<string, number>();
  const names = new Map<number, string>();
  const tid = user?.tenantId ?? undefined;
  const roster = storage.getTeamMembers(tid);
  // Resolve permission scope once from this request's authoritative roster.
  // Per-member checks previously reloaded the entire team for every row.
  const scope = deps.leadVisibilityScope(user, roster);
  const allowed = scope === undefined ? null : new Set(Array.isArray(scope) ? scope : [scope]);
  for (const m of roster) {
    if (!m?.active) continue;
    if (allowed && !allowed.has(m.id)) continue;
    if (user?.role !== "super_admin" && (user?.tenantId == null || m.tenantId == null || m.tenantId !== user.tenantId)) continue;
    byName.set(normalizeRepName(String(m.name ?? "")), m.id);
    if (m.email) byName.set(String(m.email).toLowerCase(), m.id);
    names.set(m.id, String(m.name ?? ""));
  }
  return { byName, names };
}

function maskSample(columns: string[], rows: string[][]): string[][] {
  const hidden = columns.map((c) => isPhoneHeader(c) || isEmailHeader(c));
  return rows.slice(0, SAMPLE_ROWS).map((r) => columns.map((_, i) => (hidden[i] ? (r[i] ? "•••" : "") : String(r[i] ?? "").slice(0, 80))));
}

function evaluateUpload(req: Request, user: any, deps: Deps) {
  const file = (req as any).file as { buffer: Buffer; originalname?: string } | undefined;
  if (!file?.buffer?.length) return { error: { status: 400, body: { error: "Choose a CSV or XLSX file first." } } } as const;
  let parsed: ParsedFile;
  try { parsed = parseLeadFile(file.buffer); }
  catch (e: any) {
    return { error: { status: 400, body: { error: e instanceof XlsxError ? e.message : "That file could not be read as CSV or XLSX." } } } as const;
  }
  if (!parsed.columns.length) return { error: { status: 400, body: { error: "The first row must be the column headers." } } } as const;
  const mapping = parseMapping((req as any).body?.mapping) ?? suggestLeadImportMapping(parsed.columns);
  const validation = validateLeadImportMapping(mapping, parsed.columns);
  const roster = rosterFor(user, deps);
  const tid = user?.tenantId ?? undefined;
  // Evaluate with the tenant's existing keys only when the mapping can name an
  // address; otherwise every row is "missing address" and the keys are moot.
  let evaluated = validation.ok
    ? evaluateLeadImportRows(parsed.rows, mapping, { existingKeys: new Set(), roster: roster.byName })
    : null;
  if (evaluated) {
    const existing = existingKeysFor(tid, evaluated.rows.map((r) => r.key));
    evaluated = evaluateLeadImportRows(parsed.rows, mapping, { existingKeys: existing, roster: roster.byName });
  }
  return { ok: { file, parsed, mapping, validation, evaluated, roster, tid } } as const;
}

/** County coordinates for the ready rows, by premise key. */
function countyCoordsFor(rows: EvaluatedLeadRow[]): Map<number, { lat: number; lng: number; zip: string | null }> {
  const keyOf = (r: EvaluatedLeadRow) => premiseBaseKey(r.address, r.city, r.state);
  const keys = rows.map(keyOf);
  const found = lookupAddressPointsByKeys(keys);
  const out = new Map<number, { lat: number; lng: number; zip: string | null }>();
  rows.forEach((r, i) => {
    const p = found.get(keys[i]);
    if (p) out.set(r.rowNumber, { lat: p.lat, lng: p.lng, zip: p.zip ?? null });
  });
  return out;
}

export function registerLeadImportRoutes(app: Express, deps: Deps): void {
  const { requireCapability } = deps;

  app.post("/api/leads/import/preview", requireCapability("lead.assign"), uploadOnce, (req, res) => {
    const user = (req as any).user;
    const r = evaluateUpload(req, user, deps);
    if ("error" in r && r.error) return res.status(r.error.status).json(r.error.body);
    if (!("ok" in r)) return res.status(400).json({ error: "That upload could not be read." });
    const { file, parsed, mapping, validation, evaluated } = r.ok;
    const ready = evaluated?.rows.filter((x) => x.status === "ready") ?? [];
    const county = evaluated ? countyCoordsFor(ready) : new Map();
    res.json({
      fileName: String(file.originalname ?? "leads"),
      columns: parsed.columns,
      rowCount: parsed.rowCount,
      truncated: parsed.truncated,
      maxRows: MAX_LEAD_IMPORT_ROWS,
      mapping,
      validation,
      sampleRows: maskSample(parsed.columns, parsed.rows),
      summary: evaluated ? { ...evaluated.summary, countyMatched: county.size, addressNotFound: ready.length - county.size } : null,
      needsFix: evaluated
        ? evaluated.rows.filter((x) => x.status !== "ready").slice(0, NEEDS_FIX_ROWS)
            .map(({ rowNumber, status, address, city, state, zip, repName }) => ({ rowNumber, status, address, city, state, zip, repName }))
        : [],
    });
  });

  app.post("/api/leads/import", requireCapability("lead.assign"), uploadOnce, async (req, res) => {
    const user = (req as any).user;
    const r = evaluateUpload(req, user, deps);
    if ("error" in r && r.error) return res.status(r.error.status).json(r.error.body);
    if (!("ok" in r)) return res.status(400).json({ error: "That upload could not be read." });
    const { parsed, validation, evaluated, roster, tid } = r.ok;
    if (!validation.ok || !evaluated) return res.status(400).json({ error: "Fix the column matching first.", issues: validation.issues });
    if (parsed.truncated) {
      return res.status(400).json({ error: `That file has ${parsed.rowCount.toLocaleString()} rows - at most ${MAX_LEAD_IMPORT_ROWS.toLocaleString()} per import. Split it and import the halves.`, code: "TOO_MANY_ROWS" });
    }
    // Where new doors go: the pool, the rep named on each row (unknown names
    // fall back to the pool), or one rep for the whole file.
    const assignRaw = String((req as any).body?.assign ?? "file");
    let mode: "pool" | "file" | "rep" = "file";
    let oneRep: number | null = null;
    if (assignRaw === "pool") mode = "pool";
    else if (assignRaw === "file") mode = "file";
    else if (/^rep:\d+$/.test(assignRaw)) {
      mode = "rep"; oneRep = Number(assignRaw.slice(4));
      if (!deps.repInVisibilityScope(user, oneRep)) return res.status(403).json({ error: "That rep is not on your team", code: "OUT_OF_SCOPE" });
      if (!deps.repInCallerTenant(user, oneRep)) return res.status(404).json({ error: "Rep not found" });
    } else return res.status(400).json({ error: "assign must be pool, file, or rep:<id>" });

    const ready = evaluated.rows.filter((x) => x.status === "ready");
    const county = countyCoordsFor(ready);
    let created = 0, existing = 0, geocoded = 0, assigned = 0;
    const createdIds: number[] = [];
    const assignedBy = user?.name ?? user?.email ?? "import";
    for (let i = 0; i < ready.length; i += IMPORT_CHUNK) {
      const chunk = ready.slice(i, i + IMPORT_CHUNK);
      const run = rawDb.transaction(() => {
        const find = rawDb.prepare(`SELECT id FROM leads WHERE ${tid == null ? "1=1" : "tenant_id = ?"} AND canonical_key = ? LIMIT 1`);
        for (const row of chunk) {
          // A door that arrived since the preview: count it, never double it.
          const hit = find.get(...(tid == null ? [] : [tid]), row.key) as { id: number } | undefined;
          if (hit) { existing++; continue; }
          const coords = county.get(row.rowNumber) ?? null;
          const repId = mode === "pool" ? null : mode === "rep" ? oneRep : row.repId;
          const lead = storage.createLead({
            address: row.address, city: row.city, state: row.state,
            zip: row.zip || coords?.zip || "",
            lat: coords?.lat ?? null, lng: coords?.lng ?? null,
            leadStatus: "prospect",
            ...(row.ownerName ? { contactName: row.ownerName } : {}),
            ...(row.notes ? { notes: row.notes } : {}),
            ...(repId != null ? { assignedRepId: repId, assignedBy, assignedAt: new Date().toISOString(), assignmentSource: "import" } : {}),
            ...(tid != null ? { tenantId: tid } : {}),
          } as any);
          createdIds.push(lead.id);
          created++;
          if (coords) geocoded++;
          if (repId != null) assigned++;
        }
      });
      run.immediate();
      if (i + IMPORT_CHUNK < ready.length) await new Promise((resolve) => setImmediate(resolve));
    }
    if (created > 0) deps.bustMapCache(tid);
    storage.logActivity(user?.id ?? null, "lead.import", "lead", undefined, {
      fileRows: parsed.rowCount, ready: ready.length, created, existing, geocoded, assigned, mode,
      skipped: evaluated.summary.rows - ready.length,
    }, req.ip);
    res.json({
      created, existing, geocoded, ungeocoded: created - geocoded, assigned,
      skipped: { missingAddress: evaluated.summary.missingAddress, missingCity: evaluated.summary.missingCity, duplicatesInFile: evaluated.summary.duplicatesInFile, alreadyOnMap: evaluated.summary.alreadyOnMap },
      unknownReps: evaluated.summary.unknownReps,
      repNames: Object.fromEntries(roster.names),
    });
  });
}
