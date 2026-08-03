// ── PAY-A2: contractor pay-plane routes ──────────────────────────────────────
// Rep self-service (bank + W-9), manager oversight (masked only), the company
// ODFI profile, the NACHA ACH export, and the 1099-NEC readiness summary.
// Registered from routes.ts with the shared requireAuth / requireCapability so
// authorization is identical to the rest of the app. Secrets NEVER appear in
// responses, logs, or audit details — masked views only (see payCrypto.ts).

import type { Express, Request, Response, NextFunction } from "express";
import fs from "node:fs";
import path from "node:path";
import { storage } from "./storage";
import { payWriteLimiter } from "./limiters";
import { paySecretsReady } from "./payCrypto";
import { validateW9Input } from "./payValidation";
import * as profile from "./payProfileService";
import { renderW9Pdf, W9EncodingError, W9FieldError, W9TemplateError } from "./w9Pdf";
import * as nacha from "./nachaService";

type Mw = (req: Request, res: Response, next: NextFunction) => void;
interface Deps { requireAuth: Mw; requireCapability: (cap: any) => Mw; }

function fail(res: Response, e: unknown) {
  if (e instanceof profile.PayError) return res.status(e.httpStatus).json({ error: e.message, code: e.code });
  // A name the IRS form's Latin font cannot print is the SIGNER'S input, not a
  // server fault — 400 with a fixable explanation, never a raw 500.
  if (e instanceof W9EncodingError) return res.status(400).json({ error: e.message, code: "W9_NAME_NOT_PRINTABLE", field: e.field });
  // Template/field drift is an OPERATOR fault: fail loudly rather than issuing
  // a blank-but-"valid" W-9. 503 = this deployment cannot produce a W-9 today.
  if (e instanceof W9TemplateError || e instanceof W9FieldError) {
    return res.status(503).json({ error: e.message, code: "W9_TEMPLATE_INVALID" });
  }
  if (e instanceof nacha.NachaError) {
    const body: any = { error: e.message, code: e.code };
    if (e.exceptions) body.exceptions = e.exceptions;
    return res.status(e.httpStatus).json(body);
  }
  const msg = e instanceof Error ? e.message : "Internal error";
  return res.status(500).json({ error: msg });
}

// ── ACH EXPORT KILL SWITCH ───────────────────────────────────────────────────
// GET /api/pay/nacha originates REAL MONEY MOVEMENT, and four blockers below it
// are still unfixed. Until every one of them is closed the export must be inert,
// so it is OFF unless the operator sets ACH_EXPORT_ENABLED="true" (read per
// request — no boot-time capture — so the flag can be flipped and audited
// without a code change).
//
// MUST BE FIXED BEFORE SETTING ACH_EXPORT_ENABLED=true:
//   1. NO PAYMENT LEDGER. Nothing records that a week was exported/settled, so
//      re-downloading the file (a retry, a second manager, a browser refresh)
//      re-pays the entire roster. Needs a durable "this statement was paid in
//      ACH file X" ledger that the builder excludes on the next run.
//   2. EFFECTIVE DATE IS DERIVED FROM THE PAY-PERIOD START. nachaService uses
//      nextBankingDay(weekStartUtc), which for any week already closed is a
//      date in the PAST — banks reject the file (or post it wrong). It must be
//      derived from the SUBMISSION date plus the ODFI's settlement lead time.
//   3. SERVICE CLASS 200 ON A CREDITS-ONLY BATCH. 200 declares "mixed debits
//      and credits"; this batch is credits only and must be class 220 in the
//      batch header, batch control, and the file control totals.
//   4. NO KEY VERSION IN THE CIPHERTEXT. payCrypto writes no key id, so
//      rotating PAY_CRYPTO_KEY silently makes every stored TIN and bank
//      account undecryptable — an unrecoverable loss of the pay roster. The
//      envelope needs a key version and a dual-key read path first.
//
// Do NOT "temporarily" flip this to ship a payroll run: every blocker above
// either loses money or loses the data needed to pay anyone again.
const ACH_EXPORT_DISABLED_MESSAGE =
  "The ACH/NACHA export is disabled in this deployment. It stays off until the payment ledger " +
  "(so a re-download cannot double-pay the roster), the submission-date effective date, the " +
  "credits-only service class, and key-versioned pay ciphertext are in place. Set " +
  "ACH_EXPORT_ENABLED=true only after that work ships.";

