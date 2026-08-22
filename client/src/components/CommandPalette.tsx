// ── Command palette ──────────────────────────────────────────────────────────
// Cmd-K / Ctrl-K from anywhere: every page the signed-in role can open, plus
// the handful of actions people reach for most, one keystroke away.
//
// The page list is NOT a second nav table. Layout passes the same visible nav
// it renders in the sidebar, already filtered by capability and by the
// training gate, so the palette can never offer a page the sidebar would not.
// Actions carry their own capability check at the call site for the same
// reason: the list advertises nothing the API would refuse.
//
// Navigation goes through the hash router like every other link; "Add a
// lead" hands its intent to the Leads page through sessionStorage (see
// lib/leadsFilterHandoff.ts for why not a hash query).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useHashLocation } from "wouter/use-hash-location";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { prefetchRoute, prefetchRouteAll } from "@/lib/routePrefetch";
import { rankEntry, shortcutLabel, type PaletteAction, type PalettePage } from "@/components/paletteShell";

// Re-exported so existing imports of the types keep resolving.
export type { PaletteAction, PalettePage } from "@/components/paletteShell";
export { rankEntry, shortcutLabel } from "@/components/paletteShell";

export function CommandPalette({ open, onOpenChange, pages, actions }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pages: PalettePage[];
  actions: PaletteAction[];
}) {
  const [, navigate] = useHashLocation();
  // cmdk keeps its own filter text; reset it each time the palette opens so
  // the second Cmd-K never starts on the last query.
  const [query, setQuery] = useState("");
  useEffect(() => { if (open) setQuery(""); }, [open]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const go = useCallback((href: string) => { close(); navigate(href); }, [close, navigate]);

  // Keep the sidebar's group order; "Dashboard" may appear twice in the raw
  // nav (rep and manager variants) but only one survives the role filter.
  const groups = useMemo(() => {
    const order: string[] = [];
    const byGroup = new Map<string, PalettePage[]>();
    for (const page of pages) {
      const group = page.group ?? "Pages";
      if (!byGroup.has(group)) { byGroup.set(group, []); order.push(group); }
      byGroup.get(group)!.push(page);
    }
    return order.map(group => ({ group, pages: byGroup.get(group)! }));
  }, [pages]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search or jump to a page" filter={rankEntry}>
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Type a page or an action..."
        data-testid="palette-input"
      />
      <CommandList data-testid="palette-list">
        <CommandEmpty>Nothing matches. Try a page name, like Leads or Mileage.</CommandEmpty>
        {actions.length > 0 && (
          <CommandGroup heading="Actions">
            {actions.map(({ id, label, keywords, icon: Icon, run }) => (
              <CommandItem
                key={id}
                value={[label, ...(keywords ?? [])].join(" ")}
                onSelect={() => { close(); run(); }}
                data-testid={`palette-action-${id}`}
              >
                <Icon aria-hidden="true" />
                <span className="flex-1 truncate">{label}</span>
                <CommandShortcut>Action</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {groups.map(({ group, pages: items }) => (
          <CommandGroup key={group} heading={group}>
            {items.map(({ href, label, icon: Icon }) => (
              <CommandItem
                key={`${group}:${href}`}
                value={`${label} ${group} ${href}`}
                onSelect={() => go(href)}
                // Same intent warm-up the sidebar links get: hovering a row
                // fetches the page's chunk, pressing fetches its first query.
                onPointerEnter={() => prefetchRoute(href)}
                onFocus={() => prefetchRoute(href)}
                onPointerDown={() => prefetchRouteAll(href)}
                data-testid={`palette-page-${href.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "home"}`}
              >
                <Icon aria-hidden="true" />
                <span className="flex-1 truncate">{label}</span>
                <span className="text-xs text-muted-foreground">{group}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-2xs text-muted-foreground">
        <span><kbd className="font-sans font-semibold">Enter</kbd> opens</span>
        <span><kbd className="font-sans font-semibold">Esc</kbd> closes</span>
        <span className="ml-auto">{shortcutLabel()} from anywhere</span>
      </div>
    </CommandDialog>
  );
}

export default CommandPalette;
