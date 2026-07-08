// Ray-cast point-in-polygon — the ONE enclosure test shared by assign-area,
// reclaim, territory progress, and (conceptually) the client lasso. Polygon
// points are [lng, lat] to match how territories are stored.
export function pointInPolygon(lat: number, lng: number, poly: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) hit = !hit;
  }
  return hit;
}
