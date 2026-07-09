import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Layers, Loader2 } from "lucide-react";
import { STATE_COLORS } from "@shared/knock";

export type CoveragePin = {
  id: number;
  address: string;
  city: string;
  state: string;
  zip: string;
  lat: number | null;
  lng: number | null;
  leadStatus: string;
};

// A big, read-only clustered coverage map of every lead pin. Filtering happens
// in the parent (city/state) — this just renders whatever pins it's handed and
// refits the view to them. One Mapbox "map load" regardless of pin count.
export default function LeadsCoverageMap({ pins }: { pins: CoveragePin[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [styleMode, setStyleMode] = useState<"satellite" | "dark">("satellite");
  const appliedStyle = useRef<"satellite" | "dark">("satellite");
  const [epoch, setEpoch] = useState(0); // bumped after (re)adding layers → re-push pins

  const { data: mapConfig } = useQuery<{ token: string }>({
    queryKey: ["/api/config/map"],
    queryFn: () => apiRequest("GET", "/api/config/map").then(r => r.json()),
    staleTime: Infinity,
  });
  const token = mapConfig?.token;

  // Add the cluster source + layers to a fresh style (called on init and after
  // every setStyle, which wipes all sources/layers).
  const addLayers = useCallback((map: any) => {
    const mapboxgl = (window as any).mapboxgl;
    if (map.getSource("coverage")) return;
    map.addSource("coverage", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      cluster: true, clusterMaxZoom: 13, clusterRadius: 50,
    });
    map.addLayer({
      id: "cov-clusters", type: "circle", source: "coverage", filter: ["has", "point_count"], maxzoom: 13.5,
      paint: {
        "circle-color": ["step", ["get", "point_count"], "#22c55e", 10, "#f59e0b", 30, "#ef4444"],
        "circle-radius": ["step", ["get", "point_count"], 18, 10, 24, 30, 30],
        "circle-opacity": 0.9, "circle-stroke-width": 2.5, "circle-stroke-color": "#fff",
      },
    });
    map.addLayer({
      id: "cov-count", type: "symbol", source: "coverage", filter: ["has", "point_count"], maxzoom: 13.5,
      layout: { "text-field": "{point_count_abbreviated}", "text-size": 12 },
      paint: { "text-color": "#fff" },
    });
    map.addLayer({
      id: "cov-point", type: "circle", source: "coverage", filter: ["!", ["has", "point_count"]],
      paint: {
        // Shared palette — this was a drifted hardcoded copy of the pin colors.
        "circle-color": ["match", ["get", "status"],
          "prospect", STATE_COLORS.unworked, "contacted", STATE_COLORS.contacted,
          "interested", STATE_COLORS.interested, "follow_up", STATE_COLORS.follow_up,
          "sold", STATE_COLORS.sold, "not_interested", STATE_COLORS.not_interested,
          STATE_COLORS.unworked],
        "circle-radius": 6, "circle-stroke-width": 1.5, "circle-stroke-color": "rgba(255,255,255,0.9)",
      },
    });
    map.on("click", "cov-clusters", (e: any) => {
      const f = map.queryRenderedFeatures(e.point, { layers: ["cov-clusters"] });
      const cid = f[0]?.properties?.cluster_id;
      if (cid == null) return;
      (map.getSource("coverage") as any).getClusterExpansionZoom(cid, (err: any, z: number) => {
        if (err) return;
        map.easeTo({ center: f[0].geometry.coordinates, zoom: z + 1 });
      });
    });
    map.on("click", "cov-point", (e: any) => {
      const p = e.features?.[0]?.properties;
      const c = e.features?.[0]?.geometry?.coordinates?.slice();
      if (!p || !c) return;
      new mapboxgl.Popup({ offset: 12 })
        .setLngLat(c)
        .setHTML(`<div style="font:600 12px system-ui;color:#0f1420">${p.address}</div><div style="font:11px system-ui;color:#64748b">${p.city}, ${p.state} ${p.zip}</div>`)
        .addTo(map);
    });
    map.on("mouseenter", "cov-point", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "cov-point", () => { map.getCanvas().style.cursor = ""; });
  }, []);

  // ── Init map ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!token || !containerRef.current || mapRef.current) return;
    const mapboxgl = (window as any).mapboxgl;
    if (!mapboxgl) {
      const t = setInterval(() => { if ((window as any).mapboxgl) { clearInterval(t); setEpoch(e => e + 1); } }, 150);
      return () => clearInterval(t);
    }
    if (!document.getElementById("mapbox-css")) {
      const link = document.createElement("link");
      link.id = "mapbox-css";
      link.rel = "stylesheet";
      link.href = "https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.css";
      document.head.appendChild(link);
    }
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      center: [-80.41, 35.55],
      zoom: 9,
    });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl(), "bottom-right");
    setTimeout(() => map.resize(), 200);

    const onLoad = () => { addLayers(map); setReady(true); setEpoch(e => e + 1); };
    if (map.isStyleLoaded()) onLoad();
    else map.once("style.load", onLoad);

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => map.resize()) : null;
    if (ro && containerRef.current) ro.observe(containerRef.current);
    return () => { ro?.disconnect(); try { map.remove(); } catch {} mapRef.current = null; };
  }, [token, addLayers]);

  // ── Style toggle — re-add layers + re-push pins after the style reloads ─────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || appliedStyle.current === styleMode) return;
    appliedStyle.current = styleMode;
    map.once("style.load", () => { addLayers(map); setEpoch(e => e + 1); });
    map.setStyle(styleMode === "satellite"
      ? "mapbox://styles/mapbox/satellite-streets-v12"
      : "mapbox://styles/mapbox/dark-v11");
  }, [styleMode, ready, addLayers]);

  // ── Push pins + fit bounds whenever the filtered set changes ────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource("coverage");
    if (!src) return;
    const valid = pins.filter(p => p.lat && p.lng);
    src.setData({
      type: "FeatureCollection",
      features: valid.map(p => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lng, p.lat] },
        properties: { id: p.id, status: p.leadStatus, address: p.address, city: p.city, state: p.state, zip: p.zip },
      })),
    });
    if (valid.length > 0) {
      try {
        const b = new (window as any).mapboxgl.LngLatBounds();
        valid.forEach(p => b.extend([p.lng, p.lat]));
        map.fitBounds(b, { padding: 50, maxZoom: 14, duration: 600 });
      } catch {}
    }
  }, [pins, ready, epoch]);

  return (
    <div className="relative rounded-xl overflow-hidden border border-border" style={{ height: 420 }}>
      <div ref={containerRef} className="w-full h-full" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-card/60 text-xs text-muted-foreground gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading coverage map…
        </div>
      )}
      <div className="absolute top-3 left-3 bg-background/85 backdrop-blur px-2.5 py-1 rounded-full text-[11px] font-semibold text-foreground border border-border">
        {pins.filter(p => p.lat && p.lng).length.toLocaleString()} pins
      </div>
      <button
        onClick={() => setStyleMode(m => m === "satellite" ? "dark" : "satellite")}
        className="absolute top-3 right-3 bg-background/85 backdrop-blur px-2.5 py-1 rounded-full text-[11px] font-medium text-muted-foreground hover:text-foreground border border-border flex items-center gap-1"
      >
        <Layers className="w-3 h-3" /> {styleMode === "satellite" ? "Street" : "Satellite"}
      </button>
    </div>
  );
}
