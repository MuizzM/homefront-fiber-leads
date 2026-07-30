// ── Shared a11y tokens ────────────────────────────────────────────────────────
// ONE visible keyboard-focus ring for every raw interactive element. This was
// copy-pasted per screen (and had already drifted to a second value in one
// file) — a focus treatment is a design token, not a per-screen decision.
export const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background";
