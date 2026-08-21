// ── PdfReviewer — full-page, in-app review of a real PDF ──────────────────────
// Shows an ACTUAL PDF document (e.g. the official IRS W-9 filled from the rep's
// data, or a signed agreement) full-page so the signer can scroll, zoom, and
// page through the entire document before acting on it — the "review the real
// document, not chopped-up fields" requirement.
//
// Dependency-free: the browser's built-in PDF viewer (via <object>) gives
// scroll / zoom / page-nav for free. The PDF is fetched as an authed blob (the
// endpoints are session-gated and tenant-walled; an <object data=url> can't
// carry the session header, so we fetch then hand it a blob: URL), same pattern
// as the door-photo / badge-photo viewers.
import { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";

export function PdfReviewer({
  url,
  title,
  downloadName,
  onClose,
  onReviewed,
  reviewedLabel = "I've reviewed this document",
}: {
  /** Authed GET endpoint that returns application/pdf bytes. */
  url: string;
  title: string;
  /** When set, a Download button saves the same bytes under this filename. */
  downloadName?: string;
  onClose: () => void;
  /** When set, a primary CTA appears; calling it is the "reviewed → continue" gate. */
  onReviewed?: () => void;
  reviewedLabel?: string;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set once: a coarse pointer is a phone/tablet, where inline PDF embedding
  // is unreliable (iOS Safari especially).
  const [isCoarsePointer] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true);

  useEffect(() => {
    let alive = true;
    let objectUrl = "";
    setBlobUrl(null);
    setError(null);
    apiRequest("GET", url)
      .then(response => response.blob())
      .then(blob => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch(() => { if (alive) setError("This document couldn't be opened. Try again in a moment."); });
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url]);

  function download() {
    if (!blobUrl) return;
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = downloadName || `${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`Review ${title}`} data-testid="pdf-reviewer">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">{title}</h2>
        <div className="flex shrink-0 items-center gap-2">
          {downloadName && (
            <Button type="button" variant="outline" size="sm" onClick={download} disabled={!blobUrl} data-testid="pdf-reviewer-download">
              Download
            </Button>
          )}
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close" data-testid="pdf-reviewer-close">
            <X className="h-5 w-5" aria-hidden="true" />
          </Button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 bg-secondary/30">
        {!blobUrl && !error && (
          <div className="grid h-full place-items-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" /></div>
        )}
        {error && (
          <div className="grid h-full place-items-center p-6 text-center">
            <div>
              
              <p className="mt-2 text-sm font-medium text-foreground">{error}</p>
            </div>
          </div>
        )}
        {blobUrl && !error && (
          isCoarsePointer ? (
            // iOS Safari renders <object type=application/pdf> BLANK and does not
            // trigger the fallback, so on touch devices (where reps read their
            // tax/pay docs) offer an explicit open/download instead of a dead frame.
            <div className="grid h-full place-items-center gap-3 p-6 text-center">
              <p className="text-sm text-muted-foreground">Open this document to read it on your phone.</p>
              <Button type="button" onClick={() => window.open(blobUrl, "_blank", "noopener")} aria-label={`Open ${title}`}>Open document</Button>
              <Button type="button" variant="outline" size="sm" onClick={download}>Download</Button>
            </div>
          ) : (
            // title attr labels the embedded viewer; the browser renders scroll/zoom/pages.
            <object data={blobUrl} type="application/pdf" className="h-full w-full" aria-label={title}>
              <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">
                Your browser can't display the PDF inline.
                <Button type="button" variant="outline" size="sm" className="ml-2" onClick={download}>Download to view</Button>
              </div>
            </object>
          )
        )}
      </div>

      {onReviewed && (
        <footer className="border-t border-border px-4 py-3">
          <Button type="button" className="w-full sm:w-auto" onClick={onReviewed} disabled={!blobUrl} data-testid="pdf-reviewer-reviewed">
            {reviewedLabel}
          </Button>
        </footer>
      )}
    </div>
  );
}
