// Tapping an area on the map to manage it.
//
// The area panel — rename, recolour, per-rep removal, Pull Back Area — has been
// reachable from exactly one place: a row in the sidebar list. There was no
// click handler on any territory layer at all, so tapping the polygon you are
// standing in front of did nothing, and a manager who could SEE the area still
// had to find it by name in a list to take it back. That is the whole reason
// "I can't pull the area back, I'm not seeing it" was true while the unassign
// and reclaim endpoints worked perfectly.
//
// This module owns the decision part so it can be tested without a live GL
// context: given whatever mapbox reports under the finger, which area did the
// manager mean?

/** Layer ids are `territory-<id>`; the outline layer adds `-outline`. */
export const TERRITORY_LAYER_PREFIX = "territory-";

export function territoryLayerId(territoryId: number): string {
  return `${TERRITORY_LAYER_PREFIX}${territoryId}`;
}

/** `territory-42` → 42, `territory-42-outline` → 42, anything else → null. */
export function territoryIdFromLayer(layerId: unknown): number | null {
  if (typeof layerId !== "string" || !layerId.startsWith(TERRITORY_LAYER_PREFIX)) return null;
  const rest = layerId.slice(TERRITORY_LAYER_PREFIX.length).replace(/-outline$/, "");
  if (!/^\d+$/.test(rest)) return null;
  const id = Number(rest);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export interface QueriedFeature {
  layer?: { id?: unknown } | null;
  properties?: { tid?: unknown } | null;
}

/**
 * The distinct areas under the tap, nearest-drawn first.
 *
 * mapbox returns one feature per matching layer, so a single area with a fill
 * AND an outline layer comes back twice — de-duplicating by territory id is what
 * stops a lone area from opening the "which one did you mean?" picker.
 *
 * `properties.tid` is preferred because that is what the source actually carries;
 * the layer id is the fallback for the outline layer, whose feature is the same
 * geometry.
 */
export function territoriesUnderTap(features: readonly QueriedFeature[] | null | undefined): number[] {
  if (!features?.length) return [];
  const seen: number[] = [];
  for (const f of features) {
    const fromProps = typeof f?.properties?.tid === "number" ? f.properties.tid : null;
    const id = fromProps ?? territoryIdFromLayer(f?.layer?.id);
    if (id != null && id > 0 && !seen.includes(id)) seen.push(id);
  }
  return seen;
}

export type TapOutcome =
  | { kind: "none" }
  | { kind: "select"; territoryId: number }
  | { kind: "choose"; territoryIds: number[] };

/**
 * What a tap means.
 *
 * Overlapping areas are the case worth being careful about: silently opening
 * whichever polygon happens to be drawn on top is how a manager pulls back the
 * wrong territory. When more than one is under the finger the caller shows a
 * picker instead of guessing.
 *
 * `manageable` filters to areas this user may actually act on BEFORE the count
 * is taken, so a manager tapping their own area that happens to sit under
 * another team's does not get a picker listing an area they cannot touch — and
 * an unauthorised tap resolves to nothing rather than opening a panel whose
 * buttons would all 403.
 */
export function resolveTerritoryTap(
  features: readonly QueriedFeature[] | null | undefined,
  manageable?: (territoryId: number) => boolean,
): TapOutcome {
  const ids = territoriesUnderTap(features).filter((id) => (manageable ? manageable(id) : true));
  if (ids.length === 0) return { kind: "none" };
  if (ids.length === 1) return { kind: "select", territoryId: ids[0] };
  return { kind: "choose", territoryIds: ids };
}

/** The layers a tap should hit-test, given which are currently on the map.
 *  Querying a layer that does not exist throws and would kill the handler, so
 *  the caller filters by presence first. */
export function territoryTapLayers(
  territoryIds: readonly number[],
  hasLayer: (id: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const id of territoryIds) {
    for (const layerId of [territoryLayerId(id), `${territoryLayerId(id)}-outline`]) {
      try {
        if (hasLayer(layerId)) out.push(layerId);
      } catch {
        /* map mid-teardown — skip */
      }
    }
  }
  return out;
}
