import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Capability } from "@shared/capabilities";
import { rawDb } from "./db";
import { getDefaultTenantId, storage } from "./storage";
import * as scanService from "./scanService";
import { runScanWorker } from "./scanEngine";
import {
  appendFiberEvent, listDeadLetters, listFiberAddresses, listFiberEvents, listFiberFailures,
  operationsDashboard, providerConfigs, retryDeadLetter,
} from "./fiberOperationsStore";

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;
export interface FiberOperationsRouteDeps {
  requireAuth: Middleware;
  requireCapability: (capability: Capability) => Middleware;
  requireScanningAllowed: Middleware;
  scanAdmission: Middleware;
}

const createJobSchema = z.object({
  mode: z.enum(["market", "city", "state", "zip", "bbox", "target_ids"]).default("market"),
  city: z.string().trim().min(1).max(120).optional(),
  state: z.string().trim().length(2).transform((v) => v.toUpperCase()).default("NC"),
  zip: z.string().trim().regex(/^\d{5}$/).optional(),
  bbox: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)]).optional(),
  targetIds: z.array(z.number().int().positive()).min(1).max(10_000).optional(),
  budget: z.number().int().positive().max(10_000),
  rescan: z.boolean().default(false),
  confirmedSpend: z.literal(true),
  label: z.string().trim().min(1).max(160).optional(),
}).superRefine((value, context) => {
  if (["market", "city"].includes(value.mode) && !value.city) context.addIssue({ code: "custom", message: "city is required", path: ["city"] });
  if (value.mode === "zip" && !value.zip) context.addIssue({ code: "custom", message: "zip is required", path: ["zip"] });
  if (value.mode === "bbox" && !value.bbox) context.addIssue({ code: "custom", message: "bbox is required", path: ["bbox"] });
  if (value.mode === "target_ids" && !value.targetIds) context.addIssue({ code: "custom", message: "targetIds are required", path: ["targetIds"] });
});

const addressQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.coerce.number().int().positive().optional(),
  city: z.string().trim().max(120).optional(),
  state: z.string().trim().length(2).optional(),
  result: z.enum(["new_fiber", "no_service", "other", "failed"]).optional(),
});

function tenantId(req: Request): number | null {
  const value = Number((req as any).user?.tenantId ?? getDefaultTenantId());
  return Number.isInteger(value) && value > 0 ? value : null;
}

function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
}

function targetIdsFor(input: z.infer<typeof createJobSchema>, tid: number): number[] {
  if (input.mode === "target_ids") {
    const ids = [...new Set(input.targetIds ?? [])].slice(0, input.budget);
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    return (rawDb.prepare(`SELECT id FROM scan_targets WHERE id IN (${placeholders}) AND (tenant_id IS NULL OR tenant_id=?) LIMIT ?`)
      .all(...ids, tid, input.budget) as any[]).map((row) => Number(row.id));
  }
  const conditions = ["(tenant_id IS NULL OR tenant_id=?)"];
  const args: unknown[] = [tid];
  if (input.mode === "state") { conditions.push("lower(state)=lower(?)"); args.push(input.state); }
  if (["market", "city"].includes(input.mode)) {
    conditions.push("lower(city)=lower(?)", "lower(state)=lower(?)"); args.push(input.city!, input.state);
  }
  if (input.mode === "zip") { conditions.push("zip=?"); args.push(input.zip!); }
  if (input.mode === "bbox") {
    const [west, south, east, north] = input.bbox!;
    conditions.push("lng BETWEEN ? AND ?", "lat BETWEEN ? AND ?"); args.push(west, east, south, north);
  }
  if (!input.rescan) conditions.push("last_scanned_at IS NULL");
  args.push(input.budget);
  return (rawDb.prepare(`SELECT id FROM scan_targets WHERE ${conditions.join(" AND ")}
    ORDER BY (last_scanned_at IS NOT NULL),last_scanned_at ASC,id ASC LIMIT ?`).all(...args) as any[]).map((row) => Number(row.id));
}

