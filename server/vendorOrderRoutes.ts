// ── Provider orders and recovery - HTTP surface ──────────────────────────────
//
// Four rules hold across every route here.
//
// SCOPE IS SERVER-SIDE, ALWAYS. No endpoint accepts a rep id, team filter or
// tenant id and trusts it. The caller's scope comes from their own roster seat
// (liveOpsScope, the same resolver the live map uses), and a client-supplied
// filter can only NARROW that set, never widen it.
//
// OUT OF SCOPE IS 404. Not 403 - a 403 confirms the row exists, which is itself
// a disclosure. Same convention as mileageRoutes and liveOpsRoutes.
//
// CUSTOMER CONTACT DETAILS NEVER CROSS THIS BOUNDARY. Every response carries
// masked phones and emails. The real values exist only inside an encrypted
// import-row payload and are decrypted only inside the send path, which never
// returns them.
//
// NOTHING FROM THE VENDOR CROSSES IT EITHER. No provider HTML, headers,
// cookies, tokens or credentials appear in any response, in any error, or in
// any log line this file writes. The raw uploaded file is downloadable by one
// capability and one only, and the download is audited.

import express, { type Express, type Request, type Response } from "express";
import crypto from "node:crypto";
import multer from "multer";
import { storage } from "./storage";
import { rawDb } from "./db";
import { recordAdminAudit, auditContext } from "./adminAudit";
import { liveOpsScope, type ScopeMember } from "./liveOpsScope";
import * as store from "./vendorOrderStore";
import { sha256Hex } from "./vendorOrderCrypto";
import { MAX_SOURCE_FILE_BYTES, readSourceFile, storeSourceFile } from "./vendorOrderFiles";
import { stageImportContent } from "./vendorOrderImportWorker";
import { looksLikeXlsx } from "./xlsx";
import { matchVendorOrder } from "./orderMatching";
import { evaluateOneOrder, evaluateTenantRecovery, orderFunnel } from "./orderRecoveryEngine";
import {
  MAX_IMPORT_ROWS, ProviderError, SCHEDULED_DELIVERY_PATH, SOURCE_REPORT_NAME, SOURCE_REPORT_URL,
  getOrderStatusProvider, listOrderStatusProviders, orderSyncEnabled, recoveryMessagingEnabled,
  scheduledDeliveryConfigured,
} from "./providers/perfectVisionSubmittedOrders";
import {
  approveTemplateChecked, buildDraft, handleInboundSms, processUnsubscribe, sendOutreach,
} from "./orderRecoveryMessaging";
import {
  DEFAULT_REPORT_TIMEZONE, ORDER_STATUSES, emptyOrderColumnMapping, redactConnection,
  type OrderColumnMapping,
} from "@shared/orderStatusSource";
import { MAPPING_SAMPLE_ROWS, suggestOrderMapping, validateOrderColumnMapping } from "@shared/orderColumnMapping";
import {
  DEFAULT_RECOVERY_POLICY, RECOVERY_CASE_STATUSES, RECOVERY_PRIORITIES, RESOLUTION_CODES,
  isRecoveredResolution, resolveRecoveryPolicy,
} from "@shared/orderRecovery";
import { SEED_TEMPLATES, TEMPLATE_KINDS, validateTemplate } from "@shared/orderRecoveryTemplates";
import { CONTACT_CHANNELS, CONSENT_BASES, CONSENT_SOURCES, maskName, normalizeEmail, normalizePhoneE164 } from "@shared/contactConsent";
import { can, type Capability } from "@shared/capabilities";

interface Deps {
  requireAuth: any;
  requireCapability: (cap: Capability) => any;
}

