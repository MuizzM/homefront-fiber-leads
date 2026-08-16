// ── Commission File - HTTP surface ───────────────────────────────────────────
//
// The same four rules vendorOrderRoutes.ts holds, held here:
// scope is server-side always, out of scope is 404, customer contact details
// never cross this boundary (this file carries none - names and money only),
// and nothing from the vendor crosses it either.
//
// The capability split mirrors the order-import screens on purpose:
// `order.import.manage` (admin) owns uploads and the raw file back;
// `order.match.resolve` (manager and up) owns the review queue. A commission
// file is the same class of provider evidence as an order report, handled by
// the same people, so it borrows those capabilities rather than minting a
// parallel pair for the identical trust decision.

import type { Express, Request, Response } from "express";
import multer from "multer";
import { rawDb } from "./db";
import { recordAdminAudit, auditContext } from "./adminAudit";
import * as store from "./commissionFileStore";
import { sha256Hex } from "./vendorOrderCrypto";
import { MAX_SOURCE_FILE_BYTES, readSourceFile, storeSourceFile } from "./vendorOrderFiles";
import { stageCommissionImportContent } from "./commissionFileImportWorker";
import { looksLikeXlsx } from "./xlsx";
import { commissionMatchIsPayable, matchCommissionLine } from "./commissionMatching";
import { ProviderError } from "./providers/perfectVisionSubmittedOrders";
import {
  COMMISSION_PROVIDER, COMMISSION_SOURCE_NAME, COMMISSION_SOURCE_URL,
  MAX_COMMISSION_IMPORT_ROWS, normalizeCommissionRow, parseCommissionReport,
} from "./providers/perfectVisionCommissionFile";
import { orderPayloadEncryptionReady } from "./vendorOrderStore";
import { COMMISSION_FILE_HEADERS } from "@shared/commissionSource";
import type { Capability } from "@shared/capabilities";

interface Deps {
  requireAuth: any;
  requireCapability: (cap: Capability) => any;
}

