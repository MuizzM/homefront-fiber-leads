// ── Palette shell ────────────────────────────────────────────────────────────
// The parts of the command palette the shell needs at first paint: the
// keyboard shortcut, the sidebar trigger and the ranking function. Nothing in
// here imports cmdk - that stays in CommandPalette.tsx, which Layout loads
// lazily, so a rep who never presses Cmd-K never downloads it. (Measured: with
// the palette in the entry chunk, first paint carried 19 KB more gzipped JS.)

import { useEffect } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

export type PalettePage = {
  href: string;
  label: string;
  group?: string;
  icon: React.ElementType;
};

export type PaletteAction = {
  id: string;
  label: string;
  /** Extra words the filter should match ("invite", "W-9"). */
  keywords?: string[];
  icon: React.ElementType;
  run: () => void;
};

/**
 * Ranking: whole-word prefixes first, then substrings, nothing else. cmdk's
 * default scorer is fuzzy, which ranked "Field Hours" above "Rulebook" for
 * the query "rule" (r, u, l, e in order across the label): a palette that
 * opens the wrong page on Enter is worse than one that shows nothing.
 */
export function rankEntry(value: string, search: string): number {
  const q = search.trim().toLowerCase();
  if (!q) return 1;
  const v = value.toLowerCase();
  if (v.startsWith(q)) return 1;
  const words = v.split(/[\s/-]+/).filter(Boolean);
  if (words.some(word => word.startsWith(q))) return 0.9;
  // Every word of a multi-word query must land somewhere ("team metrics").
  const parts = q.split(/\s+/).filter(Boolean);
  if (parts.length > 1 && parts.every(part => words.some(word => word.startsWith(part)))) return 0.8;
  if (v.includes(q)) return 0.6;
  return 0;
}

/** True on Apple platforms, where the shortcut reads as Cmd rather than Ctrl. */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** The shortcut hint as people read it on this platform. */
export function shortcutLabel(): string {
  return isApplePlatform() ? "⌘K" : "Ctrl K";
}

/** Cmd-K (Apple) or Ctrl-K (everything else) toggles the palette. The handler
 *  claims only that chord - undo, copy, and every other key pass through. */
export function usePaletteShortcut(toggle: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "k" && event.key !== "K") return;
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);
}

/** The one dynamic import for the palette chunk, shared by Layout's lazy()
 *  and the idle warm-up so Vite keys both to the same chunk. */
export const loadCommandPalette = () => import("@/components/CommandPalette");

/** The sidebar's search field. It looks like an Input because that is what a
 *  person expects to find there; it is a button because the palette is the
 *  thing that searches. Desktop only; phones reach the palette from More. */
export function PaletteTrigger({ onOpen, className }: { onOpen: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      // Warm the chunk on intent, the way nav links warm their routes.
      onPointerEnter={() => { void loadCommandPalette(); }}
      onFocus={() => { void loadCommandPalette(); }}
      data-testid="palette-trigger"
      aria-label="Search or jump to a page"
      aria-keyshortcuts="Meta+K Control+K"
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-lg border border-input bg-background px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className,
      )}
    >
      <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="flex-1 truncate">Search or jump to...</span>
      <kbd className="inline-flex h-5 items-center rounded-md border border-border bg-muted px-1.5 font-sans text-2xs font-semibold text-muted-foreground">{shortcutLabel()}</kbd>
    </button>
  );
}
