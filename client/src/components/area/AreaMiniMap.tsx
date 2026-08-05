// ── Area Console mini-map: the ground this page is about, finally drawn ───────
//
// The Map tab used to be a paragraph explaining that the Field Map is where the
// boundary lives, plus a link. The polygon was in the database the whole time;
// the single-area progress endpoint just never returned it. It does now, and
// this component draws it: one non-interactive-by-default Mapbox canvas, the
// area's own stored colour, fitted to its bounds — the Bump/Fi "here is your
// zone" pattern rather than a promise that another screen could show it.
//
// Failure states mirror MapView's taxonomy ("library" = CDN never arrived,
// "token" = server has no MAPBOX_TOKEN) but degrade quietly: this is a preview,
// not the working map, so an unavailable preview renders the same guidance the
// old placeholder gave instead of an alarm.

import { useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { territoryPaint } from "@/lib/territoryStyle";
import { colorForRep } from "@shared/repColors";

interface AreaMiniMapProps {
  polygon: [number, number][];
  color?: string | null;
  status?: string | null;
  repId?: number | null;
  /** Test hook + aria label subject. */
  areaName: string;
}

export function AreaMiniMap({ polygon, color, status, repId, areaName }: AreaMiniMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    if (!Array.isArray(polygon) || polygon.length < 3) {
      setState("unavailable");
      return;
    }
    let cancelled = false;

    const init = (err?: Error) => {
      if (cancelled) return;
      if (err || typeof (window as any).mapboxgl === "undefined") {
        setState("unavailable");
        return;
      }
      apiRequest("GET", "/api/config/map")
        .then((r) => r.json())
        .then((d: { token?: string }) => {
          if (cancelled) return;
          if (!d?.token || !containerRef.current) {
            setState("unavailable");
            return;
          }
          const mapboxgl = (window as any).mapboxgl;
          mapboxgl.accessToken = d.token;

          // The ring is stored OPEN (last point ≠ first); GeoJSON wants closed.
          const ring = [...polygon, polygon[0]];
          let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
          for (const [x, y] of polygon) {
            if (x < w) w = x; if (x > e) e = x;
            if (y < s) s = y; if (y > n) n = y;
          }

          const map = new mapboxgl.Map({
            container: containerRef.current,
            style: "mapbox://styles/mapbox/satellite-streets-v12",
            bounds: [[w, s], [e, n]],
            fitBoundsOptions: { padding: 32 },
            // A preview, not a workspace: pan/zoom stay available for a closer
            // look, but rotation gestures just fight the case.
            dragRotate: false,
            pitchWithRotate: false,
            attributionControl: true,
            cooperativeGestures: true,
          });
          mapRef.current = map;

          map.on("load", () => {
            if (cancelled) return;
            // The SAME paint rule as the Field Map (lib/territoryStyle) — two
            // screens must not disagree about what this area looks like.
            const paint = territoryPaint({ color, status }, colorForRep(repId ?? null));
            map.addSource("area", {
              type: "geojson",
              data: { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} },
            });
            map.addLayer({
              id: "area-fill",
              type: "fill",
              source: "area",
              paint: { "fill-color": paint.fillColor, "fill-opacity": paint.fillOpacity },
            });
            map.addLayer({
              id: "area-line",
              type: "line",
              source: "area",
              paint: {
                "line-color": paint.lineColor,
                "line-width": paint.lineWidth,
                "line-opacity": paint.lineOpacity,
                ...(paint.lineDasharray ? { "line-dasharray": paint.lineDasharray } : {}),
              },
            });
            setState("ready");
          });
          map.on("error", () => {
            // A style/tile failure after init leaves a grey void — call it what
            // it is rather than showing an empty square as if it were the area.
            // Functional update: the closure's `state` is frozen at mount.
            if (!cancelled) setState((prev) => (prev === "ready" ? prev : "unavailable"));
          });
        })
        .catch(() => {
          if (!cancelled) setState("unavailable");
        });
    };

    const onReady = (window as any).__onMapboxReady;
    if (typeof onReady === "function") onReady(init);
    else init(new Error("mapbox loader missing"));

    return () => {
      cancelled = true;
      try { mapRef.current?.remove(); } catch { /* mid-teardown */ }
      mapRef.current = null;
    };
    // The polygon identity is stable per area load; re-running on every render
    // would tear the map down for reference-equal props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(polygon), color, status, repId]);

  if (state === "unavailable") return null;

  return (
    <div className="relative overflow-hidden rounded-xl border border-border" data-testid="area-mini-map">
      {state === "loading" && <Skeleton className="absolute inset-0 z-10 rounded-xl" />}
      <div
        ref={containerRef}
        role="img"
        aria-label={`Boundary of ${areaName}`}
        className="h-64 w-full md:h-80"
      />
    </div>
  );
}

export default AreaMiniMap;