/** In memory, never to disk through multer - the same reasoning as the order
 *  upload: bytes are encrypted by this process before anything is written. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SOURCE_FILE_BYTES, files: 1, fields: 12 },
});

export function registerCommissionFileRoutes(app: Express, deps: Deps): void {
  const { requireAuth, requireCapability } = deps;
  const uid = (req: Request) => (req as any).user?.id ?? null;

  const tid = (req: Request): number | null => {
    const raw = (req as any).user?.tenantId;
    return Number.isSafeInteger(raw) && raw > 0 ? Number(raw) : null;
  };
  const requireOrg = (req: Request, res: Response): number | null => {
    const id = tid(req);
    if (id == null) {
      res.status(400).json({ error: "This view is scoped to one organization. Sign in as a member of one." });
      return null;
    }
    return id;
  };

  // ── Provider facts for the screen ──────────────────────────────────────────

  app.get("/api/commission-imports/providers", requireAuth, requireCapability("order.import.manage"),
    (_req: Request, res: Response) => {
      res.json({
        provider: COMMISSION_PROVIDER,
        reportName: COMMISSION_SOURCE_NAME,
        sourceUrl: COMMISSION_SOURCE_URL,
        expectedHeaders: Object.values(COMMISSION_FILE_HEADERS),
        encryptionReady: orderPayloadEncryptionReady(),
        maxRows: MAX_COMMISSION_IMPORT_ROWS,
        maxFileBytes: MAX_SOURCE_FILE_BYTES,
      });
    });

  /**
   * Inspect an upload WITHOUT importing it: header binding, category and
   * money totals, and the duplicate answer. What an admin reads before
   * deciding the export is the one they meant to run.
   */
  app.post("/api/commission-imports/preview", requireAuth, requireCapability("order.import.manage"),
    uploadOnce, (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file || !file.buffer?.length) return res.status(400).json({ error: "Choose a CSV or XLSX file to upload." });

      try {
        const parsed = parseCommissionReport({
          content: file.buffer,
          format: looksLikeXlsx(file.buffer.subarray(0, 8)) ? "xlsx" : "csv",
          maxRows: MAX_COMMISSION_IMPORT_ROWS,
        });
        const byCategory: Record<string, { rows: number; pendingCents: number; paidCents: number }> = {};
        let unparsableMoney = 0;
        for (const row of parsed.rows) {
          const line = normalizeCommissionRow({ organizationId, row, byField: parsed.byField });
          const bucket = byCategory[line.category] ??= { rows: 0, pendingCents: 0, paidCents: 0 };
          bucket.rows += 1;
          if (line.pendingAmountCents == null || line.paidAmountCents == null) unparsableMoney += 1;
          bucket.pendingCents += line.pendingAmountCents ?? 0;
          bucket.paidCents += line.paidAmountCents ?? 0;
        }
        const checksum = sha256Hex(file.buffer);
        res.json({
          columns: parsed.columns,
          rowCount: parsed.rows.length,
          skippedRows: parsed.skippedRows,
          checksum,
          byCategory,
          unparsableMoneyRows: unparsableMoney,
          duplicateOf: store.findCommissionImportByChecksum(organizationId, checksum)?.id ?? null,
        });
      } catch (e: any) {
        res.status(400).json({ error: safeMessage(e) });
      }
    });

  // ── Import ─────────────────────────────────────────────────────────────────

  app.post("/api/commission-imports", requireAuth, requireCapability("order.import.manage"),
    uploadOnce, (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file || !file.buffer?.length) return res.status(400).json({ error: "Choose a CSV or XLSX file to upload." });

      const checksum = sha256Hex(file.buffer);
      const duplicate = store.findCommissionImportByChecksum(organizationId, checksum);
      if (duplicate && req.body?.allowDuplicate !== "true") {
        return res.status(409).json({
          error: `This exact file was already imported on ${String(duplicate.created_at).slice(0, 10)}.`,
          importId: duplicate.id,
        });
      }

      let parsed;
      try {
        parsed = parseCommissionReport({
          content: file.buffer,
          format: looksLikeXlsx(file.buffer.subarray(0, 8)) ? "xlsx" : "csv",
          maxRows: MAX_COMMISSION_IMPORT_ROWS,
        });
      } catch (e: any) {
        return res.status(400).json({ error: safeMessage(e) });
      }
      if (parsed.rows.length === 0) return res.status(400).json({ error: "This file has no data rows." });

      const storageKey = storeSourceFile(organizationId, checksum, file.buffer);
      const importId = store.createCommissionImport({
        tenantId: organizationId,
        importMode: "manual_upload",
        reportPeriodStart: req.body?.periodStart ? String(req.body.periodStart).slice(0, 10) : null,
        reportPeriodEnd: req.body?.periodEnd ? String(req.body.periodEnd).slice(0, 10) : null,
        sourceFileName: String(file.originalname ?? "commission-file").slice(0, 200),
        sourceFileChecksum: checksum,
        sourceFileStorageKey: storageKey,
        importedByUserId: uid(req),
        totalRows: parsed.rows.length,
      });
      if (!storageKey && !stageCommissionImportContent(importId, file.buffer)) {
        store.setCommissionImportStatus(importId, "failed", "The server is busy processing other imports. Try again in a minute.");
        return res.status(503).json({ error: "The server is busy processing other imports. Try again in a minute." });
      }

      recordAdminAudit({
        ...auditContext(req), action: "commission_import.uploaded",
        targetType: "commission_file_import", targetId: String(importId),
        after: { rows: parsed.rows.length, fileName: String(file.originalname ?? "").slice(0, 120), checksum },
      });

      // 202: the worker owns it from here, same as an order import.
      res.status(202).json({ importId, totalRows: parsed.rows.length, status: "pending" });
    });

  app.get("/api/commission-imports", requireAuth, requireCapability("order.import.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      res.json({ imports: store.listCommissionImports(organizationId, num(req.query.limit, 50)) });
    });

  // ── Review queue ───────────────────────────────────────────────────────────
  // Registered before /:id so the literal path is never read as an id.

  app.get("/api/commission-imports/exceptions/list", requireAuth, requireCapability("order.match.resolve"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      res.json({ exceptions: store.listReviewLines(organizationId, num(req.query.limit, 100)).map(publicLine) });
    });

  /** Re-run the matcher for one line, for after an account number reached a
   *  sale by another route. */
  app.post("/api/commission-imports/exceptions/:id/rematch", requireAuth, requireCapability("order.match.resolve"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const line = store.getLine(Number(req.params.id), organizationId);
      if (!line) return res.status(404).json({ error: "Not found" });

      const verdict = matchCommissionLine(organizationId, store.lineRowToNormalized(line));
      store.setLineMatch(line.id, verdict);
      if (commissionMatchIsPayable(verdict)) {
        const refreshed = store.getLine(line.id, organizationId);
        if (refreshed) store.applyLineMoney(organizationId, refreshed);
      }
      res.json({ ok: true, match: { status: verdict.status, confidence: verdict.confidence, candidates: verdict.candidates } });
    });

  /**
   * A human decides. The only path by which a name-and-dates suggestion ever
   * becomes attached money, and the write that makes the NEXT file match by
   * itself: the confirmation stamps the account number onto the sale and the
   * vendor order, then sweeps the account's other lines through the matcher
   * so one decision settles the whole account, not one product line of it.
   */
  app.post("/api/commission-imports/exceptions/:id/resolve", requireAuth, requireCapability("order.match.resolve"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const line = store.getLine(Number(req.params.id), organizationId);
      if (!line) return res.status(404).json({ error: "Not found" });

      const decision = String(req.body?.decision ?? "");
      if (decision === "ignore") {
        store.setLineMatch(line.id, {
          status: "ignored", rule: "manual", confidence: 0,
          saleId: null, vendorOrderId: null, repId: null, leadId: null,
          exceptionReason: String(req.body?.note ?? "Marked as not ours by an administrator.").slice(0, 300),
          candidates: [],
        });
        recordAdminAudit({
          ...auditContext(req), action: "commission_import.exception.ignored",
          targetType: "commission_file_line", targetId: String(line.id),
          after: { note: String(req.body?.note ?? "").slice(0, 200) },
        });
        return res.json({ ok: true });
      }

      const saleId = Number(req.body?.saleId);
      if (!Number.isSafeInteger(saleId) || saleId <= 0) {
        return res.status(400).json({ error: "Pick the sale this commission line pays for." });
      }
      const sale = rawDb.prepare(
        `SELECT id, tenant_id, rep_id, lead_id FROM commission_sales WHERE id = ?`,
      ).get(saleId) as any;
      if (!sale || sale.tenant_id !== organizationId) return res.status(404).json({ error: "Not found" });

      const vendorOrderId = resolveVendorOrderId(organizationId, saleId, line.account_key);
      store.stampAccountNumber({
        tenantId: organizationId, saleId, vendorOrderId,
        accountNumber: line.account_number ?? null, accountKey: line.account_key ?? null,
      });
      // A human confirmation is a full-confidence match; same rule as the
      // order plane's exception queue.
      store.setLineMatch(line.id, {
        status: "matched", rule: "manual", confidence: 1,
        saleId, vendorOrderId, repId: sale.rep_id ?? null, leadId: sale.lead_id ?? null,
        exceptionReason: null, candidates: [],
      });
      const refreshed = store.getLine(line.id, organizationId);
      const money = refreshed ? store.applyLineMoney(organizationId, refreshed) : null;

      const swept = sweepAccountSiblings(organizationId, line);

      recordAdminAudit({
        ...auditContext(req), action: "commission_import.exception.resolved",
        targetType: "commission_file_line", targetId: String(line.id),
        after: {
          saleId, vendorOrderId, amountCents: money?.amountCents ?? null,
          linkStatus: money?.status ?? null, sweptLines: swept,
        },
      });
      res.json({ ok: true, linkStatus: money?.status ?? null, amountCents: money?.amountCents ?? null, sweptLines: swept });
    });

  app.get("/api/commission-imports/:id", requireAuth, requireCapability("order.import.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const row = store.getCommissionImport(Number(req.params.id), organizationId);
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json({ import: row });
    });

  /** The raw file back: the unredacted ledger, admin capability only, audited
   *  every time, no-store. Same posture as the order plane's download. */
  app.get("/api/commission-imports/:id/file", requireAuth, requireCapability("order.import.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const row = store.getCommissionImport(Number(req.params.id), organizationId);
      if (!row) return res.status(404).json({ error: "Not found" });
      const content = readSourceFile(row.source_file_storage_key);
      if (!content) {
        return res.status(404).json({ error: "The original file was not retained for this import." });
      }
      recordAdminAudit({
        ...auditContext(req), action: "commission_import.file.downloaded",
        targetType: "commission_file_import", targetId: String(row.id),
        after: { fileName: row.source_file_name },
      });
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", `attachment; filename="${sanitizeFilename(row.source_file_name)}"`);
      res.end(content);
    });
}

