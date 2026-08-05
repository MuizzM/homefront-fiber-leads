// ── PDF blob cache + prefetch ────────────────────────────────────────────────
// Lives in lib/, NOT inside PdfReviewPane: auth.tsx clears this cache at its
// identity boundaries, and importing the component from the render-blocking
// entry just to reach the cache dragged the whole pane (icons and all) into
// the first-paint bundle.
//
// The list screens know which documents the signer is about to open; fetching
// their bytes while the list idles means the signing dialog opens onto a PDF
// that is ALREADY here. Blobs are cached (an envelope's PDF never changes
// under the same id); object URLs stay per-mount so revocation keeps working.
import { getStoredSessionId } from "@/lib/queryClient";

const pdfBlobCache = new Map<string, Promise<Blob>>();

/** Logout / identity switch is a hard cache boundary everywhere else in the
 *  app; this cache holds signed-agreement PDFs and must die with the session. */
export function clearPdfBlobCache(): void {
  pdfBlobCache.clear();
}

/** True when a fetch for this URL has already been started (and not failed). */
export function hasPdfBlob(url: string): boolean {
  return pdfBlobCache.has(url);
}

export function fetchPdfBlob(url: string, warm: boolean): Promise<Blob> {
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
