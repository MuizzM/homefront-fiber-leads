import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";
const KEY = "hfs-theme";

// The two --background token values as hex, for the browser-chrome meta.
// index.html ships the LIGHT value (the default appearance); this keeps the
// Android address bar / status chrome in step when the user toggles - the meta
// was pinned to dark ink while the app rendered light, so standalone installs
// wore dark chrome around a light page.
const THEME_CHROME: Record<Theme, string> = { light: "#FBFAF9", dark: "#0C0F13" };

function apply(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("light", theme === "light");
  root.classList.toggle("dark", theme === "dark");
  try {
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_CHROME[theme]);
  } catch { /* no document (tests) - the class swap above already threw if so */ }
}

// ── One shared theme store ────────────────────────────────────────────────────
// The hook used to hold per-instance useState, and Layout and Profile mount
// simultaneously: toggling on Profile applied .dark and saved, but Layout's
// copy still said "light" - its footer button wore the wrong label and its
// first tap was a visible no-op (re-applying the theme already on screen).
// useSyncExternalStore over module state makes every subscriber read and
// write the SAME value.
let current: Theme = (() => {
  try {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* storage blocked - fall through to the default */ }
  return "light";
})();

const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setTheme(next: Theme) {
  if (next === current) return;
  current = next;
  apply(next);
  try { localStorage.setItem(KEY, next); } catch { /* storage blocked - session-only */ }
  listeners.forEach(l => l());
}

// Sync the DOM once at module load (idempotent with index.html's pre-paint
// script, which handles the saved-dark flash before React exists).
if (typeof document !== "undefined") apply(current);

/**
 * App theme with localStorage persistence.
 *
 * LIGHT is the default appearance. Dark stays a first-class user setting - a
 * saved preference always wins, and anyone already on dark keeps it - but the
 * product's resting state is the light Homefront palette.
 *
 * The class is applied to <html> and swaps the CSS token set: light tokens are
 * the base (:root), dark overrides under `.dark`.
 */
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => current, () => "light" as Theme);
  return { theme, setTheme, toggle: () => setTheme(current === "dark" ? "light" : "dark") };
}