const requireAchExportEnabled: Mw = (_req, res, next) => {
  if (process.env.ACH_EXPORT_ENABLED !== "true") {
    return res.status(503).json({ error: ACH_EXPORT_DISABLED_MESSAGE, code: "ACH_EXPORT_DISABLED" });
  }
  next();
};

// Secrets-ready guard: without an encryption key the pay plane fails CLOSED
// (503) rather than writing anything unencrypted.
const requirePaySecrets: Mw = (_req, res, next) => {
  if (!paySecretsReady()) {
    return res.status(503).json({ error: "Pay profile storage is not configured (set PAY_CRYPTO_KEY).", code: "PAY_SECRETS_MISSING" });
  }
  next();
};

// ── Full-SSN document delivery ───────────────────────────────────────────────
// A filled W-9 shows the COMPLETE 9-digit SSN. It is never written to disk
// (see profile.renderStoredW9) — it is re-rendered from the encrypted TIN for
// the length of one response, delivered no-store, and ALWAYS audited.
async function sendW9Pdf(req: Request, res: Response, opts: {
  tenantId: number; actorId: number | null; scope: "self" | "admin";
  row: profile.W9Row | undefined; repId: number;
}) {
  const { row } = opts;
  if (!row || !row.consent) return res.status(404).json({ error: "W-9 PDF not found" });
  let pdf: Uint8Array;
  try { pdf = await profile.renderStoredW9(opts.tenantId, row); }
  catch (e) { return fail(res, e); }
  // Audit EVERY access to a full-TIN document. Masked identifiers only — the
  // audit row must never be a second place the number leaks.
  storage.logActivity(opts.actorId, "pay.w9.pdf.downloaded", "w9_form", row.id,
    { repId: opts.repId, scope: opts.scope, tinType: row.tin_type }, req.ip);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "no-store, private");
  res.setHeader("Content-Disposition", `inline; filename="w9-${row.rep_id}-${row.id}.pdf"`);
  res.send(Buffer.from(pdf));
}

// One-time cleanup for deployments that ran the pre-hardening code: it wrote
// ${DATA_DIR}/uploads/w9/<repId>.pdf — a plaintext, unreplicated, unencrypted
// copy of a full SSN, and each new submission silently overwrote the last.
// Nothing reads that directory any more (every W-9 is re-rendered from tin_enc
// on demand), so the files are pure liability. Scoped to exactly that folder
// and to *.pdf; never fatal.
export function purgeLegacyW9Pdfs(): number {
  const dir = path.join(process.env.DATA_DIR || process.cwd(), "uploads", "w9");
  let removed = 0;
  try {
    if (!fs.existsSync(dir)) return 0;
    for (const name of fs.readdirSync(dir)) {
      if (!name.toLowerCase().endsWith(".pdf")) continue;
      try { fs.unlinkSync(path.join(dir, name)); removed++; } catch { /* leave it */ }
    }
  } catch { /* unreadable dir — nothing to do */ }
  if (removed) console.warn(`[pay] purged ${removed} legacy plaintext W-9 PDF(s) from ${dir} (SSNs at rest, now rendered on demand)`);
  return removed;
}

