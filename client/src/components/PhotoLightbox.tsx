// ── Photo lightbox — THE full-screen viewer ──────────────────────────────────
// Not a modal scrim: the backdrop is deliberately near-opaque black so nothing
// of the app tints the photo, and it stays black in both themes — which is why
// this file carries the app's single bg-black exemption in
// tests/unit/overlay-consistency.test.ts. Every surface that views a door
// photo (PropertyDetail, the map card's Details strip) renders THIS component,
// so the exemption can never spread.
import { AuthedImg } from "@/components/AuthedImg";

export function PhotoLightbox({ photoId, onClose }: { photoId: number; onClose: () => void }): JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Photo viewer"
      onClick={onClose}
    >
      <AuthedImg photoId={photoId} alt="Door photo (full size)" className="max-w-full max-h-full rounded-xl object-contain" />
      <button
        autoFocus
        type="button"
        onClick={onClose}
        onKeyDown={e => { if (e.key === "Escape") onClose(); }}
        aria-label="Close photo"
        className="absolute top-[max(1rem,env(safe-area-inset-top))] right-4 w-11 h-11 rounded-full bg-black/50 text-white text-2xl leading-none flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        ×
      </button>
    </div>
  );
}

export default PhotoLightbox;
