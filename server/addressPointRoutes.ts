// ── Address-point routes ────────────────────────────────────────────────────
//
// Three endpoints over the county E911 import (see addressPointStore.ts):
//
//   GET  /api/address-points            viewport feed for the house-number layer
//   POST /api/leads/create-from-selection   lasso a block, get a lead per door
//   POST /api/admin/address-points/import   pull a county from NC OneMap
//
// The create route is the interesting one, and the thing it must never do is
// half-succeed silently. See its own notes below.

import type { Express } from "express";
import {
  addressPointsInBbox,
  addressPointsInRing,
  countAddressPoints,
  streetLabelsInBbox,
} from "./addressPointStore";
import { importCountyAddressPoints } from "./addressPointImport";
import { storage } from "./storage";
import { rawDb } from "./db";

/** Ceiling on how many doors one lasso may create in a single action.
 *
 *  Not a payload limit - the ring is what travels, and it is tiny. This is a
 *  BLAST-RADIUS limit: a rep who lassos an entire county by accident should be
 *  told the selection is too big, not discover it after 40,000 leads land in
 *  their org and have to be unpicked by hand. */
const MAX_CREATE_FROM_SELECTION = 2000;

/** Matches the existing assign-selection guard so one lasso cannot be legal
 *  for assigning and illegal for creating. */
const MAX_RING_POINTS = 5000;

function parseBbox(raw: unknown): [number, number, number, number] | null {
  if (typeof raw !== "string") return null;
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts;
  if (west >= east || south >= north) return null;
  if (Math.abs(north) > 90 || Math.abs(south) > 90) return null;
  return [west, south, east, north];
}

function parseRing(raw: unknown): Array<[number, number]> | null {
  if (!Array.isArray(raw) || raw.length < 3 || raw.length > MAX_RING_POINTS) return null;
  const ring: Array<[number, number]> = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) return null;
    const lng = Number(p[0]), lat = Number(p[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    ring.push([lng, lat]);
  }
  return ring;
}

export function registerAddressPointRoutes(
  app: Express,
  deps: {
    requireAuth: any;
    requireTeamLead: any;
    requireAdmin: any;
  },
): void {
  const { requireAuth, requireTeamLead, requireAdmin } = deps;

  // ── Viewport feed for the house-number layer ─────────────────────────────
  //
  // Returns a bare [lng, lat, number] triple per point rather than objects.
  // At ~900 points per suburban viewport the key names would be most of the
  // payload, and this endpoint fires on every pan.
  app.get("/api/address-points", requireAuth, (req: any, res: any) => {
    const bbox = parseBbox(req.query?.bbox);
    if (!bbox) {
      return res.status(400).json({ error: "bbox must be west,south,east,north" });
    }
    const [west, south, east, north] = bbox;

    // A viewport spanning more than ~0.5 degrees is zoomed far past the point
    // where house numbers are legible. Refuse rather than serve a huge
    // response the client will only throw away.
    if (east - west > 0.5 || north - south > 0.5) {
      return res.json({ points: [], truncated: true, reason: "zoomed_out" });
    }

    const { points, truncated } = addressPointsInBbox(west, south, east, north);
    res.json({
      points: points.map((p) => [p.lng, p.lat, p.houseNumber ?? ""]),
      // Street names ride along on the same request. They come from the same
      // rows, so splitting them into a second endpoint would double the round
      // trips on every pan to re-read data already in hand.
      streets: truncated ? [] : streetLabelsInBbox(west, south, east, north),
      truncated,
    });
  });

  // ── Lasso a block, create a lead per door ────────────────────────────────
  app.post("/api/leads/create-from-selection", requireTeamLead, async (req: any, res: any) => {
    const user = req.user;
    const ring = parseRing(req.body?.polygon);
    if (!ring) {
      return res.status(400).json({
        error: `polygon must be 3 to ${MAX_RING_POINTS.toLocaleString()} [lng, lat] points`,
      });
    }

    const { points } = addressPointsInRing(ring, MAX_CREATE_FROM_SELECTION + 1);
    if (points.length > MAX_CREATE_FROM_SELECTION) {
      return res.status(400).json({
        error: `That outline covers ${points.length.toLocaleString()}+ doors - at most ${MAX_CREATE_FROM_SELECTION.toLocaleString()} at once. Draw a smaller area.`,
        code: "SELECTION_TOO_LARGE",
        count: points.length,
      });
    }
    if (points.length === 0) {
      return res.json({ created: 0, existing: 0, total: 0, addressData: countAddressPoints() > 0 });
    }

    const tenantId = user?.tenantId ?? undefined;
    const repId = req.body?.repId == null ? null : Number(req.body.repId);

    // createLead is idempotent - it returns the EXISTING row when the
    // canonical key already has a lead. That is what makes lassoing an
    // overlapping block safe, and it is also why "created" has to be counted
    // by comparing ids rather than by counting calls: every call succeeds,
    // but most of them may have changed nothing.
    let created = 0, existing = 0;
    const seen = new Set<number>();
    const createdLeads: number[] = [];

    // ONE transaction for the whole selection.
    //
    // Without this each createLead is its own implicit transaction, so a
    // 2,000-door lasso costs 2,000 fsyncs - the dominant term by far, and the
    // difference between "instant" and "the app froze". better-sqlite3 is
    // synchronous, so the whole batch commits or none of it does, which is
    // also the behaviour a rep expects: a lasso either took or it did not.
    const runBatch = rawDb.transaction(() => {
      for (const p of points) {
        const prior = storage.findLeadByAddress(
          tenantId ?? null, p.street, p.city ?? "", p.state, p.zip ?? "",
        );
        if (prior) { existing++; seen.add(prior.id); continue; }

        const lead = storage.createLead({
          address: p.street,
          city: p.city ?? "",
          state: p.state,
          zip: p.zip ?? "",
          lat: p.lat,
          lng: p.lng,
          leadStatus: "prospect",
          ...(repId != null && Number.isInteger(repId) && repId > 0
            ? { assignedRepId: repId, assignedBy: user?.email ?? "lasso", assignmentSource: "lasso_create" }
            : {}),
          ...(tenantId != null ? { tenantId } : {}),
        } as any);

        // Two points in one selection can normalise to the same canonical key
        // (a duplex listed twice in the E911 file). createLead returns the same
        // row for both; counting it twice would report more doors than exist.
        if (seen.has(lead.id)) { existing++; continue; }
        seen.add(lead.id);
        created++;
        createdLeads.push(lead.id);
      }
    });
    runBatch();

    res.json({ created, existing, total: points.length, leadIds: createdLeads.slice(0, 500) });
  });

  // ── Admin: import a county ───────────────────────────────────────────────
  app.post("/api/admin/address-points/import", requireAdmin, async (req: any, res: any) => {
    const county = String(req.body?.county ?? "").trim();
    if (!/^[A-Za-z .'-]{2,40}$/.test(county)) {
      return res.status(400).json({ error: "county must be a county name, e.g. Rowan" });
    }
    try {
      const result = await importCountyAddressPoints(county);
      res.json({ ...result, totalStored: countAddressPoints() });
    } catch (e: any) {
      // Surface the upstream reason. An import that fails silently looks
      // exactly like a county with no addresses.
      res.status(502).json({ error: String(e?.message ?? e), code: "IMPORT_FAILED" });
    }
  });

  app.get("/api/admin/address-points/status", requireAdmin, (_req: any, res: any) => {
    res.json({ totalStored: countAddressPoints() });
  });
}
