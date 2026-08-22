// ── Neighborhood sweep: the manager surface ─────────────────────────────────
//
//   GET  /api/sweep/neighborhoods   ranked cells: fresh leads nobody has knocked
//                                   first, then the cells still being flooded
//   GET  /api/sweep/state           switch, last cycle, cell phases, 24 h economy
//   POST /api/sweep/cycle           admin: run one cycle now (control worker only;
//                                   on an HTTP worker it only reports that)
//
// Read-only except the admin cycle trigger, which enqueues through the same
// durable engine the producer uses (no extra proxy path). All tenant-scoped.
import type { Express } from "express";
import { listNeighborhoods, runSweepCycle, sweepSummary } from "./neighborhoodSweep";
import { thisProcessConsumesScanRuns } from "./scanConsumeRole";
import { getDefaultTenantId } from "./storage";

export function registerNeighborhoodSweepRoutes(app: Express, deps: { requireManager: any; requireAdmin: any }): void {
  const tid = (req: any): number | null => req.user?.tenantId ?? getDefaultTenantId();

  app.get("/api/sweep/neighborhoods", deps.requireManager, (req: any, res) => {
    const tenantId = tid(req);
    if (tenantId == null) return res.status(400).json({ error: "No tenant" });
    const state = typeof req.query.state === "string" && /^[A-Za-z]{2}$/.test(req.query.state) ? req.query.state.toUpperCase() : undefined;
    const phase = typeof req.query.phase === "string" && ["flood", "probe", "parked", "complete"].includes(req.query.phase) ? req.query.phase : undefined;
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 60;
    res.json({ neighborhoods: listNeighborhoods(tenantId, { state, phase, limit }) });
  });

  app.get("/api/sweep/state", deps.requireManager, (req: any, res) => {
    const tenantId = tid(req);
    if (tenantId == null) return res.status(400).json({ error: "No tenant" });
    res.json(sweepSummary(tenantId));
  });

  app.post("/api/sweep/cycle", deps.requireAdmin, async (req: any, res) => {
    const tenantId = tid(req);
    if (tenantId == null) return res.status(400).json({ error: "No tenant" });
    if (process.env.NEIGHBORHOOD_SWEEP !== "on") return res.status(409).json({ error: "NEIGHBORHOOD_SWEEP is off on this deployment" });
    // Under the cluster only the control worker consumes runs; an HTTP worker
    // must not start worker loops on its request loop (PR #170). The periodic
    // tick on the control worker is the normal path; this is the admin nudge.
    if (!thisProcessConsumesScanRuns()) return res.status(409).json({ error: "Cycle runs on the control worker; it ticks on its own interval" });
    try {
      const result = await runSweepCycle(tenantId);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: String(e?.message ?? e).slice(0, 200) });
    }
  });
}
