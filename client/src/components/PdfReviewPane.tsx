import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, ExternalLink, FileText, Loader2 } from "lucide-react";
import { FOCUS } from "@/lib/a11y";
import { apiRequest, getStoredSessionId } from "@/lib/queryClient";

// ── Real-PDF review pane ─────────────────────────────────────────────────────
// A signer is entitled to read the actual instrument — paginated, scrollable,
// zoomable, exactly as it will be filed — before they sign it. This renders the
// genuine PDF bytes, not a re-creation of them in HTML.
//
// WHY THE BROWSER'S OWN VIEWER, and not pdf.js: the native viewer already gives
// multi-page scroll, zoom, fit, page navigation, text selection, find, and
// printing, on every desktop browser, for zero bundle cost. pdf.js would add
// ~350KB to a field app that runs on phones over LTE, to reproduce what the
// platform hands us. The tradeoff is real and named below: some mobile browsers
// (notably older iOS Safari) refuse to render a PDF in an iframe, so this
// ALWAYS renders an explicit "Open" / "Download" pair as a first-class path
// rather than a hidden fallback. A signer on a phone is never stuck.
//
// The bytes are fetched as a blob rather than pointing the iframe at the URL,
// because the endpoint needs the session header — and because a blob URL lets
// the same fetched document serve the viewer, the download, and the new-tab
// open without three round trips.

// ── Blob cache + prefetch ────────────────────────────────────────────────────
// The list screen knows which documents the signer is about to open; fetching
// their bytes while the list idles means the signing dialog opens onto a PDF
// that is ALREADY here — the pane pops instead of spinning. Blobs are cached
// (they are immutable: an envelope's PDF never changes under the same id);
// object URLs stay per-mount so revocation keeps working.
const pdfBlobCache = new Map<string, Promise<Blob>>();

/** Logout / identity switch is a hard cache boundary everywhere else in the app
 *  (auth.tsx clears the query + persisted caches); this cache holds signed-
 *  agreement PDFs and must die with the session too. */
export function clearPdfBlobCache(): void {
  pdfBlobCache.clear();
}

function fetchPdfBlob(url: string, warm: boolean): Promise<Blob> {
  const cached = pdfBlobCache.get(url);
  if (cached) return cached;
  const sid = getStoredSessionId();
  // warm=1 tells the server this is a cache warm-up, not a human opening the
  // document — it must not write a preview_opened audit row. Cached under the
  // BASE url so the real open finds the warmed blob.
  const requestUrl = warm ? `${url}${url.includes("?") ? "&" : "?"}warm=1` : url;
  const promise = fetch(requestUrl, { credentials: "include", headers: { accept: "application/pdf", ...(sid ? { "x-session-id": sid } : {}) } })
    .then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.blob();
    });
  // A failure must not poison the cache — the next open retries the network.
  promise.catch(() => { if (pdfBlobCache.get(url) === promise) pdfBlobCache.delete(url); });
  pdfBlobCache.set(url, promise);
  return promise;
}

/** Warm the cache for a document the user is likely to open. Fire-and-forget. */
export function prefetchPdf(url: string): void {
  void fetchPdfBlob(url, true).catch(() => {});
}

export interface PdfReviewPaneProps {
  /** Endpoint returning application/pdf. Fetched with credentials. */
  url: string;
  /** File name used when the signer downloads or opens the document. */
  fileName: string;
  /** Accessible label for the embedded viewer. */
  title: string;
  /** Fires once the document has been fetched and handed to the viewer. */
  onLoaded?: () => void;
  /** POSTed (fire-and-forget) when this open was served from the warm cache, so
   *  the server's audit trail still records the real open the network never saw. */
  openBeaconUrl?: string;
  /** Rendered under the toolbar — e.g. an accessible text-version switch. */
  children?: React.ReactNode;
  testId?: string;
}

