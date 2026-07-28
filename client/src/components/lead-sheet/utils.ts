// ── Lead sheet shared helpers ────────────────────────────────────────────────
// Pure, framework-free helpers shared by the lead-sheet subcomponents and the
// LeadKnockSheet shell. Extracted so PeekBar / QuickBody / DetailsBody never
// drift on formatting.

// Muted secondary text per the card spec.
export const MUTED = "#8A94A6";
// Slightly brighter than MUTED for note/preview body copy.
export const BODY_TEXT = "#B9C2D0";

// "5m ago" / "2h ago" / "3d ago" / "Jul 8" — one compact relative-time helper
// for the peek status line, header status line, recent-activity line, and
// History rows.
export function relativeTime(iso?: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch { return false; }
}

// "Muizz Muhammad" → "M. Muhammad" (single names pass through).
export function shortRepName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name.trim();
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}

// A phone the rep can actually dial: 7–15 digits once punctuation is stripped
// (E.164 ceiling). Anything else (empty, extension garbage, letters) hides the
// Call action entirely — never a disabled button.
export function validPhone(phone?: string | null): boolean {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}
