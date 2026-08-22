// ── Lead import: column matching and row evaluation ──────────────────────────
// PURE and framework-free: what a spreadsheet's columns mean, and what each
// row would become. The server feeds it the parsed grid, the tenant's existing
// canonical keys and its rep roster; the page feeds it nothing (it shows the
// server's answer). Phone numbers are never a target: the app only takes
// phone data through the licensed, compliance-gated Calling workspace, so a
// phone-looking column is locked to "ignore" and the page says why.
import { normalizeKineticAddressKey } from "./addressKey";

export type LeadImportTarget =
  | "address" | "city" | "state" | "zip" | "ownerName" | "assignedRep" | "notes" | "ignore";

export const LEAD_IMPORT_TARGETS: ReadonlyArray<{ key: LeadImportTarget; label: string; required?: boolean }> = [
  { key: "address", label: "Street address", required: true },
  { key: "city", label: "City", required: true },
  { key: "state", label: "State" },
  { key: "zip", label: "ZIP" },
  { key: "ownerName", label: "Owner name" },
  { key: "assignedRep", label: "Assigned rep" },
  { key: "notes", label: "Note" },
  { key: "ignore", label: "Not imported" },
];

/** Column index (as a string key, JSON-friendly) to target. */
export type LeadImportMapping = Record<string, LeadImportTarget>;

export const MAX_LEAD_IMPORT_ROWS = 5_000;
export const DEFAULT_IMPORT_STATE = "NC";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Headers that mean a phone number. Locked to "ignore": never a target. */
export function isPhoneHeader(header: string): boolean {
  const h = norm(header);
  return /\b(phone|mobile|cell|tel|telephone|fax)\b/.test(h);
}
export function isEmailHeader(header: string): boolean {
  return /\b(e ?mail)\b/.test(norm(header));
}

const RULES: Array<{ target: LeadImportTarget; test: (h: string) => boolean }> = [
  { target: "address", test: (h) => /^(street )?address( ?1| line ?1)?$|^addr(ess)?$|^street$|^street address$|^address line$|^st address$|^property address$|^site address$/.test(h) },
  { target: "city", test: (h) => /^(city|town|municipality)$/.test(h) },
  { target: "state", test: (h) => /^(state|st|province|region)$/.test(h) },
  { target: "zip", test: (h) => /^(zip|zip ?code|postal ?code|postcode|zip5)$/.test(h) },
  { target: "ownerName", test: (h) => /^(owner|owner name|homeowner|home owner|resident|occupant|contact|contact name|customer|customer name|name|full name|first name)$/.test(h) },
  { target: "assignedRep", test: (h) => /\b(rep|sales ?rep|salesperson|assigned|assignee|agent|closer|knocker)\b/.test(h) },
  { target: "notes", test: (h) => /^(note|notes|comment|comments|remarks|memo)$/.test(h) },
];

/**
 * Best-guess mapping from header names. Each target is taken once (the first
 * column that matches it); everything else is "ignore". Phone and e-mail
 * columns are always ignored, whatever they are called.
 */
export function suggestLeadImportMapping(columns: string[]): LeadImportMapping {
  const mapping: LeadImportMapping = {};
  const taken = new Set<LeadImportTarget>();
  columns.forEach((raw, i) => {
    const key = String(i);
    if (isPhoneHeader(raw) || isEmailHeader(raw)) { mapping[key] = "ignore"; return; }
    const h = norm(raw);
    const hit = RULES.find((r) => !taken.has(r.target) && r.test(h));
    if (hit) { mapping[key] = hit.target; taken.add(hit.target); }
    else mapping[key] = "ignore";
  });
  return mapping;
}

export interface MappingIssue { column: number | null; message: string }

/** Structural check of a mapping against the file's columns. */
export function validateLeadImportMapping(mapping: LeadImportMapping, columns: string[]): { ok: boolean; issues: MappingIssue[] } {
  const issues: MappingIssue[] = [];
  const seen = new Map<LeadImportTarget, number>();
  for (const [k, target] of Object.entries(mapping)) {
    const i = Number(k);
    if (!Number.isInteger(i) || i < 0 || i >= columns.length) { issues.push({ column: null, message: `Column ${k} is not in the file` }); continue; }
    if (!LEAD_IMPORT_TARGETS.some((t) => t.key === target)) { issues.push({ column: i, message: `Unknown field "${String(target)}"` }); continue; }
    if (target === "ignore") continue;
    if (isPhoneHeader(columns[i])) { issues.push({ column: i, message: `"${columns[i]}" looks like phone numbers. Phones come in through Calling only.` }); continue; }
    if (seen.has(target)) { issues.push({ column: i, message: `"${columns[i]}" and "${columns[seen.get(target)!]}" both map to ${LEAD_IMPORT_TARGETS.find((t) => t.key === target)!.label}` }); continue; }
    seen.set(target, i);
  }
  for (const t of LEAD_IMPORT_TARGETS) {
    if (t.required && !seen.has(t.key)) issues.push({ column: null, message: `${t.label} is required. Pick the column that holds it.` });
  }
  return { ok: issues.length === 0, issues };
}

