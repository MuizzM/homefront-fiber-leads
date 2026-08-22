// ── Nearest doors ─────────────────────────────────────────────────────────────
// PURE and framework-free. The doors a rep should walk to next, ordered by the
// distance from where they are standing. Same rule as nearestUnworkedLead
// (shared/knock.ts): a door is "open" when it is unworked or Not Home, and
// ties inside half a metre prefer the better lead score, then the lower id,
// so two pins on one parcel never swap places between renders.
//
// Distance is only meaningful near the rep: past `maxMeters` the strip says
// nothing rather than suggest a door across town. "At door" under 60 m (the
// ProximityChip threshold, inside typical lot-width GPS noise).
import { haversineMeters, pinDisplayState, type LatLng, type RoutablePin } from "./knock";

export const NEAREST_DOORS_LIMIT = 3;
export const NEAREST_DOORS_MAX_METERS = 800;
export const AT_DOOR_METERS = 60;

export interface RankedDoor<P extends RoutablePin = RoutablePin> {
  pin: P;
  meters: number;
  atDoor: boolean;
}

export function isOpenDoor(p: RoutablePin): boolean {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return false;
  if (p.doNotKnock) return false; // the resident asked us not to return
  const st = pinDisplayState(p);
  return st === "unworked" || st === "not_home";
}

export function rankNearestDoors<P extends RoutablePin>(
  from: LatLng,
  pins: readonly P[],
  opts: { limit?: number; maxMeters?: number; excludeIds?: ReadonlySet<number> } = {},
): RankedDoor<P>[] {
  const limit = opts.limit ?? NEAREST_DOORS_LIMIT;
  const maxMeters = opts.maxMeters ?? NEAREST_DOORS_MAX_METERS;
  const exclude = opts.excludeIds ?? new Set<number>();
  const ranked: RankedDoor<P>[] = [];
  for (const p of pins) {
    if (exclude.has(p.id) || !isOpenDoor(p)) continue;
    const meters = haversineMeters(from, p);
    if (meters > maxMeters) continue;
    ranked.push({ pin: p, meters, atDoor: meters <= AT_DOOR_METERS });
  }
  ranked.sort((a, b) => {
    if (Math.abs(a.meters - b.meters) > 0.5) return a.meters - b.meters;
    const as = a.pin.leadScore ?? 0, bs = b.pin.leadScore ?? 0;
    if (as !== bs) return bs - as;
    return a.pin.id - b.pin.id;
  });
  return ranked.slice(0, limit);
}
