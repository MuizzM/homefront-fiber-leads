import { useEffect, useState } from "react";

export type Theme = "dark" | "light";
const KEY = "hfs-theme";

function apply(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("light", theme === "light");
  root.classList.toggle("dark", theme === "dark");
}

/**
 * App theme with localStorage persistence. Dark is the brand default; the
 * toggle flips the `.light` class on <html>, which swaps the CSS token set.
 */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    if (typeof localStorage !== "undefined") {
      const saved = localStorage.getItem(KEY);
      if (saved === "light" || saved === "dark") return saved;
    }
    return "dark";
  });

  useEffect(() => {
    apply(theme);
    try { localStorage.setItem(KEY, theme); } catch {}
  }, [theme]);

  return { theme, setTheme, toggle: () => setTheme(t => (t === "dark" ? "light" : "dark")) };
}