/** In memory, never to disk through multer: the file is encrypted by this
 *  process before anything is written, so it must not first land unencrypted
 *  in an OS temp directory. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SOURCE_FILE_BYTES, files: 1, fields: 12 },
});

export function registerVendorOrderRoutes(app: Express, deps: Deps): void {
  const { requireAuth, requireCapability } = deps;
  const uid = (req: Request) => (req as any).user?.id ?? null;
  const actor = (req: Request) => (req as any).user ?? null;

  /**
   * The organization. Deliberately NOT nullable-on-purpose like the live-map
   * routes: this plane has no cross-tenant read at all, so a super admin
   * without an org context gets 400 rather than every dealer's orders.
   */
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

  const roster = (organizationId: number): ScopeMember[] =>
    (storage.getTeamMembers(organizationId) as any[]).map((m) => ({
      id: Number(m.id),
      role: String(m.role ?? "rep"),
      reportsToId: m.reportsToId == null ? null : Number(m.reportsToId),
      active: m.active !== false && Number(m.active ?? 1) !== 0,
    }));

  /**
   * Which reps this caller may see.
   *
   * `order.read.org` (manager and up) lifts the restriction entirely. Everyone
   * else gets the roster-derived scope, which for a rep is themselves.
   */
  const scopeOf = (req: Request, organizationId: number): number[] | null => {
    const user = actor(req);
    if (hasCap(user, "order.read.org") || hasCap(user, "recovery.read.org")) return null;
    return liveOpsScope(user, roster(organizationId));
  };

  const hasCap = (user: any, cap: Capability): boolean => can(user?.role, cap);

  // ── Provider catalogue and feature state ───────────────────────────────────

  app.get("/api/order-imports/providers", requireAuth, requireCapability("order.import.manage"),
    (_req: Request, res: Response) => {
      res.json({
        providers: listOrderStatusProviders(),
        reportName: SOURCE_REPORT_NAME,
        sourceUrl: SOURCE_REPORT_URL,
        // The flags an admin needs to see on the screen, so "why is the
        // sync button greyed out" never needs a support ticket.
        flags: {
          orderSyncEnabled: orderSyncEnabled(),
          recoveryMessagingEnabled: recoveryMessagingEnabled(),
          scheduledDeliveryConfigured: scheduledDeliveryConfigured(),
        },
        scheduledDeliveryPath: SCHEDULED_DELIVERY_PATH,
        encryptionReady: store.orderPayloadEncryptionReady(),
        maxRows: MAX_IMPORT_ROWS,
        maxFileBytes: MAX_SOURCE_FILE_BYTES,
      });
    });

  app.get("/api/order-imports/connection", requireAuth, requireCapability("order.import.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const row = store.getConnection(organizationId);
      if (!row) {
        return res.json({
          connection: null,
          defaults: { label: SOURCE_REPORT_NAME, sourceUrl: SOURCE_REPORT_URL, mode: "manual_upload" },
        });
      }
      res.json({
        connection: redactConnection({
          id: row.id, organizationId, provider: row.provider, label: row.label,
          sourceUrl: row.source_url, mode: row.mode, encryptedCredentials: row.encrypted_credentials,
          enabled: !!row.enabled,
        }),
        lastTest: { at: row.last_test_at, ok: row.last_test_ok === 1, message: row.last_test_message },
      });
    });

  app.put("/api/order-imports/connection", requireAuth, requireCapability("order.import.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const body = req.body ?? {};
      const mode = ["manual_upload", "scheduled_export", "sftp", "api"].includes(String(body.mode))
        ? String(body.mode) : "manual_upload";
      // Turning on an automated mode is a claim that PerfectVision authorized
      // it. The route records the claim; the provider still refuses to fetch,
      // so the claim alone cannot start a retrieval.
      store.upsertConnection({
        tenantId: organizationId,
        label: String(body.label ?? SOURCE_REPORT_NAME).slice(0, 120),
        sourceUrl: body.sourceUrl ? String(body.sourceUrl).slice(0, 500) : SOURCE_REPORT_URL,
        mode,
        enabled: Boolean(body.enabled),
      });
      recordAdminAudit({
        ...auditContext(req), action: "order_import.connection.updated",
        targetType: "vendor_order_connection", targetId: String(organizationId),
        after: { mode, enabled: Boolean(body.enabled) },
      });
      res.json({ ok: true });
    });

  app.post("/api/order-imports/connection/test", requireAuth, requireCapability("order.import.manage"),
    async (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const row = store.getConnection(organizationId);
      const provider = getOrderStatusProvider("perfectvision_submitted_orders");
      const result = await provider.testConnection({
        id: row?.id ?? 0, organizationId, provider: "perfectvision_submitted_orders",
        label: row?.label ?? SOURCE_REPORT_NAME, sourceUrl: row?.source_url ?? null,
        mode: (row?.mode ?? "manual_upload") as any,
        encryptedCredentials: row?.encrypted_credentials ?? null, enabled: !!row?.enabled,
      });
      if (row) store.recordConnectionTest(organizationId, "perfectvision_submitted_orders", result.ok, result.message);
      res.json(result);
    });

  // ── Mapping ────────────────────────────────────────────────────────────────

  app.get("/api/order-imports/mapping", requireAuth, requireCapability("order.import.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const saved = store.getActiveMapping(organizationId);
      const config = store.getOrgRecoveryConfig(organizationId);
      res.json({
        mapping: saved?.mapping ?? emptyOrderColumnMapping(config.reportTimezone),
        version: saved?.version ?? 0,
        savedAt: saved?.createdAt ?? null,
        statuses: ORDER_STATUSES,
      });
    });

  /**
   * Inspect an upload WITHOUT importing it.
   *
   * Returns the source columns, a suggested mapping, a masked sample, and the
   * validation verdict. This is the whole point of the two-step flow: an admin
   * sees what the file will become before a single row is written.
   */
  app.post("/api/order-imports/preview", requireAuth, requireCapability("order.import.manage"),
    uploadOnce, async (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file || !file.buffer?.length) return res.status(400).json({ error: "Choose a CSV or XLSX file to upload." });

      try {
        const parsed = await parseUpload(file);
        const config = store.getOrgRecoveryConfig(organizationId);
        const saved = store.getActiveMapping(organizationId);
        const mapping: OrderColumnMapping = normalizeMapping(
          req.body?.mapping ? safeJson(req.body.mapping) : saved?.mapping,
          parsed.columns,
          config.reportTimezone,
        ) ?? { ...emptyOrderColumnMapping(config.reportTimezone), columns: suggestOrderMapping(parsed.columns) };

        const validation = validateOrderColumnMapping(mapping, parsed.rows, organizationId, sha256Hex);
        res.json({
          columns: parsed.columns,
          rowCount: parsed.rows.length,
          skippedRows: parsed.skippedRows,
          truncated: parsed.truncated,
          checksum: sha256Hex(file.buffer),
          suggested: suggestOrderMapping(parsed.columns),
          mapping,
          validation: {
            ok: validation.ok,
            issues: validation.issues,
            statusPreview: validation.statusPreview,
            // MASKED. A preview is a mapping check, not an excuse to render 25
            // customers' names, addresses, phones and emails into a browser.
            sample: validation.sampleNormalized.slice(0, 10).map(maskedPreviewRow),
          },
          // Sample rows are shown with their VALUES only for non-contact
          // columns, so an admin can still recognise their own report.
          sampleRows: parsed.rows.slice(0, 5).map((row) => maskSampleRow(row, mapping)),
          duplicateOf: store.findImportByChecksum(organizationId, sha256Hex(file.buffer))?.id ?? null,
        });
      } catch (e: any) {
        res.status(400).json({ error: safeProviderMessage(e) });
      }
    });

  app.put("/api/order-imports/mapping", requireAuth, requireCapability("order.import.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const config = store.getOrgRecoveryConfig(organizationId);
      const mapping = normalizeMapping(req.body?.mapping, null, config.reportTimezone);
      if (!mapping) return res.status(400).json({ error: "The mapping could not be read." });

      // Validated against the sample the client just previewed, when it sends
      // one. Without a sample the structural rules still apply - a mapping with
      // no identity field is refused whether or not anyone looked at a file.
      const sample = Array.isArray(req.body?.sampleRows) ? req.body.sampleRows.slice(0, MAPPING_SAMPLE_ROWS) : [];
      const validation = validateOrderColumnMapping(mapping, sample, organizationId, sha256Hex);
      if (!validation.ok) {
        return res.status(400).json({ error: "This mapping cannot be saved yet.", issues: validation.issues });
      }

      const saved = store.saveMapping(organizationId, mapping, uid(req));
      recordAdminAudit({
        ...auditContext(req), action: "order_import.mapping.saved",
        targetType: "vendor_order_mapping", targetId: String(saved.id),
        after: { version: saved.version, fields: Object.keys(mapping.columns) },
      });
      res.json({ ok: true, version: saved.version });
    });

  // ── Import ─────────────────────────────────────────────────────────────────

  app.post("/api/order-imports", requireAuth, requireCapability("order.import.manage"),
    uploadOnce, async (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file || !file.buffer?.length) return res.status(400).json({ error: "Choose a CSV or XLSX file to upload." });

      const mapping = store.getActiveMapping(organizationId);
      if (!mapping) {
        return res.status(400).json({ error: "Save a column mapping before importing." });
      }

      const checksum = sha256Hex(file.buffer);
      const duplicate = store.findImportByChecksum(organizationId, checksum);
      if (duplicate && req.body?.allowDuplicate !== "true") {
        return res.status(409).json({
          error: `This exact file was already imported on ${String(duplicate.created_at).slice(0, 10)}.`,
          importId: duplicate.id,
        });
      }

      let parsed;
      try {
        parsed = await parseUpload(file);
      } catch (e: any) {
        return res.status(400).json({ error: safeProviderMessage(e) });
      }
      if (parsed.rows.length === 0) return res.status(400).json({ error: "This file has no data rows." });

      const storageKey = storeSourceFile(organizationId, checksum, file.buffer);
      const importId = store.createImport({
        tenantId: organizationId,
        sourceUrl: store.getConnection(organizationId)?.source_url ?? SOURCE_REPORT_URL,
        importMode: "manual_upload",
        reportPeriodStart: req.body?.periodStart ? String(req.body.periodStart).slice(0, 10) : null,
        reportPeriodEnd: req.body?.periodEnd ? String(req.body.periodEnd).slice(0, 10) : null,
        sourceFileName: String(file.originalname ?? "report").slice(0, 200),
        sourceFileChecksum: checksum,
        sourceFileStorageKey: storageKey,
        mappingVersion: mapping.version,
        importedByUserId: uid(req),
        totalRows: parsed.rows.length,
      });

      // With no encryption key the file was not written to disk, so the bytes
      // are handed to the worker in memory. If that queue is full the import is
      // refused rather than accepted and silently lost.
      if (!storageKey && !stageImportContent(importId, file.buffer)) {
        store.setImportStatus(importId, "failed", "The server is busy processing other imports. Try again in a minute.");
        return res.status(503).json({ error: "The server is busy processing other imports. Try again in a minute." });
      }

      recordAdminAudit({
        ...auditContext(req), action: "order_import.uploaded",
        targetType: "vendor_order_import", targetId: String(importId),
        after: { rows: parsed.rows.length, fileName: String(file.originalname ?? "").slice(0, 120), checksum },
      });

      // 202: accepted, not done. The worker owns it from here, which is what
      // keeps a 40,000-row file off the request thread.
      res.status(202).json({ importId, totalRows: parsed.rows.length, status: "pending" });
    });

  /**
   * Scheduled report delivery - the automated path, as a PUSH.
   *
   * UNAUTHENTICATED by necessity - a report subscription bridge posts here on
   * a schedule, not a person - so like the inbound SMS webhook it is
   * shared-secret gated and answers 404 until the secret exists. It can only
   * ever do what a manual upload by an admin could: queue a file for the
   * import worker under the org's own saved mapping. It reads nothing back,
   * and it cannot touch a mapping, a connection, or another org.
   *
   * Three server-side switches all have to agree before a byte is accepted:
   * ORDER_REPORT_DELIVERY_SECRET authenticates the deliverer, and the sync
   * flag plus an ENABLED scheduled_export connection record that PerfectVision
   * authorized the delivery for this dealer. The org an import lands in comes
   * from that connection state, never from the request.
   *
   * The body is the report file itself, raw bytes. Not multipart and not
   * MIME: whatever receives the subscription email extracts the attachment
   * and posts it, so a vendor email's structure never becomes this process's
   * parsing problem.
   */
  app.post(SCHEDULED_DELIVERY_PATH, rawReportBodyOnce, async (req: Request, res: Response) => {
    const presented = String(req.headers["x-webhook-secret"] ?? "");
    const secret = process.env.ORDER_REPORT_DELIVERY_SECRET ?? "";
    if (!scheduledDeliveryConfigured() || !timingSafeEqualStr(secret, presented)) {
      return res.status(404).json({ error: "Not found" });
    }
    if (!orderSyncEnabled()) {
      return res.status(403).json({ error: "Automated order sync is disabled on this server." });
    }

    const accepting = store.listEnabledScheduledConnections();
    if (accepting.length === 0) {
      return res.status(403).json({ error: "No organization has an enabled scheduled report delivery." });
    }
    let organizationId: number;
    if (accepting.length === 1) {
      organizationId = Number(accepting[0].tenant_id);
    } else {
      const wanted = Number(req.headers["x-organization-id"]);
      if (!accepting.some((c) => Number(c.tenant_id) === wanted)) {
        return res.status(400).json({
          error: "More than one organization accepts scheduled deliveries. Send x-organization-id naming one of them.",
        });
      }
      organizationId = wanted;
    }

    const mapping = store.getActiveMapping(organizationId);
    if (!mapping) {
      return res.status(409).json({ error: "No saved column mapping. Run one import manually first; saving the mapping there is what teaches this endpoint how to read the report." });
    }

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: "Send the report file as the raw request body (text/csv or application/octet-stream)." });
    }

    const checksum = sha256Hex(body);
    const duplicate = store.findImportByChecksum(organizationId, checksum);
    if (duplicate) {
      // A subscription re-delivering an unchanged report is a normal day, and
      // a machine cannot answer a confirm dialog. Idempotent success, naming
      // the earlier import so the deliverer's log tells the whole story.
      return res.json({ ok: true, duplicate: true, importId: duplicate.id });
    }

    const fileName = sanitizeFilename(req.headers["x-report-filename"] ?? "scheduled-report.csv");
    let parsed;
    try {
      parsed = await parseUpload({ buffer: body, originalname: fileName });
    } catch (e: any) {
      return res.status(400).json({ error: safeProviderMessage(e) });
    }
    if (parsed.rows.length === 0) return res.status(400).json({ error: "This file has no data rows." });

    const storageKey = storeSourceFile(organizationId, checksum, body);
    const importId = store.createImport({
      tenantId: organizationId,
      sourceUrl: store.getConnection(organizationId)?.source_url ?? SOURCE_REPORT_URL,
      importMode: "scheduled_export",
      reportPeriodStart: null,
      reportPeriodEnd: null,
      sourceFileName: fileName,
      sourceFileChecksum: checksum,
      sourceFileStorageKey: storageKey,
      mappingVersion: mapping.version,
      importedByUserId: null,
      totalRows: parsed.rows.length,
    });
    if (!storageKey && !stageImportContent(importId, body)) {
      store.setImportStatus(importId, "failed", "The server is busy processing other imports. Try again in a minute.");
      return res.status(503).json({ error: "The server is busy processing other imports. Try again in a minute." });
    }

    recordAdminAudit({
      ...auditContext(req),
      tenantId: organizationId,
      action: "order_import.scheduled_delivery.received",
      targetType: "vendor_order_import", targetId: String(importId),
      after: { rows: parsed.rows.length, fileName, checksum },
    });

    res.status(202).json({ importId, totalRows: parsed.rows.length, status: "pending" });
  });

  app.get("/api/order-imports", requireAuth, requireCapability("order.import.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      res.json({ imports: store.listImports(organizationId, num(req.query.limit, 50)) });
    });

  app.get("/api/order-imports/:id", requireAuth, requireCapability("order.import.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const row = store.getImport(Number(req.params.id), organizationId);
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json({ import: row });
    });

  /**
   * The raw file back.
   *
   * The single most sensitive read in this plane: it is the unredacted customer
   * list. Gated on the import capability, audited every time with the actor and
   * the file, and served as an attachment with no-store so it cannot end up in
   * a shared browser cache.
   */
  app.get("/api/order-imports/:id/file", requireAuth, requireCapability("order.import.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const row = store.getImport(Number(req.params.id), organizationId);
      if (!row) return res.status(404).json({ error: "Not found" });
      const content = readSourceFile(row.source_file_storage_key);
      if (!content) {
        return res.status(404).json({ error: "The original file was not retained for this import." });
      }
      recordAdminAudit({
        ...auditContext(req), action: "order_import.file.downloaded",
        targetType: "vendor_order_import", targetId: String(row.id),
        after: { fileName: row.source_file_name },
      });
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Disposition", `attachment; filename="${sanitizeFilename(row.source_file_name)}"`);
      res.end(content);
    });

  // ── Match exceptions ───────────────────────────────────────────────────────

  app.get("/api/order-imports/exceptions/list", requireAuth, requireCapability("order.match.resolve"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const rows = store.listMatchExceptions(organizationId, num(req.query.limit, 100));
      res.json({
        exceptions: rows.map((r) => ({
          id: r.id,
          importId: r.vendor_order_import_id,
          sourceFileName: r.source_file_name,
          sourceRowNumber: r.source_row_number,
          externalOrderId: r.external_order_id,
          externalTransactionId: r.external_transaction_id,
          carrier: r.carrier,
          program: r.program,
          productSold: r.product_sold,
          repExternalName: r.rep_external_name,
          serviceAddress: r.normalized_service_address,
          status: r.normalized_status,
          sourceStatus: r.source_status,
          matchStatus: r.match_status,
          confidence: r.match_confidence_score,
          exceptionReason: r.exception_reason,
          vendorOrderId: r.vendor_order_id,
        })),
      });
    });

  /** Re-run the matcher for one exception, after a sale gained an order id. */
  app.post("/api/order-imports/exceptions/:id/rematch", requireAuth, requireCapability("order.match.resolve"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const row = store.getImportRow(Number(req.params.id), organizationId);
      if (!row) return res.status(404).json({ error: "Not found" });
      const order = row.vendor_order_id ? store.getOrder(Number(row.vendor_order_id), organizationId) : null;
      if (!order) return res.status(404).json({ error: "Not found" });

      const result = matchVendorOrder(organizationId, orderRowToNormalized(order));
      applyResolution(organizationId, row, order, result.saleId, result.leadId, result.repId, result.status, result.confidence, req, "rematch");
      res.json({ ok: true, match: { status: result.status, confidence: result.confidence, candidates: result.candidates } });
    });

  /** A human decides. The only path by which a low-confidence or ambiguous
   *  match ever becomes a real one. */
  app.post("/api/order-imports/exceptions/:id/resolve", requireAuth, requireCapability("order.match.resolve"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const row = store.getImportRow(Number(req.params.id), organizationId);
      if (!row) return res.status(404).json({ error: "Not found" });
      const order = row.vendor_order_id ? store.getOrder(Number(row.vendor_order_id), organizationId) : null;
      if (!order) return res.status(404).json({ error: "Not found" });

      const decision = String(req.body?.decision ?? "");
      if (decision === "ignore") {
        store.setRowMatch(row.id, {
          matchStatus: "ignored", matchRule: "manual", matchedSaleId: null, matchedLeadId: null,
          matchedRepId: null, confidence: null,
          exceptionReason: String(req.body?.note ?? "Marked as not ours by an administrator.").slice(0, 300),
          vendorOrderId: row.vendor_order_id,
        });
        recordAdminAudit({
          ...auditContext(req), action: "order_import.exception.ignored",
          targetType: "vendor_order_import_row", targetId: String(row.id),
          after: { note: String(req.body?.note ?? "").slice(0, 200) },
        });
        return res.json({ ok: true });
      }

      const saleId = Number(req.body?.saleId);
      if (!Number.isSafeInteger(saleId) || saleId <= 0) {
        return res.status(400).json({ error: "Pick the sale this order belongs to." });
      }
      const sale = rawDb.prepare(`SELECT id, tenant_id, rep_id, lead_id FROM commission_sales WHERE id = ?`).get(saleId) as any;
      if (!sale || sale.tenant_id !== organizationId) return res.status(404).json({ error: "Not found" });

      // A human confirmation is a FULL-confidence match. That is the point of
      // the queue: a person looked at both records and said they are the same.
      applyResolution(organizationId, row, order, sale.id, sale.lead_id ?? null, sale.rep_id ?? null, "matched", 1, req, "manual");
      res.json({ ok: true });
    });

  // ── Orders ─────────────────────────────────────────────────────────────────

  app.get("/api/vendor-orders", requireAuth, requireCapability("order.read.self"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const scope = scopeOf(req, organizationId);
      const orders = store.listOrders(organizationId, {
        status: ORDER_STATUSES.includes(String(req.query.status) as any) ? String(req.query.status) as any : null,
        carrier: req.query.carrier ? String(req.query.carrier).slice(0, 64) : null,
        program: req.query.program ? String(req.query.program).slice(0, 64) : null,
        repIds: scope,
        search: req.query.q ? String(req.query.q).slice(0, 64) : null,
        limit: num(req.query.limit, 100),
        offset: num(req.query.offset, 0),
      });
      res.json({
        orders: orders.map(publicOrder),
        counts: store.orderStatusCounts(organizationId, scope),
      });
    });

  app.get("/api/vendor-orders/:id", requireAuth, requireCapability("order.read.self"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const order = store.getOrder(Number(req.params.id), organizationId);
      if (!order || !inScope(scopeOf(req, organizationId), order.rep_id)) {
        return res.status(404).json({ error: "Not found" });
      }
      res.json({
        order: publicOrder(order),
        events: store.listOrderEvents(organizationId, order.id),
        // The Commission File seam. Empty until that integration writes into
        // it; the timeline renders "no commission record yet" rather than
        // pretending an installed order has been paid.
        commission: store.listCommissionLinks(organizationId, order.id),
      });
    });

  // ── Recovery queue ─────────────────────────────────────────────────────────

  app.get("/api/order-recovery/cases", requireAuth, requireCapability("recovery.read.self"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const scope = scopeOf(req, organizationId);
      const cases = store.listCases(organizationId, {
        statuses: listParam(req.query.status, RECOVERY_CASE_STATUSES as readonly string[]),
        priorities: listParam(req.query.priority, RECOVERY_PRIORITIES as readonly string[]),
        repIds: narrowScope(scope, req.query.repId),
        limit: num(req.query.limit, 100),
        offset: num(req.query.offset, 0),
      });
      res.json({ cases: cases.map(publicCase), messagingEnabled: recoveryMessagingEnabled() });
    });

  app.get("/api/order-recovery/metrics", requireAuth, requireCapability("recovery.read.self"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const scope = scopeOf(req, organizationId);
      const config = store.getOrgRecoveryConfig(organizationId);
      res.json({
        funnel: orderFunnel(organizationId, scope),
        recovery: store.recoveryMetrics(organizationId, scope, config.policy.estimatedOrderValueCents),
        estimatedOrderValueCents: config.policy.estimatedOrderValueCents,
      });
    });

  app.get("/api/order-recovery/cases/:id", requireAuth, requireCapability("recovery.read.self"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const found = loadCaseInScope(req, organizationId, Number(req.params.id));
      if (!found) return res.status(404).json({ error: "Not found" });
      const { recoveryCase, order } = found;
      res.json({
        case: publicCase({ ...recoveryCase, ...orderJoinFields(order) }),
        order: publicOrder(order),
        timeline: store.listCaseEvents(organizationId, recoveryCase.id),
        orderEvents: store.listOrderEvents(organizationId, order.id),
        outreach: store.listOutreachForCase(organizationId, recoveryCase.id).map(publicOutreach),
        commission: store.listCommissionLinks(organizationId, order.id),
        templates: store.listTemplates(organizationId).filter((t) => t.approved === 1)
          .map((t) => ({ id: t.id, name: t.name, channel: t.channel, kind: t.kind, version: t.version })),
      });
    });

  app.post("/api/order-recovery/cases/:id/note", requireAuth, requireCapability("recovery.work"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const found = loadCaseInScope(req, organizationId, Number(req.params.id));
      if (!found) return res.status(404).json({ error: "Not found" });
      const note = String(req.body?.note ?? "").trim().slice(0, 2000);
      if (!note) return res.status(400).json({ error: "Write a note first." });
      store.appendCaseEvent({
        tenantId: organizationId, caseId: found.recoveryCase.id, eventType: "note",
        actorUserId: uid(req), actorName: actor(req)?.name ?? null, detail: note,
      });
      res.json({ ok: true });
    });

  app.post("/api/order-recovery/cases/:id/callback", requireAuth, requireCapability("recovery.work"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const found = loadCaseInScope(req, organizationId, Number(req.params.id));
      if (!found) return res.status(404).json({ error: "Not found" });
      const at = Date.parse(String(req.body?.at ?? ""));
      if (!Number.isFinite(at)) return res.status(400).json({ error: "Pick a date and time for the callback." });
      store.updateCase(found.recoveryCase.id, { next_action_at: new Date(at).toISOString(), status: "in_progress" });
      store.appendCaseEvent({
        tenantId: organizationId, caseId: found.recoveryCase.id, eventType: "callback_scheduled",
        actorUserId: uid(req), actorName: actor(req)?.name ?? null,
        detail: `Callback scheduled for ${new Date(at).toISOString()}`,
      });
      res.json({ ok: true });
    });

  /** Assignment is supervisory. A rep cannot hand their own case to someone
   *  else, and cannot take one that was not given to them. */
  app.post("/api/order-recovery/cases/:id/assign", requireAuth, requireCapability("recovery.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const found = loadCaseInScope(req, organizationId, Number(req.params.id));
      if (!found) return res.status(404).json({ error: "Not found" });

      const repId = req.body?.repId == null ? null : Number(req.body.repId);
      if (repId != null && (!Number.isSafeInteger(repId) || repId <= 0)) {
        return res.status(400).json({ error: "Pick someone to assign this to." });
      }
      if (repId != null) {
        const member = rawDb.prepare(`SELECT id, name, tenant_id, active FROM team_members WHERE id = ?`).get(repId) as any;
        if (!member || member.tenant_id !== organizationId || !member.active) {
          return res.status(404).json({ error: "Not found" });
        }
        // The assignee must be inside the assigner's own scope. A manager may
        // not push work into another branch.
        const scope = scopeOf(req, organizationId);
        if (!inScope(scope, repId)) return res.status(404).json({ error: "Not found" });
      }
      const user = repId == null ? null
        : (rawDb.prepare(`SELECT id FROM users WHERE team_member_id = ? AND active = 1 LIMIT 1`).get(repId) as any)?.id ?? null;

      store.updateCase(found.recoveryCase.id, { assigned_to_rep_id: repId, assigned_to_user_id: user });
      store.appendCaseEvent({
        tenantId: organizationId, caseId: found.recoveryCase.id, eventType: "assigned",
        actorUserId: uid(req), actorName: actor(req)?.name ?? null,
        detail: repId == null ? "Returned to the unassigned queue" : `Assigned to team member ${repId}`,
      });
      recordAdminAudit({
        ...auditContext(req), action: "order_recovery.case.assigned",
        targetType: "order_recovery_case", targetId: String(found.recoveryCase.id),
        before: { repId: found.recoveryCase.assigned_to_rep_id }, after: { repId },
      });
      res.json({ ok: true });
    });

  app.post("/api/order-recovery/cases/:id/resolve", requireAuth, requireCapability("recovery.work"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const found = loadCaseInScope(req, organizationId, Number(req.params.id));
      if (!found) return res.status(404).json({ error: "Not found" });

      const code = String(req.body?.resolutionCode ?? "");
      if (!(RESOLUTION_CODES as readonly string[]).includes(code)) {
        return res.status(400).json({ error: "Pick an outcome." });
      }
      const note = String(req.body?.note ?? "").trim().slice(0, 2000);
      const status = isRecoveredResolution(code) ? "resolved" : (code.startsWith("not_recoverable") ? "not_recoverable" : "resolved");

      store.updateCase(found.recoveryCase.id, {
        status,
        resolved_at: new Date().toISOString(),
        resolved_by_user_id: uid(req),
        resolution_code: code,
        resolution_note: note || null,
      });
      store.appendCaseEvent({
        tenantId: organizationId, caseId: found.recoveryCase.id, eventType: "resolved",
        actorUserId: uid(req), actorName: actor(req)?.name ?? null,
        detail: `${code}${note ? ` - ${note}` : ""}`,
      });
      res.json({ ok: true });
    });

  /** Re-run the whole evaluation for the organization. Bounded, admin-only, and
   *  exposed because an admin who has just changed a stall window wants to see
   *  the effect without waiting for the nightly pass. */
  app.post("/api/order-recovery/evaluate", requireAuth, requireCapability("recovery.policy.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const summary = evaluateTenantRecovery(organizationId);
      recordAdminAudit({
        ...auditContext(req), action: "order_recovery.evaluated",
        targetType: "tenant", targetId: String(organizationId), after: summary,
      });
      res.json(summary);
    });

  // ── Messaging ──────────────────────────────────────────────────────────────

  app.post("/api/order-recovery/cases/:id/draft", requireAuth, requireCapability("recovery.message.draft"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const found = loadCaseInScope(req, organizationId, Number(req.params.id));
      if (!found) return res.status(404).json({ error: "Not found" });
      const templateId = Number(req.body?.templateId);
      if (!Number.isSafeInteger(templateId)) return res.status(400).json({ error: "Pick a template." });

      const draft = buildDraft({
        tenantId: organizationId, caseId: found.recoveryCase.id, templateId,
        purpose: req.body?.purpose === "marketing" ? "marketing" : "transactional_service_update",
        actorUserId: uid(req),
      });
      if (!draft) return res.status(404).json({ error: "Not found" });
      res.json(draft);
    });

  app.post("/api/order-recovery/cases/:id/send", requireAuth, requireCapability("recovery.message.send"),
    async (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const found = loadCaseInScope(req, organizationId, Number(req.params.id));
      if (!found) return res.status(404).json({ error: "Not found" });
      const templateId = Number(req.body?.templateId);
      if (!Number.isSafeInteger(templateId)) return res.status(400).json({ error: "Pick a template." });

      const outcome = await sendOutreach({
        tenantId: organizationId, caseId: found.recoveryCase.id, templateId,
        purpose: req.body?.purpose === "marketing" ? "marketing" : "transactional_service_update",
        actorUserId: uid(req),
        automated: false,
      });
      recordAdminAudit({
        ...auditContext(req),
        action: outcome.sent ? "order_recovery.message.sent" : "order_recovery.message.blocked",
        outcome: outcome.sent ? "success" : "denied",
        targetType: "order_recovery_case", targetId: String(found.recoveryCase.id),
        after: { templateId, reasons: outcome.gate?.blockedBy ?? null },
      });
      res.status(outcome.sent ? 200 : 409).json(outcome);
    });

  /** Inbound SMS webhook. UNAUTHENTICATED by necessity - a carrier posts here -
   *  so it is shared-secret gated, and it can only ever ADD a suppression. */
  app.post("/api/order-recovery/sms/inbound", (req: Request, res: Response) => {
    const secret = process.env.RECOVERY_SMS_WEBHOOK_SECRET ?? "";
    const presented = String(req.headers["x-webhook-secret"] ?? "");
    // Constant-time, exactly as the scheduled-delivery webhook above does with
    // the same header: a plain !== short-circuits on the first differing byte
    // and leaks the matched prefix length to a timing probe. The !secret guard
    // stays first so an unconfigured deployment refuses everything rather than
    // comparing "" against "".
    if (!secret || !timingSafeEqualStr(secret, presented)) {
      return res.status(404).json({ error: "Not found" });
    }
    const from = String(req.body?.from ?? "");
    const body = String(req.body?.body ?? "").slice(0, 1600);
    const result = handleInboundSms({ from, body });
    res.json({ ok: true, optOut: result.optOut });
  });

  /** The unsubscribe link in every email. Public by design: a mechanism that
   *  needs a login is not a functional unsubscribe. */
  app.get("/api/order-recovery/unsubscribe", (req: Request, res: Response) => {
    const result = processUnsubscribe(String(req.query.token ?? ""));
    res.status(result.ok ? 200 : 400)
      .type("html")
      .send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Email preferences</title>
<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.25rem">${result.ok ? "You are unsubscribed" : "This link is not valid"}</h1>
<p>${escapeHtml(result.message)}</p>
</body>`);
  });

  // ── Templates ──────────────────────────────────────────────────────────────

  app.get("/api/order-recovery/templates", requireAuth, requireCapability("messaging.templates.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      store.seedTemplatesIfEmpty(organizationId, SEED_TEMPLATES);
      res.json({ templates: store.listTemplates(organizationId), kinds: TEMPLATE_KINDS, channels: CONTACT_CHANNELS });
    });

  app.post("/api/order-recovery/templates", requireAuth, requireCapability("messaging.templates.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const body = req.body ?? {};
      const channel = CONTACT_CHANNELS.includes(body.channel) ? body.channel : null;
      const kind = (TEMPLATE_KINDS as readonly string[]).includes(String(body.kind)) ? String(body.kind) : null;
      if (!channel || !kind) return res.status(400).json({ error: "Pick a channel and a template type." });

      const issues = validateTemplate({
        channel, kind: kind as any,
        subject: body.subject ? String(body.subject).slice(0, 200) : null,
        body: String(body.body ?? "").slice(0, 8000),
      });
      if (issues.some((i) => i.severity === "error")) {
        return res.status(400).json({ error: "This template cannot be saved yet.", issues });
      }

      // Editing publishes a NEW version and retires the old one, so an approval
      // always refers to the exact words it was granted for.
      const previousId = Number(body.replacesId);
      let version = 1;
      if (Number.isSafeInteger(previousId) && previousId > 0) {
        const previous = store.getTemplate(previousId, organizationId);
        if (previous) { version = Number(previous.version) + 1; store.retireTemplate(previous.id); }
      }
      const id = store.insertTemplate({
        tenantId: organizationId, kind, channel, version,
        name: String(body.name ?? "Untitled").slice(0, 120),
        subject: body.subject ? String(body.subject).slice(0, 200) : null,
        body: String(body.body ?? "").slice(0, 8000),
        createdByUserId: uid(req),
      });
      recordAdminAudit({
        ...auditContext(req), action: "order_recovery.template.saved",
        targetType: "order_recovery_template", targetId: String(id),
        after: { kind, channel, version, approved: false },
      });
      res.json({ ok: true, id, version, issues });
    });

  app.post("/api/order-recovery/templates/:id/approve", requireAuth, requireCapability("messaging.templates.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const approved = req.body?.approved !== false;
      const result = approveTemplateChecked(organizationId, Number(req.params.id), uid(req)!, approved);
      if (!result.ok) return res.status(400).json({ error: "This template cannot be approved.", issues: result.issues });
      recordAdminAudit({
        ...auditContext(req), action: approved ? "order_recovery.template.approved" : "order_recovery.template.unapproved",
        targetType: "order_recovery_template", targetId: String(req.params.id), after: { approved },
      });
      res.json({ ok: true });
    });

  // ── Policy and consent ─────────────────────────────────────────────────────

  app.get("/api/order-recovery/policy", requireAuth, requireCapability("recovery.policy.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      res.json({
        config: store.getOrgRecoveryConfig(organizationId),
        defaults: DEFAULT_RECOVERY_POLICY,
        flags: { orderSyncEnabled: orderSyncEnabled(), recoveryMessagingEnabled: recoveryMessagingEnabled() },
      });
    });

  app.put("/api/order-recovery/policy", requireAuth, requireCapability("recovery.policy.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const body = req.body ?? {};
      const before = store.getOrgRecoveryConfig(organizationId);
      const config = store.saveOrgRecoveryConfig(organizationId, {
        policy: resolveRecoveryPolicy(body.policy),
        messagingApproved: body.messagingApproved === undefined ? undefined : Boolean(body.messagingApproved),
        consentPolicyConfigured: body.consentPolicyConfigured === undefined ? undefined : Boolean(body.consentPolicyConfigured),
        automatedSequencesEnabled: body.automatedSequencesEnabled === undefined ? undefined : Boolean(body.automatedSequencesEnabled),
        supportPhone: str(body.supportPhone, 40),
        companyMailingAddress: str(body.companyMailingAddress, 300),
        smsSenderIdentity: str(body.smsSenderIdentity, 40),
        emailSenderIdentity: str(body.emailSenderIdentity, 200),
        emailReplyTo: str(body.emailReplyTo, 200),
        callbackUrl: str(body.callbackUrl, 500),
        quietHoursStart: intOr(body.quietHoursStart, before.quietHoursStart),
        quietHoursEnd: intOr(body.quietHoursEnd, before.quietHoursEnd),
        maxPerDestinationPerDay: intOr(body.maxPerDestinationPerDay, before.maxPerDestinationPerDay),
        maxPerCaseTotal: intOr(body.maxPerCaseTotal, before.maxPerCaseTotal),
        minHoursBetweenOutreach: intOr(body.minHoursBetweenOutreach, before.minHoursBetweenOutreach),
        reportTimezone: str(body.reportTimezone, 64) ?? before.reportTimezone ?? DEFAULT_REPORT_TIMEZONE,
      }, uid(req));

      recordAdminAudit({
        ...auditContext(req), action: "order_recovery.policy.updated",
        targetType: "tenant", targetId: String(organizationId),
        before: { messagingApproved: before.messagingApproved, automated: before.automatedSequencesEnabled },
        after: { messagingApproved: config.messagingApproved, automated: config.automatedSequencesEnabled },
      });
      res.json({ config });
    });

  app.get("/api/order-recovery/suppressions", requireAuth, requireCapability("contact.suppression.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      res.json({ suppressions: store.listSuppressions(organizationId, num(req.query.limit, 200)) });
    });

  app.post("/api/order-recovery/suppressions", requireAuth, requireCapability("contact.suppression.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const channel = CONTACT_CHANNELS.includes(req.body?.channel) ? req.body.channel : null;
      if (!channel) return res.status(400).json({ error: "Pick a channel." });
      const normalized = channel === "sms" ? normalizePhoneE164(req.body?.destination) : normalizeEmail(req.body?.destination);
      if (!normalized) return res.status(400).json({ error: "That is not a valid phone number or email address." });

      const result = store.suppressDestination({
        tenantId: organizationId, leadId: null, vendorOrderId: null, channel,
        destinationNormalized: normalized,
        reason: ["do_not_contact", "complaint", "admin_block", "invalid_destination"].includes(String(req.body?.reason))
          ? String(req.body.reason) : "do_not_contact",
        source: "admin_entry",
        evidence: str(req.body?.note, 300),
        createdByUserId: uid(req),
      });
      recordAdminAudit({
        ...auditContext(req), action: "order_recovery.suppression.added",
        targetType: "customer_contact_suppression", targetId: String(result.id),
        after: { channel, created: result.created },
      });
      res.json({ ok: true, id: result.id });
    });

  /** Lifting a block is the one action that could un-silence somebody who asked
   *  us to stop, so it demands a written reason and is always audited. */
  app.post("/api/order-recovery/suppressions/:id/lift", requireAuth, requireCapability("contact.suppression.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const reason = String(req.body?.reason ?? "").trim();
      if (reason.length < 10) {
        return res.status(400).json({ error: "Write down why this block is being lifted (at least 10 characters)." });
      }
      const ok = store.liftSuppression(organizationId, Number(req.params.id), uid(req)!, reason);
      recordAdminAudit({
        ...auditContext(req), action: "order_recovery.suppression.lifted",
        outcome: ok ? "success" : "failure",
        targetType: "customer_contact_suppression", targetId: String(req.params.id),
        after: { reason: reason.slice(0, 200) },
      });
      if (!ok) return res.status(404).json({ error: "Not found" });
      res.json({ ok: true });
    });

  app.post("/api/order-recovery/consents", requireAuth, requireCapability("contact.consent.manage"),
    (req: Request, res: Response) => {
      const organizationId = requireOrg(req, res);
      if (organizationId == null) return;
      const body = req.body ?? {};
      const channel = CONTACT_CHANNELS.includes(body.channel) ? body.channel : null;
      if (!channel) return res.status(400).json({ error: "Pick a channel." });
      const normalized = channel === "sms" ? normalizePhoneE164(body.destination) : normalizeEmail(body.destination);
      if (!normalized) return res.status(400).json({ error: "That is not a valid phone number or email address." });
      if (!(CONSENT_BASES as readonly string[]).includes(String(body.basis))) {
        return res.status(400).json({ error: "Record what the consent is based on." });
      }
      if (!(CONSENT_SOURCES as readonly string[]).includes(String(body.source))) {
        return res.status(400).json({ error: "Record where the consent came from." });
      }

      const id = store.recordConsent({
        tenantId: organizationId,
        leadId: intOrNull(body.leadId), saleId: intOrNull(body.saleId), vendorOrderId: intOrNull(body.vendorOrderId),
        channel, destinationNormalized: normalized,
        status: body.status === "revoked" ? "revoked" : "granted",
        basis: String(body.basis), source: String(body.source),
        language: str(body.language, 2000),
        capturedAt: Number.isFinite(Date.parse(String(body.capturedAt))) ? new Date(String(body.capturedAt)).toISOString() : new Date().toISOString(),
        proofReference: str(body.proofReference, 200),
        createdByUserId: uid(req),
      });
      recordAdminAudit({
        ...auditContext(req), action: "order_recovery.consent.recorded",
        targetType: "customer_contact_consent", targetId: String(id),
        after: { channel, basis: String(body.basis), source: String(body.source), status: body.status ?? "granted" },
      });
      res.json({ ok: true, id });
    });
}

// ── Upload plumbing ──────────────────────────────────────────────────────────

/** Wraps multer so its errors become the app's error shape rather than a 500
 *  with a stack. Same treatment routes.ts gives the photo uploader. */
function uploadOnce(req: Request, res: Response, next: any) {
  upload.single("file")(req, res, (err: any) => {
    if (!err) return next();
    const tooBig = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE";
    return res.status(400).json({
      error: tooBig
        ? `That file is larger than ${Math.round(MAX_SOURCE_FILE_BYTES / (1024 * 1024))} MB. Split the report by date range.`
        : "That upload could not be read.",
    });
  });
}

/** The scheduled-delivery body: the file itself, whatever its content type.
 *  Route-scoped for the same reason discoveryUploadBodyParser is - an
 *  app-level 25 MB parser would buffer anonymous POSTs everywhere. If the
 *  global JSON parser already consumed the body (a caller mislabeled the file
 *  as application/json), req.body is not a Buffer and the handler answers
 *  with the contract instead of a parse error. */
const rawReportBody = express.raw({ type: () => true, limit: MAX_SOURCE_FILE_BYTES });
function rawReportBodyOnce(req: Request, res: Response, next: any) {
  rawReportBody(req, res, (err: any) => {
    if (!err) return next();
    const tooBig = err?.type === "entity.too.large" || err?.status === 413;
    return res.status(tooBig ? 413 : 400).json({
      error: tooBig
        ? `That file is larger than ${Math.round(MAX_SOURCE_FILE_BYTES / (1024 * 1024))} MB. Split the report by date range.`
        : "That delivery could not be read.",
    });
  });
}

/** Equal length and equal bytes, in constant time. A plain !== on a secret
 *  leaks its prefix length to a timing probe. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

async function parseUpload(file: { buffer: Buffer; originalname?: string }) {
  const provider = getOrderStatusProvider("perfectvision_submitted_orders");
  return provider.parseOrderReport({
    report: {
      // Sniffed, not trusted: a .csv that is really a workbook, or the reverse,
      // is a routine mistake and reading the bytes settles it.
      format: looksLikeXlsx(file.buffer.subarray(0, 8)) ? "xlsx" : "csv",
      content: file.buffer,
      fileName: String(file.originalname ?? "report"),
      sourceReportId: null,
      retrievedAt: new Date(),
    },
    maxRows: MAX_IMPORT_ROWS,
  });
}

// ── Response shaping ─────────────────────────────────────────────────────────

function publicOrder(row: any) {
  return {
    id: row.id,
    externalOrderId: row.external_order_id,
    externalTransactionId: row.external_transaction_id,
    customerAccountNumber: row.customer_account_number,
    customerName: row.customer_name,
    // Masked, always. There is no query parameter that unmasks these.
    customerPhoneMasked: row.customer_phone_masked,
    customerEmailMasked: row.customer_email_masked,
    serviceAddress: row.service_address,
    carrier: row.carrier,
    productSold: row.product_sold,
    program: row.program,
    repId: row.rep_id,
    repExternalName: row.rep_external_name,
    managerExternalName: row.manager_external_name,
    saleId: row.sale_id,
    leadId: row.lead_id,
    normalizedStatus: row.normalized_status,
    sourceStatus: row.source_status,
    submittedDate: row.submitted_date,
    installScheduledAt: row.install_scheduled_at,
    installDate: row.install_date,
    cancellationDate: row.cancellation_date,
    failureReason: row.failure_reason,
    requiredCustomerAction: row.required_customer_action,
    matchStatus: row.match_status,
    matchConfidence: row.match_confidence_score,
    lastVendorUpdatedAt: row.last_vendor_updated_at,
    lastSyncedAt: row.last_synced_at,
  };
}

function publicCase(row: any) {
  return {
    id: row.id,
    vendorOrderId: row.vendor_order_id,
    saleId: row.sale_id,
    leadId: row.lead_id,
    assignedToRepId: row.assigned_to_rep_id,
    assignedToUserId: row.assigned_to_user_id,
    reason: row.recovery_reason,
    priority: row.priority,
    status: row.status,
    daysStalled: row.days_stalled,
    nextActionAt: row.next_action_at,
    lastOutreachAt: row.last_outreach_at,
    outreachCount: row.outreach_count,
    optOutBlocked: row.opt_out_blocked === 1,
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at,
    resolutionCode: row.resolution_code,
    resolutionNote: row.resolution_note,
    customerName: row.customer_name,
    customerNameShort: maskName(row.customer_name),
    serviceAddress: row.service_address,
    carrier: row.carrier,
    productSold: row.product_sold,
    program: row.program,
    orderStatus: row.normalized_status,
    sourceStatus: row.source_status,
    failureReason: row.failure_reason,
    requiredCustomerAction: row.required_customer_action,
    installScheduledAt: row.install_scheduled_at,
    installDate: row.install_date,
    submittedDate: row.submitted_date,
    repExternalName: row.rep_external_name,
    customerPhoneMasked: row.customer_phone_masked,
    customerEmailMasked: row.customer_email_masked,
    matchStatus: row.match_status,
    matchConfidence: row.match_confidence_score,
    externalOrderId: row.external_order_id,
  };
}

function publicOutreach(row: any) {
  return {
    id: row.id,
    channel: row.channel,
    status: row.status,
    subject: row.subject_snapshot,
    body: row.message_body_snapshot,
    recipient: row.recipient_phone_masked ?? row.recipient_email_masked,
    consentBasis: row.consent_basis,
    blockedReasons: row.blocked_reasons ? safeJson(row.blocked_reasons) : null,
    sentAt: row.sent_at,
    deliveredAt: row.delivered_at,
    failedAt: row.failed_at,
    responseAt: row.response_at,
    optOutDetectedAt: row.opt_out_detected_at,
    createdAt: row.created_at,
  };
}

function orderJoinFields(order: any) {
  return {
    external_order_id: order.external_order_id,
    customer_name: order.customer_name,
    service_address: order.service_address,
    carrier: order.carrier,
    product_sold: order.product_sold,
    program: order.program,
    normalized_status: order.normalized_status,
    source_status: order.source_status,
    failure_reason: order.failure_reason,
    required_customer_action: order.required_customer_action,
    install_scheduled_at: order.install_scheduled_at,
    install_date: order.install_date,
    submitted_date: order.submitted_date,
    rep_external_name: order.rep_external_name,
    customer_phone_masked: order.customer_phone_masked,
    customer_email_masked: order.customer_email_masked,
    match_status: order.match_status,
    match_confidence_score: order.match_confidence_score,
  };
}

/** The preview row a browser gets. Contact details become presence flags: an
 *  admin validating a mapping needs to know the column HAS phone numbers, not
 *  what they are. */
function maskedPreviewRow(row: any) {
  return {
    externalOrderId: row.externalOrderId,
    externalTransactionId: row.externalTransactionId,
    customerAccountNumber: row.customerAccountNumber ? `...${String(row.customerAccountNumber).slice(-4)}` : null,
    customerName: maskName(row.customerName),
    hasPhone: Boolean(row.customerPhone),
    hasEmail: Boolean(row.customerEmail),
    serviceAddress: row.normalizedServiceAddress,
    carrier: row.carrier,
    productSold: row.productSold,
    program: row.program,
    repExternalName: row.repExternalName,
    submittedDate: row.submittedDate,
    installScheduledAt: row.installScheduledAt,
    installDate: row.installDate,
    sourceStatus: row.sourceStatus,
    normalizedStatus: row.normalizedStatus,
    failureReason: row.failureReason,
    requiredCustomerAction: row.requiredCustomerAction,
  };
}

/** The raw sample, with the columns bound to contact fields redacted. Keeps the
 *  "is this my report?" recognition without shipping a customer list. */
function maskSampleRow(row: Record<string, unknown>, mapping: OrderColumnMapping): Record<string, unknown> {
  const redacted = new Set([mapping.columns.customerPhone, mapping.columns.customerEmail].filter(Boolean) as string[]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = redacted.has(k) ? (String(v ?? "").trim() ? "[hidden]" : "") : String(v ?? "").slice(0, 80);
  }
  return out;
}

// ── Small helpers ────────────────────────────────────────────────────────────

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function intOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function intOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function str(value: unknown, max: number): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, max) : null;
}

function listParam(value: unknown, allowed: readonly string[]): string[] | undefined {
  if (value == null) return undefined;
  const parts = String(value).split(",").map((s) => s.trim()).filter((s) => allowed.includes(s));
  return parts.length ? parts : undefined;
}

function safeJson(value: unknown): any {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(String(value)); } catch { return null; }
}

/** A client filter may only NARROW the server-resolved scope. */
function narrowScope(scope: number[] | null, requested: unknown): number[] | null {
  const want = Number(requested);
  if (!Number.isSafeInteger(want) || want <= 0) return scope;
  if (scope === null) return [want];
  return scope.includes(want) ? [want] : [-1];
}

function inScope(scope: number[] | null, repId: unknown): boolean {
  if (scope === null) return true;
  const id = Number(repId);
  // An unassigned order is visible to anyone who can see the queue at all;
  // a supervisor has to be able to see work nobody owns yet.
  if (!Number.isSafeInteger(id) || id <= 0) return true;
  return scope.includes(id);
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function sanitizeFilename(name: unknown): string {
  return String(name ?? "report").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "report";
}

function safeProviderMessage(e: unknown): string {
  if (e instanceof ProviderError) return e.safeMessage;
  if (e && typeof e === "object" && "name" in e && (e as any).name === "XlsxError") return String((e as any).message);
  return "That file could not be read. Export the report again as CSV or XLSX.";
}

/** The vendor_orders row, back in the normalized shape the matcher expects.
 *  Used when re-running a match without the original file. */
function orderRowToNormalized(order: any): any {
  return {
    provider: "perfectvision_submitted_orders",
    organizationId: order.tenant_id,
    externalOrderId: order.external_order_id,
    externalTransactionId: order.external_transaction_id,
    customerAccountNumber: order.customer_account_number,
    customerName: order.customer_name,
    serviceAddress: order.service_address,
    normalizedServiceAddress: order.normalized_service_address,
    carrier: order.carrier,
    productSold: order.product_sold,
    program: order.program,
    repExternalName: order.rep_external_name,
    repExternalId: order.rep_external_id,
    submittedDate: order.submitted_date ? new Date(order.submitted_date) : null,
    saleDate: order.sale_date ? new Date(order.sale_date) : null,
    normalizedStatus: order.normalized_status,
    rawRowHash: order.current_row_hash ?? "",
    sourceRowPayload: {},
  };
}

/** Write a resolved match onto both the row and the order, then re-evaluate
 *  recovery: a newly matched order is exactly the kind that should enter the
 *  queue immediately rather than at the next nightly pass. */
function applyResolution(
  organizationId: number, row: any, order: any,
  saleId: number | null, leadId: number | null, repId: number | null,
  status: string, confidence: number, req: Request, how: string,
): void {
  store.setRowMatch(row.id, {
    matchStatus: status as any, matchRule: how, matchedSaleId: saleId, matchedLeadId: leadId,
    matchedRepId: repId, confidence,
    exceptionReason: status === "matched" ? null : "Still unresolved after a re-run.",
    vendorOrderId: order.id,
  });
  if (status === "matched") {
    rawDb.prepare(`
      UPDATE vendor_orders SET sale_id = ?, lead_id = ?, rep_id = ?, match_status = 'matched',
             match_confidence_score = ?, updated_at = ? WHERE id = ? AND tenant_id = ?
    `).run(saleId, leadId, repId, confidence, new Date().toISOString(), order.id, organizationId);

    // Stamp the carrier's ids onto the sale, so the NEXT import matches at tier
    // one without a human. Resolving an exception should make the next one less
    // likely, not just clear this one.
    if (saleId != null) {
      rawDb.prepare(`
        UPDATE commission_sales
           SET external_order_id = COALESCE(external_order_id, ?),
               external_transaction_id = COALESCE(external_transaction_id, ?),
               customer_account_number = COALESCE(customer_account_number, ?)
         WHERE id = ? AND tenant_id = ?
      `).run(order.external_order_id, order.external_transaction_id, order.customer_account_number, saleId, organizationId);
    }

    const refreshed = store.getOrder(Number(order.id), organizationId);
    if (refreshed) {
      evaluateOneOrder(organizationId, refreshed, store.getOrgRecoveryConfig(organizationId).policy, new Date());
    }
  }
  recordAdminAudit({
    ...auditContext(req), action: "order_import.exception.resolved",
    targetType: "vendor_order_import_row", targetId: String(row.id),
    after: { how, saleId, repId, status, confidence },
  });
}

/** Load a case and prove the caller may see it. 404 for out of scope, never
 *  403 - the existence of a case is itself information. */
function loadCaseInScope(req: Request, organizationId: number, caseId: number): { recoveryCase: any; order: any } | null {
  const recoveryCase = store.getCase(caseId, organizationId);
  if (!recoveryCase) return null;
  const order = store.getOrder(Number(recoveryCase.vendor_order_id), organizationId);
  if (!order) return null;

  const user = (req as any).user;
  if (can(user?.role, "recovery.read.org")) return { recoveryCase, order };

  const members = (storage.getTeamMembers(organizationId) as any[]).map((m) => ({
    id: Number(m.id), role: String(m.role ?? "rep"),
    reportsToId: m.reportsToId == null ? null : Number(m.reportsToId),
    active: m.active !== false && Number(m.active ?? 1) !== 0,
  }));
  const scope = liveOpsScope(user, members);
  if (scope === null) return { recoveryCase, order };
  const assigned = Number(recoveryCase.assigned_to_rep_id);
  if (Number.isSafeInteger(assigned) && assigned > 0 && scope.includes(assigned)) return { recoveryCase, order };
  return null;
}

/** Normalize whatever the client sent into a mapping object, dropping bindings
 *  to columns the file does not have. */
function normalizeMapping(
  raw: unknown, columns: string[] | null, timeZone: string,
): OrderColumnMapping | null {
  const parsed = safeJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const base = emptyOrderColumnMapping(timeZone);
  const columnSet = columns ? new Set(columns) : null;
  const cols: Record<string, string> = {};
  for (const [field, header] of Object.entries(parsed.columns ?? {})) {
    if (typeof header !== "string" || !header) continue;
    if (columnSet && !columnSet.has(header)) continue;
    cols[field] = header;
  }
  const overrides: Record<string, any> = {};
  for (const [text, target] of Object.entries(parsed.statusOverrides ?? {})) {
    if (typeof target === "string") overrides[String(text).toLowerCase().slice(0, 200)] = target;
  }
  return {
    ...base,
    columns: cols as any,
    statusOverrides: overrides,
    timeZone: typeof parsed.timeZone === "string" && parsed.timeZone ? parsed.timeZone : timeZone,
    defaults: {
      carrier: str(parsed.defaults?.carrier, 64),
      program: str(parsed.defaults?.program, 64),
      productSold: str(parsed.defaults?.productSold, 64),
    },
  };
}
