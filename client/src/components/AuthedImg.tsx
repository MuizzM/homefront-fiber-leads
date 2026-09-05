// Header-authenticated photos cannot use a native URL. Wait for visibility
// before downloading the blob; loading="lazy" alone cannot defer fetch().
import { useEffect, useRef, useState } from "react";
import { apiRequest } from "@/lib/queryClient";

export function AuthedImg({ photoId, alt, className, onClick, loading = "lazy" }: {
  photoId: number; alt: string; className?: string; onClick?: () => void;
  loading?: "lazy" | "eager";
}) {
  const placeholder = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(loading === "eager");
  const [image, setImage] = useState<{ photoId: number; url: string } | null>(null);
  const [failedId, setFailedId] = useState<number | null>(null);
  useEffect(() => {
    if (loading === "eager" || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const target = placeholder.current;
    if (!target || visible) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "120px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [loading, visible]);

  useEffect(() => {
    if (!visible) return;
    let objectUrl: string | null = null;
    let alive = true;
    setFailedId(null);
    apiRequest("GET", `/api/photos/${photoId}/file`)
      .then(r => r.blob())
      .then(blob => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setImage({ photoId, url: objectUrl });
      })
      .catch(() => { if (alive) setFailedId(photoId); });
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [photoId, visible]);

  if (image?.photoId === photoId && failedId !== photoId) {
    return <img src={image.url} alt={alt} className={className} onClick={onClick} decoding="async" />;
  }
  // Keep failed thumbnails visible so their parent View photo button can open
  // the lightbox and retry, instead of leaving an invisible focus target.
  return <span ref={placeholder} role="img" aria-label={failedId === photoId ? `${alt}: couldn't load photo` : `Loading ${alt}`}
    className={`inline-flex items-center justify-center bg-muted text-xs text-muted-foreground ${className ?? ""}`}>
    {failedId === photoId ? "Photo unavailable" : null}
  </span>;
}

export default AuthedImg;
