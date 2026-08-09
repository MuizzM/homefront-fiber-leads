// ── PAY-A2: NACHA ACH file generation (BofA batch upload) ────────────────────
// PPD credits-only (service class 200) weekly pay file. Money figures come from
// the SAME computation as the payroll CSV — commissionService.getWeekOverview —
// so the ACH total reconciles penny-for-penny with week-export.csv's Total row.
//
// Payable set: reps whose weekly statement is APPROVED (FINALIZED or PAID —
// the manager closeout handshake) with POSITIVE final pay. Reps missing active
// bank details or a consented W-9 are BLOCKING exceptions: strict mode (the
// default) refuses the whole file with 409; ?allowPartial=1 pays the payable
// set and returns the excluded reps in the X-Nacha-Exceptions header.
//
// Plaintext bank/TIN secrets exist only inside buildNachaFile()'s local scope;
// nothing here logs or returns them.

import { rawDb } from "./db";
import { storage } from "./storage";
import * as svc from "./commissionService";
import { getBankRow, getBankSecrets, getCompanyProfileSecrets, getLatestW9, getW9Status } from "./payProfileService";
import { isValidAbaRouting } from "./payValidation";

export class NachaError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400, public exceptions?: NachaException[]) { super(message); }
}

export interface NachaException { repId: number; repName: string; missing: string[]; amountCents: number }

export interface NachaResult {
  fileContent: string;
  weekStartUtc: string;
  localWeekLabel: string;
  entryCount: number;
  totalCents: number;          // sum of entries in the file
  overviewTotalCents: number;  // week-export "Total" row for the payable statuses
  entryHash: string;
  effectiveDate: string;       // YYMMDD
  exceptions: NachaException[];
}