export function PdfReviewPane({
  url, fileName, title, onLoaded, openBeaconUrl, children, testId = "pdf-review-pane",
}: PdfReviewPaneProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    // Revoke the previous object URL before minting a new one — a signing
    // session that opens several documents would otherwise pin every PDF it
    // has ever shown in memory.
    if (objectUrlRef.current) { URL.revokeObjectURL(objectUrlRef.current); objectUrlRef.current = null; }
    setBlobUrl(null);

    // The API authenticates by x-session-id header, never by cookie — a bare
    // credentialed fetch is a guaranteed 401 and an empty review pane. Cached
    // (or prefetched) blobs resolve on the microtask queue, so a warmed pane
    // renders its PDF in the same frame the dialog opens.
    const servedFromCache = pdfBlobCache.has(url);
    if (servedFromCache && openBeaconUrl) {
      void apiRequest("POST", openBeaconUrl).catch(() => { /* audit beacon is best-effort */ });
    }
    fetchPdfBlob(url, false)
      .then(blob => {
        if (cancelled) return;
        const next = URL.createObjectURL(blob);
        objectUrlRef.current = next;
        setBlobUrl(next);
        setState("ready");
        onLoaded?.();
      })
      .catch(() => { if (!cancelled) setState("error"); });

    return () => {
      cancelled = true;
      if (objectUrlRef.current) { URL.revokeObjectURL(objectUrlRef.current); objectUrlRef.current = null; }
    };
    // onLoaded is deliberately not a dependency: callers pass inline closures,
    // and re-fetching the document on every parent render would be a network
    // loop, not a refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const download = () => {
    if (!blobUrl) return;
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className="flex flex-col min-h-0 flex-1" data-testid={testId}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-secondary/40 shrink-0">
        <FileText className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
        <span className="text-xs font-semibold text-foreground truncate">{title}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {/* First-class, not a fallback: on a phone that will not embed a PDF, */}
          {/* these two buttons ARE the review path. */}
          <button
            type="button"
            onClick={() => blobUrl && window.open(blobUrl, "_blank", "noopener,noreferrer")}
            disabled={!blobUrl}
            data-testid={`${testId}-open`}
            className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-border text-[11px] font-semibold text-foreground hover:bg-secondary disabled:opacity-50 ${FOCUS}`}
          >
            <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" /> Open
          </button>
          <button
            type="button"
            onClick={download}
            disabled={!blobUrl}
            data-testid={`${testId}-download`}
            className={`inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-border text-[11px] font-semibold text-foreground hover:bg-secondary disabled:opacity-50 ${FOCUS}`}
          >
            <Download className="w-3.5 h-3.5" aria-hidden="true" /> Save
          </button>
        </div>
      </div>

      {children}

      <div className="relative flex-1 min-h-[420px] bg-slate-100">
        {state === "loading" && (
          <div className="absolute inset-0 grid place-items-center" data-testid={`${testId}-loading`}>
            <div className="text-center text-slate-500">
              <Loader2 className="w-6 h-6 animate-spin mx-auto" aria-hidden="true" />
              <p className="text-xs mt-2">Loading the document…</p>
            </div>
          </div>
        )}
        {state === "error" && (
          <div className="absolute inset-0 grid place-items-center p-6" data-testid={`${testId}-error`}>
            <div className="text-center max-w-xs">
              <AlertTriangle className="w-7 h-7 text-amber-500 mx-auto" aria-hidden="true" />
              <p className="text-sm font-semibold text-slate-800 mt-2">Couldn't load the document</p>
              <p className="text-xs text-slate-600 mt-1">
                Nothing has been signed. Check your connection and try again, or ask your manager for a copy.
              </p>
            </div>
          </div>
        )}
        {state === "ready" && blobUrl && (
          // `object` over `iframe`: a browser that cannot render PDFs shows the
          // fallback children instead of a blank white rectangle that looks
          // like a broken document.
          <object
            data={blobUrl}
            type="application/pdf"
            title={title}
            aria-label={title}
            data-testid={`${testId}-object`}
            className="absolute inset-0 w-full h-full"
          >
            <div className="absolute inset-0 grid place-items-center p-6">
              <div className="text-center max-w-xs">
                <FileText className="w-7 h-7 text-slate-400 mx-auto" aria-hidden="true" />
                <p className="text-sm font-semibold text-slate-800 mt-2">This browser can't display PDFs inline</p>
                <p className="text-xs text-slate-600 mt-1">Use <strong>Open</strong> or <strong>Save</strong> above to read the full document.</p>
              </div>
            </div>
          </object>
        )}
      </div>
    </div>
  );
}

export default PdfReviewPane;
