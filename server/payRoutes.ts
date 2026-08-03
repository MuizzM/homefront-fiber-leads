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
import { renderW9Pdf } from "./w9Pdf";
import * as nacha from "./nachaService";

type Mw = (req: Request, res: Response, next: NextFunction) => void;
interface Deps { requireAuth: Mw; requireCapability: (cap: any) => Mw; }

function fail(res: Response, e: unknown) {
  if (e instanceof profile.PayError) return res.status(e.httpStatus).json({ error: e.message, code: e.code });
  if (e instanceof nacha.NachaError) {
    const body: any = { error: e.message, code: e.code };
    if (e.exceptions) body.exceptions = e.exceptions;
    return res.status(e.httpStatus).json(body);
  }
  const msg = e instanceof Error ? e.message : "Internal error";
  return res.status(500).json({ error: msg });
}

// Secrets-ready guard: without an encryption key the pay plane fails CLOSED
// (503) rather than writing anything unencrypted.
const requirePaySecrets: Mw = (_req, res, next) => {
  if (!paySecretsReady()) {
    return res.status(503).json({ error: "Pay profile storage is not configured (set PAY_CRYPTO_KEY).", code: "PAY_SECRETS_MISSING" });
  }
  next();
};

function w9PdfDir(): string {
  const dir = path.join(process.env.DATA_DIR || process.cwd(), "uploads", "w9");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function streamW9Pdf(res: Response, row: profile.W9Row | undefined) {
  if (!row?.pdf_path) return res.status(404).json({ error: "W-9 PDF not found" });
  const abs = path.resolve(row.pdf_path);
  // The stored path must stay inside the w9 uploads dir — never trust a row to
  // point anywhere else (defense against a tampered DB row becoming an LFI).
  if (!abs.startsWith(path.resolve(w9PdfDir()) + path.sep) || !fs.existsSync(abs)) {
    return res.status(404).json({ error: "W-9 PDF not found" });
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="w9-${row.rep_id}.pdf"`);
  fs.createReadStream(abs).pipe(res);
}

const parseWeekRef = (v: any): string | undefined => {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const s = v.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00.000Z` : s;
};

export function registerPayRoutes(app: Express, deps: Deps) {
  const { requireAuth, requireCapability } = deps;
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
      const pdf = await renderW9Pdf({
        legalName: v.legalName, businessName: v.businessName, address: v.address,
        tin: v.tin, tinType: v.tinType, signatureName: v.signatureName,
        signatureDate: new Date(), requesterName: company?.legal_name,
      });
      const pdfPath = path.join(w9PdfDir(), `${repId}.pdf`);
      fs.writeFileSync(pdfPath, pdf, { mode: 0o600 });
      const row = profile.saveW9(tid(req), repId, {
        ...v, signatureIp: req.ip ?? null,
        signatureUa: String(req.headers["user-agent"] ?? "").slice(0, 500) || null,
        pdfPath,
      });
      storage.logActivity(uid(req), "pay.w9.submitted", "w9_form", row.id,
        { legalName: v.legalName, tinType: v.tinType }, req.ip);
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

  app.get("/api/me/w9/pdf", requireAuth, (req, res) => {
    const repId = repIdOf(req);
    if (!repId) return res.status(400).json({ error: "No rep profile linked to your login." });
    streamW9Pdf(res, profile.getLatestW9(tid(req), repId));
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

  app.get("/api/team-members/:id/w9/pdf", requireCapability("commission.read.all"), (req, res) => {
    const member = memberInTenant(req, Number(req.params.id));
    if (!member) return res.status(404).json({ error: "Not found" });
    streamW9Pdf(res, profile.getLatestW9(tid(req), member.id));
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

  app.get("/api/pay/nacha", requireCapability("commission.read.all"), requirePaySecrets, (req, res) => {
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
