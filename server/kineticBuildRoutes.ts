// ── Kinetic 2026 builds - HTTP surface ───────────────────────────────────────
//
// Reads are open to any authenticated user (the field map needs them); every
// write is gated on scan.manage, the same capability that configures scan
// sources and spends provider budget.
//
// The whole surface answers 404 when KINETIC_2026_BUILDS=off, so it ships dark
// and is enabled per environment rather than by a deploy.

import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { Capability } from "@shared/capabilities";
import { getDefaultTenantId } from "./storage";
import {
  kinetic2026Enabled, MAX_CHUNK_ROWS, TARGET_COUNTY_FIPS,
  discardImport, finalizeImport, importedVintages, ingestChunk,
  listImports, openImport, revertVintage, setBlockDenominators,
} from "./fccImportStore";
import {
  buildGrid, buildSummary, buildWindowCount, buildWindowPins,
  evidenceHistory, getBuildStateById, promoteConfirmedBuilds, rankedBuilds,
  BUILD_WINDOW_ROW_CAP,
} from "./kineticBuildStore";
import {
  attestingVintageFor, expectedPublicationDate, vintageOf, yearCoverage,
  type FccVintageCode,
} from "@shared/fccVintage";
import { KINETIC_BUILD_CLASSES, TARGET_BUILD_YEAR } from "@shared/kineticBuild2026";
import { groupIntoTerritories, routeOrder } from "@shared/kineticBuildRanking";

type Middleware = (req: Request, res: Response, next: NextFunction) => unknown;
export interface KineticBuildRouteDeps {
  requireAuth: Middleware;
  requireCapability: (capability: Capability) => Middleware;
}

function tenantOf(req: Request): number {
  const value = Number((req as any).user?.tenantId ?? getDefaultTenantId());
  return Number.isInteger(value) && value > 0 ? value : 1;
}

/** Comma-separated query param to a string array, deduped and bounded. A
 *  filter list is user input that lands in an IN clause, so it is capped
 *  rather than trusted. */
function listParam(raw: unknown, max = 40): string[] | undefined {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const values = [...new Set(raw.split(",").map((v) => v.trim()).filter(Boolean))].slice(0, max);
  return values.length ? values : undefined;
}

const bboxSchema = z.object({
  minLat: z.coerce.number().min(-90).max(90),
  maxLat: z.coerce.number().min(-90).max(90),
  minLng: z.coerce.number().min(-180).max(180),
  maxLng: z.coerce.number().min(-180).max(180),
}).refine((b) => b.maxLat > b.minLat && b.maxLng > b.minLng, "bbox must be non-empty");

const openImportSchema = z.object({
  vintage: z.string().trim().min(2).max(4),
  stateFips: z.string().trim().regex(/^\d{2}$/).default("37"),
  providerIds: z.array(z.string().trim().min(1).max(20)).min(1).max(50),
  countyFips: z.array(z.string().trim().regex(/^\d{5}$/)).max(20).optional(),
  manifest: z.string().trim().min(1).max(2000),
  sourceUrl: z.string().trim().url().max(500).optional(),
  expectedChunkCount: z.number().int().positive().max(100_000),
  expectedRowCount: z.number().int().min(0).max(50_000_000),
});

const chunkSchema = z.object({
  chunkIndex: z.number().int().min(0),
  rows: z.array(z.object({
    locationId: z.string().trim().min(1).max(40),
    blockGeoid: z.string().trim().min(1).max(20),
    providerId: z.union([z.string(), z.number()]).transform(String),
    technology: z.coerce.number().int(),
    brCode: z.string().trim().min(1).max(2),
    maxDownMbps: z.coerce.number().int().min(0).max(1_000_000).nullish(),
    maxUpMbps: z.coerce.number().int().min(0).max(1_000_000).nullish(),
  })).max(MAX_CHUNK_ROWS),
});

const denominatorSchema = z.object({
  vintage: z.string().trim().min(2).max(4),
  counts: z.array(z.object({
    blockGeoid: z.string().trim().regex(/^\d{15}$/),
    totalResidentialLocations: z.number().int().min(0).max(100_000),
  })).max(20_000),
});