// ── Resolution helpers ───────────────────────────────────────────────────────

/** Where a confirmed line's money can land: the order already linked to the
 *  sale, else the order carrying the account key. Null when the order plane
 *  has never seen this order - the link then waits on its external keys. */
function resolveVendorOrderId(tenantId: number, saleId: number, accountKey: unknown): number | null {
  const bySale = rawDb.prepare(`
    SELECT id FROM vendor_orders WHERE tenant_id = ? AND sale_id = ? ORDER BY id DESC LIMIT 1
  `).get(tenantId, saleId) as any;
  if (bySale) return Number(bySale.id);
  if (accountKey) {
    const byAccount = rawDb.prepare(`
      SELECT id FROM vendor_orders WHERE tenant_id = ? AND account_key = ? ORDER BY id DESC LIMIT 1
    `).get(tenantId, String(accountKey)) as any;
    if (byAccount) return Number(byAccount.id);
  }
  return null;
}

/** Re-match every other line on the confirmed account. They hit the account
 *  rung now that the stamp exists, so the fiber plan, the security add-on and
 *  the tech-support line settle on one human decision. Returns how many. */
function sweepAccountSiblings(tenantId: number, resolvedLine: any): number {
  if (!resolvedLine.account_key) return 0;
  let swept = 0;
  for (const sibling of store.listLinesByAccountKey(tenantId, String(resolvedLine.account_key))) {
    if (sibling.id === resolvedLine.id) continue;
    if (sibling.match_status === "matched" || sibling.match_status === "ignored") continue;
    const verdict = matchCommissionLine(tenantId, store.lineRowToNormalized(sibling));
    store.setLineMatch(sibling.id, verdict);
    if (commissionMatchIsPayable(verdict)) {
      const fresh = store.getLine(sibling.id, tenantId);
      if (fresh) store.applyLineMoney(tenantId, fresh);
      swept += 1;
    }
  }
  return swept;
}