export function registerFiberOperationsRoutes(app: Express, deps: FiberOperationsRouteDeps): void {
  const read = deps.requireCapability("scan.manage");
  const manage = deps.requireCapability("scan.manage");

  app.get("/api/v1/fiber/dashboard", read, (req, res) => {
    const tid = tenantId(req); if (!tid) return res.status(403).json({ error: "Organization required" });
    res.json(operationsDashboard(tid));
  });

  app.get("/api/v1/fiber/jobs", read, (req, res) => {
    const tid = tenantId(req); if (!tid) return res.status(403).json({ error: "Organization required" });
    res.json({ jobs: scanService.getRuns(tid) });
  });

  app.post("/api/v1/fiber/jobs", manage, deps.requireScanningAllowed, deps.scanAdmission, (req, res) => {
    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Invalid scan request", issues: parsed.error.flatten() });
    const tid = tenantId(req); if (!tid) return res.status(403).json({ error: "Organization required" });
    try {
      const input = parsed.data;
      const ids = targetIdsFor(input, tid);
      if (!ids.length) return res.status(409).json({ error: "No eligible addresses match this scan scope" });
      const city = input.city ?? (input.zip ? `ZIP ${input.zip}` : input.mode === "state" ? `${input.state} statewide` : "Selected area");
      const job = scanService.startTargetRun({ tenantId: tid, city, state: input.state, targetIds: ids,
        createdBy: Number((req as any).user?.id), runKind: input.mode, label: input.label ?? `Fiber verification - ${city}` });
      storage.logActivity(Number((req as any).user?.id), "fiber.job.created", "scan_run", undefined,
        { runId: job.runId, mode: input.mode, budget: job.budget }, req.ip, tid);
      res.status(202).json({ ...job, statusUrl: `/api/v1/fiber/jobs/${job.runId}`, eventsUrl: `/api/v1/fiber/jobs/${job.runId}/events` });
    } catch (error: any) { res.status(400).json({ error: String(error?.message ?? error) }); }
  });

  app.get("/api/v1/fiber/jobs/:id", read, (req, res) => {
    const tid = tenantId(req); if (!tid) return res.status(403).json({ error: "Organization required" });
    const job = scanService.getRunStatus(param(req, "id"), tid);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json(job);
  });

  app.post("/api/v1/fiber/jobs/:id/:action", manage, (req, res, next) => {
    if (param(req, "action") === "resume") return deps.requireScanningAllowed(req, res, () => deps.scanAdmission(req, res, next));
    next();
  }, (req, res) => {
    const action = param(req, "action");
    if (!["pause", "resume", "stop"].includes(action)) return res.status(400).json({ error: "Action must be pause, resume, or stop" });
    const tid = tenantId(req); if (!tid) return res.status(403).json({ error: "Organization required" });
    const internal = action === "stop" ? "cancel" : action;
    if (!scanService.controlRun(param(req, "id"), tid, internal as "pause" | "resume" | "cancel")) return res.status(404).json({ error: "Job not found" });
    appendFiberEvent({ tenantId: tid, runId: param(req, "id"), eventType: action === "stop" ? "job.cancelled" : action === "pause" ? "job.paused" : "job.resumed", payload: { actorId: (req as any).user?.id } });
    storage.logActivity(Number((req as any).user?.id), `fiber.job.${action}`, "scan_run", undefined, { runId: param(req, "id") }, req.ip, tid);
    res.json({ ok: true, action });
  });

  app.get("/api/v1/fiber/jobs/:id/events", read, (req, res) => {
    const tid = tenantId(req); if (!tid) return res.status(403).end();
    const runId = param(req, "id");
    if (!scanService.getRunStatus(runId, tid)) return res.status(404).json({ error: "Job not found" });
    let after = Math.max(0, Number(req.headers["last-event-id"] ?? req.query.after ?? 0) || 0);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    const flush = () => {
      for (const event of listFiberEvents(tid, runId, after)) {
        after = event.sequence;
        res.write(`id: ${event.sequence}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    };
    flush();
    const events = setInterval(flush, 1_000);
    const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 15_000);
    req.on("close", () => { clearInterval(events); clearInterval(keepAlive); });
  });

  app.get("/api/v1/fiber/addresses", read, (req, res) => {
    const parsed = addressQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid address filters", issues: parsed.error.flatten() });
    const tid = tenantId(req); if (!tid) return res.status(403).json({ error: "Organization required" });
    res.json(listFiberAddresses(tid, parsed.data));
  });

  app.get("/api/v1/fiber/failures", read, (req, res) => {
    const tid = tenantId(req); if (!tid) return res.status(403).json({ error: "Organization required" });
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    res.json({ failures: listFiberFailures(tid, typeof req.query.runId === "string" ? req.query.runId : undefined, limit), deadLetters: listDeadLetters(tid, limit) });
  });

  app.post("/api/v1/fiber/dead-letters/:id/retry", manage, deps.requireScanningAllowed, deps.scanAdmission, (req, res) => {
    const tid = tenantId(req); if (!tid) return res.status(403).json({ error: "Organization required" });
    const id = Number(param(req, "id"));
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid dead-letter id" });
    const retried = retryDeadLetter(tid, id, Number((req as any).user?.id));
    if (!retried) return res.status(404).json({ error: "Open dead letter not found" });
    void runScanWorker(retried.runId, tid);
    res.status(202).json({ ok: true, ...retried });
  });

  app.get("/api/v1/fiber/providers", manage, (req, res) => {
    const tid = tenantId(req); if (!tid) return res.status(403).json({ error: "Organization required" });
    res.json({ providers: providerConfigs(tid) });
  });
}
