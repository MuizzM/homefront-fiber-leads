// ── Photos — field evidence, on the dark card ────────────────────────────────
// The SalesRabbit "Files" tab, scoped to what field files actually are here:
// door photos. Same endpoints, cap, and tenant/scope walls as PropertyDetail's
// strip (the server enforces all of it); this is the dark-sheet rendering with
// the camera-first capture input. Uploads need a connection — offline the add
// tile disables with the reason instead of failing after the fact.

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, RefreshCw } from "lucide-react";
import { apiRequest, apiUpload } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { AuthedImg } from "@/components/AuthedImg";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { MUTED } from "./utils";

interface LeadPhotoRow { id: number; createdAt: string; takenBy: string | null }

function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return online;
}

export function SheetPhotos({ leadId }: { leadId: number }): JSX.Element {
  const qc = useQueryClient();
  const { toast } = useToast();
  const online = useOnline();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);

  const photosQ = useQuery<LeadPhotoRow[]>({
    queryKey: [`/api/leads/${leadId}/photos`],
    queryFn: () => apiRequest("GET", `/api/leads/${leadId}/photos`).then(r => r.json()),
    enabled: leadId > 0,
    staleTime: 30_000,
  });
  const photos = photosQ.data ?? [];

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("photo", file);
      await apiUpload(`/api/leads/${leadId}/photos`, fd);
      void qc.invalidateQueries({ queryKey: [`/api/leads/${leadId}/photos`] });
    } catch (e: any) {
      toast({ title: "Couldn't upload the photo", description: String(e?.message ?? e).slice(0, 120), variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div data-testid="knock-photos" className="mt-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] mb-1.5" style={{ color: MUTED }}>
        Photos
      </div>
      <div className="-m-1 flex gap-2 overflow-x-auto p-1 scrollbar-none">
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          className="hidden"
          aria-label="Take or choose a photo"
          onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); }}
        />
        <button
          type="button"
          data-testid="knock-photo-add"
          onClick={() => fileRef.current?.click()}
          disabled={!online || uploading}
          className="flex h-20 w-20 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-white/25 text-white/60 tap-press hover:border-white/45 hover:text-white/85 disabled:opacity-45 disabled:hover:border-white/25 disabled:hover:text-white/60"
        >
          {uploading
            ? <RefreshCw aria-hidden="true" className="h-5 w-5 animate-spin" />
            : <Camera aria-hidden="true" className="h-5 w-5" />}
          <span className="text-2xs font-semibold">{uploading ? "Uploading…" : online ? "Add" : "Offline"}</span>
        </button>
        {photos.map(p => (
          <button
            key={p.id}
            type="button"
            onClick={() => setViewer(p.id)}
            aria-label={`View door photo${p.takenBy ? ` by ${p.takenBy}` : ""}`}
            className="shrink-0 rounded-xl tap-press"
          >
            <AuthedImg
              photoId={p.id}
              alt={`Door photo${p.takenBy ? ` by ${p.takenBy}` : ""}`}
              className="h-20 w-20 rounded-xl border border-white/10 object-cover"
            />
          </button>
        ))}
        {/* A failed fetch must never read as "no photos" — say it, offer retry. */}
        {!photosQ.isLoading && photosQ.isError && (
          <div className="flex items-center pl-1 text-[12px] text-destructive">
            Couldn't load photos.
            <button type="button" onClick={() => photosQ.refetch()} className="ml-2 font-semibold text-primary hover:underline">
              Retry
            </button>
          </div>
        )}
        {!photosQ.isLoading && !photosQ.isError && photos.length === 0 && (
          <div className="flex items-center pl-1 text-[12px]" style={{ color: MUTED }}>
            No photos yet. Snap the house or the drop.
          </div>
        )}
      </div>

      {/* Full-screen viewer — the ONE shared lightbox (Escape/tap closes). */}
      {viewer != null && <PhotoLightbox photoId={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}

export default SheetPhotos;