// ── Response shaping and small helpers ───────────────────────────────────────

function publicLine(row: any) {
  return {
    id: row.id,
    lineKey: row.line_key,
    accountNumber: row.account_number,
    documentNumber: row.document_number,
    product: row.product,
    productFamily: row.product_family,
    category: row.category,
    lineStatus: row.line_status,
    program: row.program,
    customerName: row.customer_name,
    salesAgentName: row.sales_agent_name,
    firstChargeback: row.first_chargeback === 1,
    pendingAmountCents: row.pending_amount_cents,
    paidAmountCents: row.paid_amount_cents,
    actDeactDate: row.act_deact_date,
    uploadDate: row.upload_date,
    paymentDate: row.payment_date,
    matchStatus: row.match_status,
    matchRule: row.match_rule,
    confidence: row.match_confidence_score,
    exceptionReason: row.exception_reason,
    candidates: parseJson(row.match_candidates_json) ?? [],
    matchedSaleId: row.matched_sale_id,
    matchedVendorOrderId: row.matched_vendor_order_id,
    sourceFileName: row.source_file_name ?? null,
    importCreatedAt: row.import_created_at ?? null,
  };
}

function uploadOnce(req: Request, res: Response, next: any) {
  upload.single("file")(req, res, (err: any) => {
    if (!err) return next();
    const tooBig = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE";
    return res.status(400).json({
      error: tooBig
        ? `That file is larger than ${Math.round(MAX_SOURCE_FILE_BYTES / (1024 * 1024))} MB. Narrow the date range.`
        : "That upload could not be read.",
    });
  });
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseJson(value: unknown): any {
  if (value == null) return null;
  try { return JSON.parse(String(value)); } catch { return null; }
}

function sanitizeFilename(name: unknown): string {
  return String(name ?? "commission-file").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "commission-file";
}

function safeMessage(e: unknown): string {
  if (e instanceof ProviderError) return e.safeMessage;
  if (e && typeof e === "object" && "name" in e && (e as any).name === "XlsxError") return String((e as any).message);
  return "That file could not be read. Export the Commission File page again as CSV.";
}
