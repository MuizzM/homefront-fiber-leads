import { useEffect, useState } from "react";

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
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem(KEY);
      if (saved === "light" || saved === "dark") return saved;
    }
    return "light";
  });

  useEffect(() => {
    apply(theme);
    try { localStorage.setItem(KEY, theme); } catch {}
  }, [theme]);

  return { theme, setTheme, toggle: () => setTheme(t => (t === "dark" ? "light" : "dark")) };
}