const FIXED_WIDTH = 94;
const alpha = (s: string, len: number) => s.replace(/[^A-Za-z0-9 .&'-]/g, " ").toUpperCase().slice(0, len).padEnd(len, " ");
const num = (n: number, len: number) => String(Math.trunc(Math.abs(n))).padStart(len, "0").slice(-len);

/** Next banking day (Mon–Fri) on/after `from`, as YYMMDD. Federal holidays are
 * the operator's call - BofA rejects on holidays with a clear error, and the
 * file can be regenerated with a new effective date via ?fileIdModifier. */
export function nextBankingDay(from: Date): Date {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d;
}

const yymmdd = (d: Date) =>
  `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

export function buildNachaFile(params: {
  tenantId: number;
  actorId: number | null;
  weekReference: string;            // any ISO ref inside the org week (noon-anchored)
  fileIdModifier?: string;          // A–Z / 0–9, per NACHA duplicate-file rules
  now?: Date;                       // file creation date/time (test seam)
}): NachaResult {
  const { tenantId, actorId, weekReference } = params;
  const fileIdModifier = params.fileIdModifier ?? "A";
  if (!/^[A-Z0-9]$/.test(fileIdModifier)) throw new NachaError("INVALID_FILE_ID", "fileIdModifier must be a single A–Z or 0–9 character");
  const now = params.now ?? new Date();

  const company = getCompanyProfileSecrets(tenantId);
  if (!company) {
    throw new NachaError("COMPANY_PROFILE_MISSING", "Company profile is not configured - an admin must complete PUT /api/company-profile (legalName, ein, dfiAccount, dfiRouting, companyId) before the first ACH export.", 409);
  }
  if (!isValidAbaRouting(company.dfiRouting)) throw new NachaError("COMPANY_PROFILE_INVALID", "Company profile dfiRouting fails ABA checksum - fix it via PUT /api/company-profile.", 409);
  const odfi8 = company.dfiRouting.slice(0, 8);

  // THE money-math reuse point: identical computation to /api/commission/week-export.csv.
  // Install-hold exclusion is INHERITED from here: a sale inside its install
  // hold never reaches a statement (countQualifiedSales gates the one
  // aggregation point), so held money cannot appear in a FINALIZED row and
  // therefore can never enter this file. No NACHA-side fork of the math.
  const overview = svc.getWeekOverview(tenantId, actorId, weekReference, null);

  // APPROVED = the closeout handshake locked the statement (FINALIZED), or money
  // already moved (PAID). OPEN/REVIEW rows are projections, never payable.
  const approvedRows = overview.rows.filter(r =>
    (r.status === "FINALIZED" || r.status === "PAID") && r.finalCommissionCents > 0);
  const overviewTotalCents = approvedRows.reduce((s, r) => s + r.finalCommissionCents, 0);

  const exceptions: NachaException[] = [];
  const entries: Array<{ repId: number; repName: string; routing: string; account: string; accountType: "checking" | "savings"; amountCents: number }> = [];
  for (const row of approvedRows) {
    const missing: string[] = [];
    const w9 = getLatestW9(tenantId, row.repId);
    if (!w9 || !w9.consent) missing.push("w9");
    const bank = getBankSecrets(tenantId, row.repId); // decrypts — local scope only
    if (!bank) missing.push("bank");
    else if (!isValidAbaRouting(bank.routing)) missing.push("bank_routing_checksum");
    if (missing.length) {
      exceptions.push({ repId: row.repId, repName: row.repName, missing, amountCents: row.finalCommissionCents });
      continue;
    }
    entries.push({ repId: row.repId, repName: row.repName, routing: bank!.routing, account: bank!.account, accountType: bank!.accountType, amountCents: row.finalCommissionCents });
  }

  const totalCents = entries.reduce((s, e) => s + e.amountCents, 0);
  const entryHashNum = entries.reduce((s, e) => s + Number(e.routing.slice(0, 8)), 0) % 10_000_000_000;
  const entryHash = num(entryHashNum, 10);
  const effective = yymmdd(nextBankingDay(new Date(overview.bounds.weekStartUtc)));

  const lines: string[] = [];
  // ── File Header Record ────────────────────────────────────────────────────
  lines.push([
    "1", "01",
    ` ${company.dfiRouting}`,                                   // immediate destination (b'lank + transit)
    company.companyId.trim().padStart(10, " ").slice(-10),      // immediate origin
    yymmdd(now),                                                // file creation date
    `${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}`,
    fileIdModifier, "094", "10", "1",
    alpha("BANK OF AMERICA", 23),                               // immediate destination name
    alpha(company.legalName, 23),                               // immediate origin name
    " ".repeat(8),                                              // reference code
  ].join(""));

  // ── Company/Batch Header Record ───────────────────────────────────────────
  const batchNumber = "0000001";
  lines.push([
    "5", "200",                                                 // credits only
    alpha(company.legalName, 16),
    " ".repeat(20),                                             // discretionary data
    company.companyId.trim().padEnd(10, " ").slice(0, 10),      // company identification
    "PPD",
    alpha("WEEKLY PAY", 10),
    yymmdd(new Date(overview.bounds.weekStartUtc)),             // descriptive date
    effective,
    "   ",                                                      // settlement date (bank inserts)
    "1",                                                        // originator status
    odfi8,
    batchNumber,
  ].join(""));

  // ── Entry Detail Records ──────────────────────────────────────────────────
  entries.forEach((e, i) => {
    const tranCode = e.accountType === "checking" ? "22" : "32"; // credit
    lines.push([
      "6", tranCode,
      e.routing.slice(0, 8),                                    // receiving DFI
      e.routing.slice(8),                                       // check digit
      e.account.padEnd(17, " ").slice(0, 17),                   // DFI account
      num(e.amountCents, 10),
      `REP${e.repId}`.padEnd(15, " ").slice(0, 15),             // individual id
      alpha(e.repName, 22),
      "  ",                                                     // discretionary
      "0",                                                      // no addenda
      `${odfi8}${num(i + 1, 7)}`,                               // trace number
    ].join(""));
  });

  // ── Company/Batch Control Record ──────────────────────────────────────────
  lines.push([
    "8", "200",
    num(entries.length, 6),
    entryHash,
    "0".repeat(12),                                             // total debit
    num(totalCents, 12),                                        // total credit
    company.companyId.trim().padEnd(10, " ").slice(0, 10),
    " ".repeat(19), " ".repeat(6),
    odfi8, batchNumber,
  ].join(""));

  // ── File Control Record ───────────────────────────────────────────────────
  const recordCountSoFar = lines.length + 1;                    // + this record
  const blockCount = Math.ceil(recordCountSoFar / 10);
  lines.push([
    "9",
    num(1, 6),                                                  // batch count
    num(blockCount, 6),
    num(entries.length, 8),
    entryHash,
    "0".repeat(12),
    num(totalCents, 12),
    " ".repeat(39),
  ].join(""));

  // ── Block filler (records must pad to a multiple of 10) ───────────────────
  while (lines.length % 10 !== 0) lines.push("9".repeat(FIXED_WIDTH));

  for (const line of lines) {
    if (line.length !== FIXED_WIDTH) throw new NachaError("NACHA_WIDTH", `Internal error: NACHA record is ${line.length} chars, expected ${FIXED_WIDTH}`, 500);
  }

  return {
    fileContent: lines.join("\n") + "\n",
    weekStartUtc: overview.bounds.weekStartUtc,
    localWeekLabel: overview.bounds.localWeekLabel,
    entryCount: entries.length,
    totalCents,
    overviewTotalCents,
    entryHash,
    effectiveDate: effective,
    exceptions,
  };
}

// ── 1099-NEC readiness summary ───────────────────────────────────────────────
// JSON-only roll-up for year-end 1099-NEC prep. grossCents = Σ final pay on
// PAID weekly statements whose org week starts inside the calendar year (the
// final column already nets approved adjustments). Hourly/spiff lanes extend
// this sum when they land — the per-rep shape is stable.
export function get1099Summary(tenantId: number, year: number): Array<{
  repId: number; repName: string; legalName: string | null;
  address: { line1: string; city: string; state: string; zip: string } | null;
  tinMasked: string | null; tinType: string | null;
  taxClassification: string | null;
  // TRUE ⇒ the rep certified (Part II item 2, struck on their W-9) that the IRS
  // has notified them they ARE subject to backup withholding. The 24% withhold
  // itself is NOT implemented here — this flag is the operator's signal.
  subjectToBackupWithholding: boolean;
  grossCents: number; overThreshold: boolean; hasW9: boolean; hasBank: boolean;
}> {
  if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new NachaError("INVALID_YEAR", "year must be a 4-digit calendar year");
  const rows = rawDb.prepare(
    `SELECT rep_id, SUM(final_commission_cents) AS gross
       FROM commission_statements
      WHERE tenant_id = ? AND status = 'PAID'
        AND week_start_utc >= ? AND week_start_utc < ?
      GROUP BY rep_id`
  ).all(tenantId, `${year}-01-01T00:00:00.000Z`, `${year + 1}-01-01T00:00:00.000Z`) as any[];
  const grossByRep = new Map<number, number>(rows.map(r => [Number(r.rep_id), Number(r.gross)]));

  // Managers are 1099 payees now that downline overrides make them payable
  // (their overrides land in final_commission_cents like all commission money);
  // members with zero paid gross fall out of overThreshold naturally.
  const reps = storage.getTeamMembers(tenantId) as any[];
  return reps.map(rep => {
    const w9 = getW9Status(tenantId, rep.id);
    const bank = getBankRow(tenantId, rep.id);
    const grossCents = grossByRep.get(rep.id) ?? 0;
    return {
      repId: rep.id, repName: rep.name,
      legalName: w9?.legalName ?? null,
      address: w9 ? (() => { const full = getLatestW9(tenantId, rep.id)!; return { line1: full.address_line1, city: full.city, state: full.state, zip: full.zip }; })() : null,
      tinMasked: w9?.tinMasked ?? null,
      tinType: w9?.tinType ?? null,
      taxClassification: w9?.taxClassification ?? null,
      subjectToBackupWithholding: w9?.subjectToBackupWithholding ?? false,
      grossCents,
      overThreshold: grossCents >= 60000, // $600 1099-NEC filing threshold
      hasW9: !!w9,
      hasBank: !!bank && bank.status === "active",
    };
  }).sort((a, b) => b.grossCents - a.grossCents);
}