export type LeadImportRowStatus = "ready" | "missing_address" | "missing_city" | "duplicate_in_file" | "already_on_map";

export interface EvaluatedLeadRow {
  rowNumber: number;          // 1-based data row (header is row 0)
  status: LeadImportRowStatus;
  address: string;
  city: string;
  state: string;
  zip: string;
  ownerName: string | null;
  repName: string | null;
  repId: number | null;       // resolved against the roster, null when unknown
  notes: string | null;
  key: string;                // canonical key (normalizeKineticAddressKey)
}

export interface LeadImportSummary {
  rows: number;
  ready: number;
  missingAddress: number;
  missingCity: number;
  duplicatesInFile: number;
  alreadyOnMap: number;
  unknownReps: string[];      // distinct names the roster could not match
  repMatched: number;         // ready rows whose rep resolved
}

export function normalizeRepName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Evaluate every data row under a mapping. `existingKeys` are the tenant's
 * canonical keys (a row whose key is already a lead is "already_on_map");
 * `roster` maps a normalized rep name (and e-mail) to a team member id.
 */
export function evaluateLeadImportRows(
  rows: string[][],
  mapping: LeadImportMapping,
  opts: { existingKeys: ReadonlySet<string>; roster: ReadonlyMap<string, number>; defaultState?: string },
): { rows: EvaluatedLeadRow[]; summary: LeadImportSummary } {
  const col = (target: LeadImportTarget): number => {
    for (const [k, t] of Object.entries(mapping)) if (t === target) return Number(k);
    return -1;
  };
  const ix = {
    address: col("address"), city: col("city"), state: col("state"), zip: col("zip"),
    ownerName: col("ownerName"), assignedRep: col("assignedRep"), notes: col("notes"),
  };
  const cell = (row: string[], i: number) => (i >= 0 ? String(row[i] ?? "").trim() : "");
  const defaultState = (opts.defaultState ?? DEFAULT_IMPORT_STATE).toUpperCase();
  const seenKeys = new Set<string>();
  const unknown = new Set<string>();
  const out: EvaluatedLeadRow[] = [];
  const summary: LeadImportSummary = { rows: 0, ready: 0, missingAddress: 0, missingCity: 0, duplicatesInFile: 0, alreadyOnMap: 0, unknownReps: [], repMatched: 0 };

  rows.forEach((row, n) => {
    if (row.every((c) => String(c ?? "").trim() === "")) return; // blank line, not a row
    summary.rows++;
    const address = cell(row, ix.address);
    const city = cell(row, ix.city);
    const stateRaw = cell(row, ix.state).toUpperCase();
    const state = /^[A-Z]{2}$/.test(stateRaw) ? stateRaw : defaultState;
    const zipRaw = cell(row, ix.zip);
    const zip = (zipRaw.match(/\d{5}/)?.[0]) ?? "";
    const ownerName = cell(row, ix.ownerName) || null;
    const repName = cell(row, ix.assignedRep) || null;
    const repId = repName ? (opts.roster.get(normalizeRepName(repName)) ?? null) : null;
    if (repName && repId == null) unknown.add(repName);
    const notes = cell(row, ix.notes) || null;
    const key = address ? normalizeKineticAddressKey(address, city, state, zip) : "";
    let status: LeadImportRowStatus = "ready";
    if (address.length < 3) { status = "missing_address"; summary.missingAddress++; }
    else if (city.length < 2) { status = "missing_city"; summary.missingCity++; }
    else if (seenKeys.has(key)) { status = "duplicate_in_file"; summary.duplicatesInFile++; }
    else if (opts.existingKeys.has(key)) { status = "already_on_map"; summary.alreadyOnMap++; }
    if (status === "ready") { summary.ready++; if (repId != null) summary.repMatched++; }
    if (key) seenKeys.add(key);
    out.push({ rowNumber: n + 1, status, address, city, state, zip, ownerName, repName, repId, notes, key });
  });
  summary.unknownReps = [...unknown].sort();
  return { rows: out, summary };
}
