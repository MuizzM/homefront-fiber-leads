// ── Photo lightbox — THE full-screen viewer ──────────────────────────────────
// Not a modal scrim: the backdrop is deliberately near-opaque black so nothing
// of the app tints the photo, and it stays black in both themes — which is why
// this file carries the app's single bg-black exemption in
// tests/unit/overlay-consistency.test.ts. Every surface that views a door
// photo (PropertyDetail, the map card's Details strip) renders THIS component,
// so the exemption can never spread.
import { useRef } from "react";
import { AuthedImg } from "@/components/AuthedImg";
import { useModalA11y } from "@/hooks/use-modal-a11y";

export function PhotoLightbox({ photoId, onClose }: { photoId: number; onClose: () => void }): JSX.Element {
  // Escape must close from ANYWHERE in the dialog, not only while the close
  // button held focus - and closing returns focus to the thumbnail that
  // opened the viewer.
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, { active: true, onClose });
  return (
    <div
      ref={panelRef}
      className="fixed inset-0 z-overlay bg-black/90 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Photo viewer"
      onClick={onClose}
    >
      <AuthedImg photoId={photoId} loading="eager" alt="Door photo (full size)" className="max-w-full max-h-full rounded-xl object-contain" />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close photo"
        className="absolute top-[max(1rem,env(safe-area-inset-top))] right-4 w-11 h-11 rounded-full bg-black/50 text-white text-2xl leading-none flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        ×
      </button>
    </div>
  );
}

export default PhotoLightbox;
