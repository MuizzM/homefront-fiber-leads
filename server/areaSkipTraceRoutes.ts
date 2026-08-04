// ── Area skip-trace routes ──────────────────────────────────────────────────
// Three endpoints on an Area: start a run, poll it, read the worklist.
//
// Deliberately a field-domain module, not part of the Calling module: the
// actor is a manager working a territory, and team_lead/manager hold no
// calling.* capabilities by design. Every route pairs its capability with the
// injected territory-scope gate and answers 404 — never 403 — for an area the
// caller may not see, so ids cannot be probed.

import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Capability } from "@shared/capabilities";
import { rawDb } from "./db";
import {
  AreaSkipTraceError,
  buildAreaDialingList,
  countAreaLeads,
  getAreaSkipTraceRun,
  latestAreaSkipTraceRun,
  startAreaSkipTraceRun,
} from "./areaSkipTrace";

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;

export type AreaSkipTraceRouteDeps = {
  requireAuth: Middleware;
  requireCapability: (capability: Capability) => Middleware;
  /** Territory ownership gate. REQUIRED — an absent gate would read as "allow". */
  canManageArea: (req: Request, territoryId: number) => boolean;
};

const idSchema = z.coerce.number().int().positive();
const uuidSchema = z.string().uuid();

export function registerAreaSkipTraceRoutes(app: Express, deps: AreaSkipTraceRouteDeps): void {
  const cap = deps.requireCapability;

  function tenantOf(req: Request, res: Response): number | null {
    const tid = Number((req as any).user?.tenantId);
    if (!Number.isFinite(tid) || tid <= 0) {
      res.status(403).json({ error: "Organization membership required" });
      return null;
    }
    return tid;
  }

  /** Resolve :areaId and enforce ownership. Out-of-scope, foreign-tenant and
   *  nonexistent areas are indistinguishable from outside. */
  function areaId(req: Request, res: Response, tid: number): number | null {
    const parsed = idSchema.safeParse(req.params.areaId);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid area id" });
      return null;
    }
    const territory = rawDb.prepare("SELECT id FROM territories WHERE id=? AND (tenant_id IS NULL OR tenant_id=?)")
      .get(parsed.data, tid) as any;
    if (!territory || !deps.canManageArea(req, parsed.data)) {
      res.status(404).json({ error: "Area not found" });
      return null;
    }
    return parsed.data;
  }

  function fail(res: Response, error: unknown): Response {
    if (error instanceof AreaSkipTraceError) {
      return res.status(error.status).json({ error: error.message, code: error.code, detail: error.detail });
    }
    const message = error instanceof Error ? error.message : "Request failed";
    return res.status(500).json({ error: "Area skip trace request failed", detail: message.slice(0, 200) });
  }

  // 202, not 200: an area is 100–250 doors behind a queued provider job. The
  // client polls the run rather than holding a request open for minutes.
  app.post("/api/areas/:areaId/tracerfy-run", cap("lead.skip_trace.request"), (req, res) => {
    const tid = tenantOf(req, res); if (!tid) return;
    const territoryId = areaId(req, res, tid); if (!territoryId) return;
    try {
      res.status(202).json(startAreaSkipTraceRun({
        tenantId: tid, territoryId, actorUserId: Number((req as any).user?.id),
      }));
    } catch (error) { fail(res, error); }
  });

  app.get("/api/areas/:areaId/tracerfy-run", cap("lead.skip_trace.read"), (req, res) => {
    const tid = tenantOf(req, res); if (!tid) return;
    const territoryId = areaId(req, res, tid); if (!territoryId) return;
    try {
      // ?runId= polls a specific run, scoped to THIS area; without it the
      // console gets the latest.
      const runId = uuidSchema.safeParse(req.query.runId);
      const run = runId.success
        ? getAreaSkipTraceRun(tid, runId.data, territoryId)
        : latestAreaSkipTraceRun(tid, territoryId);
      // A never-run area is not an error — the console renders an idle state.
      res.json({ areaId: territoryId, run, eligibleLeads: countAreaLeads(tid, territoryId) });
    } catch (error) { fail(res, error); }
  });

  app.get("/api/areas/:areaId/dialing-list", cap("lead.skip_trace.read"), (req, res) => {
    const tid = tenantOf(req, res); if (!tid) return;
    const territoryId = areaId(req, res, tid); if (!territoryId) return;
    const query = z.object({
      // Defaults to the FULL list: a blocked number is context a rep needs at
      // the door, and the UI renders it inert. ?dialableOnly=true is for
      // callers that genuinely only want the callable set.
      dialableOnly: z.enum(["true", "false"]).default("false"),
    }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: "Invalid query" });
    try {
      res.json(buildAreaDialingList({
        tenantId: tid, territoryId, dialableOnly: query.data.dialableOnly === "true",
      }));
    } catch (error) { fail(res, error); }
  });
}