const parseWeekRef = (v: any): string | undefined => {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const s = v.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00.000Z` : s;
};

export function registerPayRoutes(app: Express, deps: Deps) {
  const { requireAuth, requireCapability } = deps;
  purgeLegacyW9Pdfs();
  const uid = (req: Request) => (req as any).user?.id ?? null;
  const tid = (req: Request) => (req as any).user?.tenantId as number;
  const repIdOf = (req: Request) => (req as any).user?.teamMemberId as number | null;

  // Resolve a team member INSIDE the caller's tenant (cross-tenant → 404).
  const memberInTenant = (req: Request, id: number) =>
    (storage.getTeamMembers(tid(req)) as any[]).find(m => m.id === id) ?? null;

  // ══ REP SELF-SERVICE (own record only — repId always from the session) ════

  app.put("/api/me/bank", requireAuth, payWriteLimiter, requirePaySecrets, (req, res) => {
    const repId = repIdOf(req);
    if (!repId) return res.status(400).json({ error: "No rep profile linked to your login." });
    try {
      const out = profile.upsertBankDetails(tid(req), repId, {
        routing: req.body?.routing, account: req.body?.account, accountType: req.body?.accountType,
      });
      storage.logActivity(uid(req), "pay.bank.updated", "rep_bank_details", repId,
        { accountType: out.accountType, last4: out.last4 }, req.ip);
      res.json(out); // masked: last4 + type + status only
    } catch (e) { fail(res, e); }
  });

  app.get("/api/me/bank", requireAuth, (req, res) => {
    const repId = repIdOf(req);
    if (!repId) return res.status(400).json({ error: "No rep profile linked to your login." });
    try {
      const masked = profile.getBankMasked(tid(req), repId);
      if (!masked) return res.status(404).json({ error: "No bank details on file" });
      res.json(masked);
    } catch (e) { fail(res, e); }
  });

  app.post("/api/me/w9", requireAuth, payWriteLimiter, requirePaySecrets, async (req, res) => {
    const repId = repIdOf(req);
    if (!repId) return res.status(400).json({ error: "No rep profile linked to your login." });
    try {
      const parsed = validateW9Input(req.body || {});
      if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: "INVALID_W9" });
      const v = parsed.value;
      const company = profile.getCompanyProfileRow(tid(req));
      // Render FIRST: a form we cannot fill (unprintable name, template drift)
      // must never leave a consented row behind claiming the rep is W-9 complete.
      // The rendered bytes are then DISCARDED — never written to disk.
      const render = await renderW9Pdf({
        legalName: v.legalName, businessName: v.businessName, address: v.address,
        taxClassification: v.taxClassification, llcTaxClass: v.llcTaxClass,
        otherClassification: v.otherClassification, foreignPartners: v.foreignPartners,
        exemptPayeeCode: v.exemptPayeeCode, fatcaExemptionCode: v.fatcaExemptionCode,
        accountNumbers: v.accountNumbers,
        tin: v.tin, tinType: v.tinType, signatureName: v.signatureName,
        signatureDate: new Date(), requesterName: company?.legal_name,
        subjectToBackupWithholding: v.subjectToBackupWithholding,
      });
      const row = profile.saveW9(tid(req), repId, {
        ...v, consent: true, signatureIp: req.ip ?? null,
        signatureUa: String(req.headers["user-agent"] ?? "").slice(0, 500) || null,
        renderedNames: render.transliterated ? render.rendered : null,
      });
      storage.logActivity(uid(req), "pay.w9.submitted", "w9_form", row.id,
        { legalName: v.legalName, tinType: v.tinType, taxClassification: v.taxClassification,
          subjectToBackupWithholding: v.subjectToBackupWithholding,
          transliterated: render.transliterated }, req.ip);
      res.status(201).json(profile.getW9Status(tid(req), repId));
    } catch (e) { fail(res, e); }
  });

  app.get("/api/me/w9", requireAuth, (req, res) => {
    const repId = repIdOf(req);
    if (!repId) return res.status(400).json({ error: "No rep profile linked to your login." });
    try {
      const status = profile.getW9Status(tid(req), repId);
      if (!status) return res.status(404).json({ error: "No W-9 on file" });
      res.json(status);
    } catch (e) { fail(res, e); }
  });

  // A rep may always download their OWN W-9 — it is their document.
  app.get("/api/me/w9/pdf", requireAuth, requirePaySecrets, async (req, res) => {
    const repId = repIdOf(req);
    if (!repId) return res.status(400).json({ error: "No rep profile linked to your login." });
    await sendW9Pdf(req, res, {
      tenantId: tid(req), actorId: uid(req), scope: "self", repId,
      row: profile.getLatestW9(tid(req), repId),
    });
  });

  // ══ MANAGER / ADMIN OVERSIGHT — masked status only, never numbers ═════════

  app.get("/api/team-members/:id/bank", requireCapability("commission.read.all"), (req, res) => {
    const member = memberInTenant(req, Number(req.params.id));
    if (!member) return res.status(404).json({ error: "Not found" });
    try {
      const masked = profile.getBankMasked(tid(req), member.id);
      if (!masked) return res.status(404).json({ error: "No bank details on file" });
      res.json({ repId: member.id, repName: member.name, ...masked });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/team-members/:id/w9", requireCapability("commission.read.all"), (req, res) => {
    const member = memberInTenant(req, Number(req.params.id));
    if (!member) return res.status(404).json({ error: "Not found" });
    try {
      const status = profile.getW9Status(tid(req), member.id);
      if (!status) return res.status(404).json({ error: "No W-9 on file" });
      res.json({ repId: member.id, repName: member.name, ...status });
    } catch (e) { fail(res, e); }
  });

  // ══ FULL-SSN DOCUMENT — ADMIN ONLY ════════════════════════════════════════
  // The rendered W-9 carries the complete, unredacted 9-digit SSN, so it does
  // NOT belong to the manager oversight band above ("masked status only, never
  // numbers"). It is gated on payouts.pay — the same admin-only capability that
  // guards moving real money (shared/capabilities.ts: "a manager is
  // oversight/read; only the org owner may move real money"). Every hit is
  // audited by sendW9Pdf.
  app.get("/api/team-members/:id/w9/pdf", requireCapability("payouts.pay"), requirePaySecrets, async (req, res) => {
    const member = memberInTenant(req, Number(req.params.id));
    if (!member) return res.status(404).json({ error: "Not found" });
    await sendW9Pdf(req, res, {
      tenantId: tid(req), actorId: uid(req), scope: "admin", repId: member.id,
      row: profile.getLatestW9(tid(req), member.id),
    });
  });

  // ══ COMPANY (ODFI) PROFILE — admin writes, manager reads masked ═══════════

  app.put("/api/company-profile", requireCapability("settings.manage.org"), payWriteLimiter, requirePaySecrets, (req, res) => {
    try {
      profile.upsertCompanyProfile(tid(req), {
        legalName: req.body?.legalName, ein: req.body?.ein, dfiAccount: req.body?.dfiAccount,
        dfiRouting: req.body?.dfiRouting, companyId: req.body?.companyId,
      });
      storage.logActivity(uid(req), "pay.company_profile.updated", "company_profile", tid(req), {}, req.ip);
      res.json(profile.getCompanyProfileMasked(tid(req)));
    } catch (e) { fail(res, e); }
  });

  app.get("/api/company-profile", requireCapability("commission.read.all"), (req, res) => {
    try {
      const masked = profile.getCompanyProfileMasked(tid(req));
      if (!masked) return res.status(404).json({ error: "Company profile not configured" });
      res.json(masked);
    } catch (e) { fail(res, e); }
  });

  // ══ NACHA ACH EXPORT — BofA batch upload, PPD credits only ════════════════
  // Strict by default: if ANY approved-pay rep lacks active bank details or a
  // consented W-9 the whole export refuses with 409 + blocking exceptions
  // (NACHA files carry no comments/exceptions — the manager fixes the roster
  // first). ?allowPartial=1 pays the payable set and names the excluded reps
  // in the X-Nacha-Exceptions JSON header. ?fileIdModifier=B… regenerates the
  // same week under NACHA duplicate-file rules.
  //
  // DISABLED BY DEFAULT — see requireAchExportEnabled further up. The
  // code stays intact (and tested) so the remaining work is a fix, not a
  // rewrite; it simply cannot originate a real payment until the flag is set.

  app.get("/api/pay/nacha", requireCapability("commission.read.all"), requireAchExportEnabled, requirePaySecrets, (req, res) => {
    try {
      const weekReference = parseWeekRef(req.query.weekStart);
      if (!weekReference) return res.status(400).json({ error: "weekStart=YYYY-MM-DD is required" });
      const allowPartial = req.query.allowPartial === "1" || req.query.allowPartial === "true";
      const result = nacha.buildNachaFile({
        tenantId: tid(req), actorId: uid(req), weekReference,
        fileIdModifier: typeof req.query.fileIdModifier === "string" ? req.query.fileIdModifier : undefined,
      });
      if (result.exceptions.length && !allowPartial) {
        return res.status(409).json({
          error: `${result.exceptions.length} approved-pay rep(s) are missing bank details or a W-9 — fix the roster or retry with ?allowPartial=1.`,
          code: "PAY_ROSTER_INCOMPLETE",
          exceptions: result.exceptions,
        });
      }
      storage.logActivity(uid(req), "pay.nacha.generated", "company_profile", tid(req),
        { week: result.weekStartUtc.slice(0, 10), entryCount: result.entryCount, totalCents: result.totalCents,
          excluded: result.exceptions.map(e => e.repId) }, req.ip);
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="weekly-pay-${result.weekStartUtc.slice(0, 10)}.ach"`);
      if (result.exceptions.length) res.setHeader("X-Nacha-Exceptions", JSON.stringify(result.exceptions));
      res.setHeader("X-Nacha-Entry-Count", String(result.entryCount));
      res.setHeader("X-Nacha-Total-Cents", String(result.totalCents));
      res.send(result.fileContent);
    } catch (e) { fail(res, e); }
  });

  // ══ 1099-NEC READINESS SUMMARY (JSON only — the 1099 PDF is out of scope) ═

  app.get("/api/pay/1099-summary", requireCapability("commission.read.all"), (req, res) => {
    try {
      const year = req.query.year ? Number(req.query.year) : new Date().getUTCFullYear();
      res.json({ year, reps: nacha.get1099Summary(tid(req), year) });
    } catch (e) { fail(res, e); }
  });
}
