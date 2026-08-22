// ── Live proximity for the themed outcome surfaces ────────────────────────────
// The map card (LeadKnockSheet) has carried a live rep-to-door distance chip;
// this is the same contract for the THEMED sheets (OutcomeSheet on Today,
// Follow-ups, Leads, Property Detail), restyled onto semantic tokens instead of
// the map's dark glass. Same honesty gates as the map chip: render only when
// the door has coordinates, a GPS fix arrived, and the fix is tight enough
// that the number is not fiction (accuracy <= 200 m). "At door" under 60 m —
// inside typical lot-width GPS noise. Display only: the server keeps verifying
// knock distance from its own evidence (shared/geoVerify.ts), never from this.
import { useEffect, useRef, useState } from "react";
import { LocateFixed } from "lucide-react";
import { captureFieldFix } from "@/lib/geoFix";
import { haversineMeters, distanceHint } from "@shared/knock";

interface RepFix { lat: number; lng: number; accuracy: number | null }

export function useLiveProximity(leadId: number | null | undefined) {
  const [repFix, setRepFix] = useState<RepFix | null>(null);
  const [locating, setLocating] = useState(false);
  const fixLeadRef = useRef<number | null>(null);
  const requestFix = (id: number) => {
    fixLeadRef.current = id;
    setLocating(true);
    void captureFieldFix(3500).then(f => {
      if (fixLeadRef.current !== id) return; // sheet swapped doors mid-fix
      setLocating(false);
      setRepFix(f.repLat != null && f.repLng != null
        ? { lat: f.repLat, lng: f.repLng, accuracy: f.gpsAccuracy }
        : null);
    });
  };
  useEffect(() => {
    if (leadId == null) return;
    requestFix(leadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);
  return { repFix, locating, requestFix };
}

export function ProximityChip({ leadId, lat, lng, repFix, locating, onRefresh }: {
  leadId: number;
  lat: number | null | undefined;
  lng: number | null | undefined;
  repFix: RepFix | null;
  locating: boolean;
  onRefresh: (leadId: number) => void;
}) {
  if (lat == null || lng == null) return null;
  if (!repFix) return null;
  if (repFix.accuracy != null && repFix.accuracy > 200) return null;
  const d = haversineMeters({ lat: repFix.lat, lng: repFix.lng }, { lat, lng });
  const atDoor = d <= 60;
  return (
    <button
      type="button"
      data-testid="outcome-proximity"
      data-dist-m={Math.round(d)}
      onClick={() => onRefresh(leadId)}
      aria-label={`${atDoor ? "You are at this door" : `${distanceHint(d)} from this door`} — tap to refresh`}
      title="Distance from your location"
      className={[
        "h-10 inline-flex items-center gap-1.5 px-3 rounded-full border text-[12px] font-semibold whitespace-nowrap active:scale-95 transition",
        atDoor
          ? "bg-success/[0.12] border-success/35 text-success"
          : "bg-secondary border-border text-muted-foreground",
      ].join(" ")}
    >
      <LocateFixed aria-hidden="true" className={`w-[14px] h-[14px] ${locating ? "animate-pulse" : ""}`} />
      {atDoor ? "At door" : distanceHint(d)}
    </button>
  );
}
