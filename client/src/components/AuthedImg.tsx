// ── Authenticated image ───────────────────────────────────────────────────────
// Auth is header-based (x-session-id), which a native <img> request can't
// carry, so this fetches the file as a blob through the authenticated endpoint
// and renders an object URL. Shared by PropertyDetail's photo strip and the
// map card's Details photos — one blob path, one revoke discipline.
import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";

export function AuthedImg({ photoId, alt, className, onClick }: {
  photoId: number; alt: string; className?: string; onClick?: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let objectUrl: string | null = null;
    let alive = true;
    apiRequest("GET", `/api/photos/${photoId}/file`)
      .then(r => r.blob())
      .then(b => { if (!alive) return; objectUrl = URL.createObjectURL(b); setUrl(objectUrl); })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [photoId]);
  if (failed) return null;
  if (!url) return <Skeleton className={className} />;
  return <img src={url} alt={alt} className={className} onClick={onClick} loading="lazy" />;
}

export default AuthedImg;
