import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LeadKnockSheet, type SheetLead } from "@/components/LeadKnockSheet";
import { iconImageConcatExpression, registerPinImages } from "@/lib/statusIcons";
import { pinDisplayState, OUTCOME_TO_STATUS, type KnockOutcome } from "@shared/knock";
import { toLeadMapStatus, type LeadMapStatus } from "@shared/statusConfig";
import type { NoteSaveResult } from "@/lib/leadNotes";

declare const mapboxgl: any;

export interface LeadMapLead extends SheetLead {
  lat: number;
  lng: number;
  notes?: string | null;
}

interface LeadMapProps {
  leads: LeadMapLead[];
  /** Pass the token returned by /api/config/map, or VITE_MAPBOX_TOKEN in a standalone app. */
  mapboxToken: string;
  onDispositionChange: (leadId: number, outcome: KnockOutcome) => Promise<void> | void;
  onSaveNote: (leadId: number, note: string, baseUpdatedAt: string | null) => Promise<NoteSaveResult>;
  center?: [number, number];
  className?: string;
  styleUrl?: string;
}

type LeadFeature = {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: { id: number; status: LeadMapStatus; address: string };
};

type LeadCollection = { type: "FeatureCollection"; features: LeadFeature[] };

const SOURCE_ID = "lead-map-source";
const CLUSTERS_ID = "lead-map-clusters";
const COUNT_ID = "lead-map-cluster-count";
const PINS_ID = "lead-map-pins";

function featureFor(lead: LeadMapLead): LeadFeature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lead.lng, lead.lat] },
    properties: {
      id: lead.id,
      status: toLeadMapStatus(pinDisplayState(lead)),
      address: lead.address,
    },
  };
}

/**
 * Reusable native-layer map. For API-backed use, fetch your slim pin collection
 * from `/api/leads/map?fields=pin` and pass it as `leads`; never create a Marker
 * per lead.
 */
export function LeadMap({
  leads,
  mapboxToken,
  onDispositionChange,
  onSaveNote,
  center = [-80.2534, 35.8240],
  className,
  styleUrl = "mapbox://styles/mapbox/satellite-streets-v12",
}: LeadMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const dataRef = useRef<LeadCollection>({ type: "FeatureCollection", features: [] });
  const featureByIdRef = useRef(new Map<number, LeadFeature>());
  const leadById = useMemo(() => new Map(leads.map((lead) => [lead.id, lead])), [leads]);
  const leadByIdRef = useRef(leadById);
  const [selectedLead, setSelectedLead] = useState<LeadMapLead | null>(null);

  useEffect(() => { leadByIdRef.current = leadById; }, [leadById]);

  useEffect(() => {
    const features = leads.filter((lead) => Number.isFinite(lead.lat) && Number.isFinite(lead.lng)).map(featureFor);
    dataRef.current = { type: "FeatureCollection", features };
    featureByIdRef.current = new Map(features.map((feature) => [feature.properties.id, feature]));
    const source = mapRef.current?.getSource(SOURCE_ID);
    source?.setData(dataRef.current);
  }, [leads]);

  useEffect(() => {
    if (!containerRef.current || !mapboxToken || mapRef.current) return;
    // In this repository the token comes from GET /api/config/map. In a standalone
    // Vite app, plug VITE_MAPBOX_TOKEN into the mapboxToken prop here.
    mapboxgl.accessToken = mapboxToken;
    const map = new mapboxgl.Map({ container: containerRef.current, style: styleUrl, center, zoom: 12 });
    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl(), "top-right");

    const onLoad = async () => {
      await registerPinImages(map);
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: dataRef.current,
        cluster: true,
        clusterRadius: 50,
        clusterMaxZoom: 13,
      });
      map.addLayer({
        id: CLUSTERS_ID,
        type: "circle",
        source: SOURCE_ID,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": ["step", ["get", "point_count"], "#0F766E", 25, "#115E59", 100, "#134E4A"],
          "circle-radius": ["step", ["get", "point_count"], 18, 25, 24, 100, 31],
          "circle-stroke-color": "#FFFFFF",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: COUNT_ID,
        type: "symbol",
        source: SOURCE_ID,
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["DIN Offc Pro Medium", "Arial Unicode MS Bold"],
          "text-size": 13,
          "text-allow-overlap": true,
        },
        paint: { "text-color": "#FFFFFF" },
      });
      map.addLayer({
        id: PINS_ID,
        type: "symbol",
        source: SOURCE_ID,
        filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": iconImageConcatExpression(),
          "icon-anchor": "bottom",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 12, 0.55, 17, 0.9, 20, 1.1],
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      });

      map.on("click", CLUSTERS_ID, (event: any) => {
        const cluster = map.queryRenderedFeatures(event.point, { layers: [CLUSTERS_ID] })[0];
        if (!cluster) return;
        const clusterId = cluster.properties.cluster_id;
        map.getSource(SOURCE_ID).getClusterExpansionZoom(clusterId, (error: Error | null, zoom: number) => {
          if (!error) map.easeTo({ center: cluster.geometry.coordinates, zoom });
        });
      });
      map.on("click", PINS_ID, (event: any) => {
        const id = Number(event.features?.[0]?.properties?.id);
        setSelectedLead(leadByIdRef.current.get(id) ?? null);
      });
      for (const layer of [CLUSTERS_ID, PINS_ID]) {
        map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
      }
    };
    map.once("load", () => { void onLoad(); });
    return () => { map.remove(); mapRef.current = null; };
  }, [center, mapboxToken, styleUrl]);

  const changeDisposition = useCallback((outcome: KnockOutcome) => {
    if (!selectedLead) return;
    const leadId = selectedLead.id;
    const feature = featureByIdRef.current.get(leadId);
    const previousStatus = feature?.properties.status;
    const nextLeadStatus = OUTCOME_TO_STATUS[outcome] ?? selectedLead.leadStatus;
    const optimisticLead: LeadMapLead = {
      ...selectedLead,
      leadStatus: nextLeadStatus,
      visited: true,
      lastOutcome: outcome,
      lastKnockedAt: new Date().toISOString(),
    };
    if (feature) {
      feature.properties.status = toLeadMapStatus(pinDisplayState(optimisticLead));
      mapRef.current?.getSource(SOURCE_ID)?.setData(dataRef.current);
    }
    setSelectedLead(optimisticLead);
    Promise.resolve(onDispositionChange(leadId, outcome)).catch(() => {
      if (feature && previousStatus) {
        feature.properties.status = previousStatus;
        mapRef.current?.getSource(SOURCE_ID)?.setData(dataRef.current);
      }
      setSelectedLead(selectedLead);
    });
  }, [onDispositionChange, selectedLead]);

  return (
    <div className={className} style={{ position: "relative", width: "100%", height: "100%", minHeight: 420 }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} aria-label="Fiber lead map" />
      <LeadKnockSheet
        lead={selectedLead}
        onKnock={changeDisposition}
        onSaveNote={onSaveNote}
        onClose={() => setSelectedLead(null)}
      />
    </div>
  );
}

export default LeadMap;