export function registerKineticBuildRoutes(app: Express, deps: KineticBuildRouteDeps): void {
  const { requireAuth, requireCapability } = deps;

  // The flag gate sits in front of everything, so a disabled deployment has no
  // surface at all rather than endpoints that authenticate and then refuse.
  const gate: Middleware = (_req, res, next) => {
    if (!kinetic2026Enabled()) return res.status(404).json({ error: "Kinetic 2026 builds layer is disabled" });
    return next();
  };
  const manage = [gate, requireAuth, requireCapability("scan.manage")];
  const read = [gate, requireAuth];

  // ── Status: what the data can and cannot prove ────────────────────────────
  // Deliberately the first endpoint. The layer's honest empty state is not
  // "no results" - it is "no published FCC filing can attest to 2026 yet",
  // and the UI has to be able to say so rather than showing a blank map.
  app.get("/api/kinetic-2026/status", ...read, (req: any, res: any) => {
    const tenantId = tenantOf(req);
    const vintages = importedVintages(tenantId);
    const attesting = attestingVintageFor(TARGET_BUILD_YEAR, vintages);
    // Partial and complete are DIFFERENT answers and both matter: a J26
    // holding proves real H1-2026 builds while saying nothing about H2, so
    // reporting only "not complete" would read as "no 2026 data" and hide six
    // months of genuine additions.
    const coverage = yearCoverage(vintages, TARGET_BUILD_YEAR);
    // The next filing that COULD attest, whether or not we hold it.
    const nextAttesting: FccVintageCode = `D${String(TARGET_BUILD_YEAR).slice(2)}` as FccVintageCode;
    res.json({
      targetYear: TARGET_BUILD_YEAR,
      importedVintages: vintages.map((code) => ({ code, asOf: vintageOf(code).asOf, label: vintageOf(code).label })),
      // False today and for months yet. See shared/fccVintage.ts.
      fccCanAttestTargetYear: attesting != null,
      attestingVintage: attesting,
      // partial = some real builds inside the year are provable.
      // complete = the list of them is exhaustive.
      coverage,
      nextAttestingVintage: nextAttesting,
      nextAttestingExpected: expectedPublicationDate(nextAttesting),
      explanation: coverage.complete
        ? `FCC filings cover all of ${TARGET_BUILD_YEAR}; this list of reported builds is exhaustive.`
        : coverage.partial
          ? `FCC filings prove ${TARGET_BUILD_YEAR} builds through ${coverage.coveredThrough}, but not beyond it. Reported builds after that date are missing until a later filing publishes.`
          : `No published FCC filing describes a date after ${TARGET_BUILD_YEAR - 1}-12-31, so FCC data cannot yet report a ${TARGET_BUILD_YEAR} build. Confirmed builds come from authorized address qualification; the FCC baseline supplies the proof they were unserved before ${TARGET_BUILD_YEAR}.`,
      counties: TARGET_COUNTY_FIPS,
      classifications: KINETIC_BUILD_CLASSES,
      summary: buildSummary(tenantId),
    });
  });

  // ── Import lifecycle ──────────────────────────────────────────────────────
  app.get("/api/kinetic-2026/imports", ...manage, (req: any, res: any) => {
    res.json({ imports: listImports(tenantOf(req)) });
  });

  app.post("/api/kinetic-2026/imports", ...manage, (req: any, res: any) => {
    const parsed = openImportSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    try {
      const job = openImport({
        ...parsed.data, tenantId: tenantOf(req), createdBy: req.user?.id ?? null,
      });
      res.status(201).json({ import: job });
    } catch (error: any) {
      res.status(400).json({ error: error?.message ?? "could not open import" });
    }
  });

  app.post("/api/kinetic-2026/imports/:id/chunks", ...manage, (req: any, res: any) => {
    const parsed = chunkSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid chunk" });
    try {
      res.json(ingestChunk(String(req.params.id), parsed.data.chunkIndex, parsed.data.rows as any));
    } catch (error: any) {
      // A digest conflict is a client bug, not a server fault - 409 so a
      // retrying uploader can tell it apart from a transient failure.
      const conflict = /already applied with different contents/.test(error?.message ?? "");
      res.status(conflict ? 409 : 400).json({ error: error?.message ?? "chunk rejected" });
    }
  });

  app.post("/api/kinetic-2026/imports/:id/finalize", ...manage, (req: any, res: any) => {
    try {
      res.json(finalizeImport(String(req.params.id)));
    } catch (error: any) {
      res.status(409).json({ error: error?.message ?? "could not finalize" });
    }
  });

  app.post("/api/kinetic-2026/imports/:id/discard", ...manage, (req: any, res: any) => {
    try {
      discardImport(String(req.params.id), typeof req.body?.reason === "string" ? req.body.reason.slice(0, 200) : undefined);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(400).json({ error: error?.message ?? "could not discard" });
    }
  });

  app.post("/api/kinetic-2026/denominators", ...manage, (req: any, res: any) => {
    const parsed = denominatorSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid body" });
    try {
      res.json({ updated: setBlockDenominators(tenantOf(req), parsed.data.vintage, parsed.data.counts) });
    } catch (error: any) {
      res.status(400).json({ error: error?.message ?? "could not set denominators" });
    }
  });

  // Reversal. Requires the vintage to be retyped, the same confirmation shape
  // the FCC purge and the reset-areas workflow already use for destructive ops.
  app.post("/api/kinetic-2026/vintages/:vintage/revert", ...manage, (req: any, res: any) => {
    const vintage = String(req.params.vintage);
    if (req.body?.confirm !== vintage) {
      return res.status(400).json({ error: `Refusing to revert: retype the vintage (${vintage}) in "confirm".` });
    }
    try {
      res.json(revertVintage(tenantOf(req), vintage));
    } catch (error: any) {
      res.status(400).json({ error: error?.message ?? "could not revert" });
    }
  });

  // ── Map reads ─────────────────────────────────────────────────────────────
  function filtersFrom(query: any) {
    return {
      classifications: listParam(query.classification) as any,
      confidences: listParam(query.confidence) as any,
      counties: listParam(query.county),
      cities: listParam(query.city),
      zips: listParam(query.zip),
      quarters: listParam(query.quarter),
      verificationAge: listParam(query.age),
      territoryId: query.territory != null && query.territory !== "" ? Number(query.territory) : null,
      assignedRepId: query.rep != null && query.rep !== "" ? Number(query.rep) : null,
      leadStatuses: listParam(query.status),
    };
  }

  /**
   * Bbox window. Counts BEFORE selecting rows, and when the window holds more
   * than the cap it returns NO pins plus `truncated` and the true count -
   * never a thinned sample dressed up as the whole window. The client's answer
   * to truncated is the grid tier below, which reports exact counts.
   */
  app.get("/api/kinetic-2026/map", ...read, (req: any, res: any) => {
    const bbox = bboxSchema.safeParse(req.query);
    if (!bbox.success) return res.status(400).json({ error: bbox.error.issues[0]?.message ?? "invalid bbox" });
    const tenantId = tenantOf(req);
    const window = { ...bbox.data, ...filtersFrom(req.query) };
    const total = buildWindowCount(tenantId, window);
    res.set("Cache-Control", "no-store");
    if (total > BUILD_WINDOW_ROW_CAP) {
      return res.json({ pins: [], truncated: true, windowCount: total, cap: BUILD_WINDOW_ROW_CAP });
    }
    res.json({ pins: buildWindowPins(tenantId, window), truncated: false, windowCount: total });
  });

  app.get("/api/kinetic-2026/map/grid", ...read, (req: any, res: any) => {
    const bbox = bboxSchema.safeParse(req.query);
    if (!bbox.success) return res.status(400).json({ error: bbox.error.issues[0]?.message ?? "invalid bbox" });
    const cell = Math.min(1, Math.max(0.001, Number(req.query.cell) || 0.01));
    res.set("Cache-Control", "no-store");
    res.json({ cells: buildGrid(tenantOf(req), { ...bbox.data, ...filtersFrom(req.query), cell }) });
  });

  app.get("/api/kinetic-2026/summary", ...read, (req: any, res: any) => {
    res.json({ summary: buildSummary(tenantOf(req), filtersFrom(req.query)) });
  });

  app.get("/api/kinetic-2026/ranked", ...read, (req: any, res: any) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    // Confirmed builds unless candidates are asked for BY NAME. A rep opening
    // "the list" gets proven doors; asking for likely_2026 is a deliberate act.
    const classifications = listParam(req.query.classification) as any;
    res.json({ builds: rankedBuilds(tenantOf(req), { limit, classifications }) });
  });

  app.get("/api/kinetic-2026/builds/:id/evidence", ...read, (req: any, res: any) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "invalid id" });
    const state = getBuildStateById(id);
    // Tenant scoping is an existence check too: a foreign id reads as absent
    // rather than as forbidden, so this cannot be used to probe other orgs.
    if (!state || state.tenantId !== tenantOf(req)) return res.status(404).json({ error: "not found" });
    res.json({ build: state, evidence: evidenceHistory(id) });
  });

  // ── Promotion and routing ─────────────────────────────────────────────────
  app.post("/api/kinetic-2026/promote", ...manage, (req: any, res: any) => {
    const dryRun = req.body?.apply !== true;
    res.json({ dryRun, ...promoteConfirmedBuilds(tenantOf(req), { dryRun, limit: Number(req.body?.limit) || undefined }) });
  });

  /** Group confirmed builds into walkable territories with a route order.
   *  A preview only - it proposes, it does not assign. */
  app.post("/api/kinetic-2026/territories/preview", ...manage, (req: any, res: any) => {
    const maxDoors = Math.min(500, Math.max(5, Number(req.body?.maxDoors) || 120));
    const maxRadiusM = Math.min(8_000, Math.max(100, Number(req.body?.maxRadiusM) || 1_200));
    const pool = rankedBuilds(tenantOf(req), { limit: 500, poolMax: 5_000 })
      .filter((b) => b.lat != null && b.lng != null)
      .map((b) => ({ id: b.id, lat: b.lat as number, lng: b.lng as number }));
    const byId = new Map(pool.map((d) => [d.id, d]));
    const clusters = groupIntoTerritories(pool, { maxDoors, maxRadiusM }).map((cluster) => ({
      ...cluster,
      route: routeOrder(cluster.doors.map((id) => byId.get(id)!)),
    }));
    res.json({ territories: clusters, doorCount: pool.length });
  });
}
