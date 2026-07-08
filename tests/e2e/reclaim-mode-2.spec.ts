import { test, expect, type APIRequestContext } from "@playwright/test";
import { mintSession, loginAs } from "./helpers/auth";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * E2E — Reclaim MODE 2 (return-to-pool), the highest-risk flow.
 *
 * Seed via API (draw→assign is covered by its own spec): create leads inside a
 * known polygon, then POST /api/territories/assign-area to build a rep-colored
 * territory and assign the enclosed leads. Then drive the REAL reclaim modal in
 * the browser choosing "Return to pool", and assert over the API that every
 * enclosed lead is back in the overall pool (assignedRepId === null).
 *
 * Required data-testids (UI agent must add):
 *   [data-testid="territory-row-<id>"]      open the territory detail panel
 *   [data-testid="reclaim-btn"]             open the reclaim modal
 *   [data-testid="reclaim-mode-return_to_pool"]  the mode-2 radio/option
 *   [data-testid="reclaim-confirm"]         confirm the reclaim
 *   [data-testid="territory-status"]        shows the resulting status
 * ────────────────────────────────────────────────────────────────────────────
 */

// A small box near Rockwell NC ([lng,lat] — matches how polygons are stored).
const CENTER = { lng: -80.35, lat: 35.6 };
const POLYGON: [number, number][] = [
  [CENTER.lng - 0.02, CENTER.lat - 0.02],
  [CENTER.lng + 0.02, CENTER.lat - 0.02],
  [CENTER.lng + 0.02, CENTER.lat + 0.02],
  [CENTER.lng - 0.02, CENTER.lat + 0.02],
];

let sessionId: string;
let repId: number;
let territoryId: number;
let seededLeadIds: number[] = [];

// An authenticated request context (session in the x-session-id header).
function authed(request: APIRequestContext) {
  return {
    get: (url: string) => request.get(url, { headers: { "x-session-id": sessionId } }),
    post: (url: string, data: unknown) =>
      request.post(url, { headers: { "x-session-id": sessionId }, data }),
  };
}

test.beforeAll(async ({ request }) => {
  ({ sessionId } = await mintSession(request));
  const api = authed(request);

  // A rep (team member) to own the area.
  const team = await (await api.get("/api/team")).json();
  const rep = (Array.isArray(team) ? team : team.members ?? []).find(
    (m: any) => m.role === "rep"
  );
  expect(rep, "seed needs at least one rep team member").toBeTruthy();
  repId = rep.id;

  // Seed three leads inside the polygon, starting unassigned.
  for (let i = 0; i < 3; i++) {
    const res = await api.post("/api/leads", {
      address: `${100 + i} E2E Reclaim St`,
      city: "Rockwell",
      state: "NC",
      zip: "28138",
      lat: CENTER.lat + (i - 1) * 0.001,
      lng: CENTER.lng + (i - 1) * 0.001,
      fiberStatus: "unknown",
    });
    expect(res.ok()).toBeTruthy();
    seededLeadIds.push((await res.json()).id);
  }

  // Draw→assign: creates the territory and assigns the enclosed leads to the rep.
  const assign = await api.post("/api/territories/assign-area", {
    polygon: POLYGON,
    repId,
    name: "E2E Reclaim Area",
  });
  expect(assign.ok()).toBeTruthy();
  territoryId = (await assign.json()).territory?.id ?? (await assign.json()).id;

  // Sanity: leads are now assigned to the rep before we reclaim.
  const before = await (await api.get(`/api/leads/${seededLeadIds[0]}`)).json();
  expect(before.assignedRepId).toBe(repId);
});

test("reclaim mode 2 returns every enclosed lead to the overall pool", async ({
  page,
  request,
}) => {
  await loginAs(page, sessionId);
  await page.goto("/map");

  // Open the territory, launch the reclaim modal, pick mode 2, confirm.
  await page.getByTestId(`territory-row-${territoryId}`).click();
  await page.getByTestId("reclaim-btn").click();
  await page.getByTestId("reclaim-mode-return_to_pool").click();
  await page.getByTestId("reclaim-confirm").click();

  // UI reflects the new status.
  await expect(page.getByTestId("territory-status")).toHaveText(/unassigned/i);

  // Source of truth: every seeded lead is back in the pool (assignedRepId null).
  const api = authed(request);
  for (const id of seededLeadIds) {
    const lead = await (await api.get(`/api/leads/${id}`)).json();
    expect(lead.assignedRepId, `lead ${id} should be back in the pool`).toBeNull();
  }

  // And the territory itself is unassigned, not deleted (history preserved).
  const territory = await (await api.get(`/api/territories/${territoryId}`)).json();
  expect(territory.status).toBe("unassigned");
});
