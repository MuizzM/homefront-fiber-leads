// ── Leads-in-view panel — the ACCURATE right-side list of what the map shows ──
// Mirrors the map exactly by construction: rows come from the same visibleLeads
// memo that feeds the pin layer, intersected with the live viewport bounds —
// never a separate query that could disagree with the pins. Dots/labels use
// pinDisplayState → STATE_COLORS (the TRUE GPU pin hue — a callback door reads
// cyan "Callback" here exactly as painted), not the lossy 6-state status map.
//
// Scale: a dependency-free fixed-row windowing hook renders ~30 DOM rows no
// matter how many leads are in view (50k unvirtualized would be ~300k nodes).
// Desktop ≥1024px: a static flex-sibling rail (the map shrinks; its
// ResizeObserver fires resize → moveend → bounds self-correct). Phone: a
// right-edge slide-in glass drawer over the map.
import { useCallback, useEffect, useRef, useState } from "react";
import { X, List, Maximize2 } from "lucide-react";
import { pinDisplayState, STATE_COLORS, STATE_LABELS } from "@shared/knock";
import { leadKey } from "@/lib/dedupeLeads";

export interface PanelLead {
  id: number;
  address: string;
  city?: string | null;
  state?: string | null;
  lat?: number | null;
  lng?: number | null;
  leadStatus: string;
  assignedRepId?: number | null;
  visited?: boolean | number | null;
  lastOutcome?: string | null;
  fiberStatus?: string | null;
}

const ROW_H = 56; // h-14 — two-line row, ≥44px touch target

// Fixed-row-height windowing: scrollTop → slice indices, overscan rows above
// and below, translateY spacer. No dependency; identity-bailout on setState.
// `active` MUST flip true when the list actually mounts: the panel renders
// null while closed, so effects that ran with a null scrollRef would otherwise
// never re-run on open — the window would stay at its 16-row default and the
// ResizeObserver would never attach (review-found bug: 451px of blank list
// after resizing an open panel, and fast-Tab falling off row 16 to <body>).
function useWindowedList<T>(items: T[], rowH: number, overscan = 8, active = true) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState({ start: 0, end: 2 * overscan });
  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const start = Math.max(0, Math.floor(el.scrollTop / rowH) - overscan);
    const end = Math.min(items.length, Math.ceil((el.scrollTop + el.clientHeight) / rowH) + overscan);
    setRange(r => (r.start === start && r.end === end ? r : { start, end }));
  }, [items.length, rowH, overscan]);
  useEffect(() => {
    if (!active) return;
    recompute(); // measure the real viewport the moment the list mounts
  }, [recompute, active]);
  useEffect(() => { // panel resize (keyboard, rotate) re-measures the window
    if (!active) return;
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [recompute, active]);
  return {
    scrollRef, onScroll: recompute, start: range.start,
    slice: items.slice(range.start, range.end),
    totalHeight: items.length * rowH, offsetY: range.start * rowH,
  };
}

export function LeadsInViewPanel({
  open, onClose, leads, totalOnMap, orgTotal, filtered,
  showLeadsLayer, onShowLeadsLayer, onRowTap, onFitAll, onClearFilters,
  repNameById,
}: {
  open: boolean;
  onClose: () => void;
  leads: PanelLead[];        // in-view, sorted nearest-to-center
  totalOnMap: number;        // what the map paints (post-filter, has coords)
  orgTotal: number;          // unfiltered org total from the server
  filtered: boolean;         // totalOnMap !== orgTotal
  showLeadsLayer: boolean;
  onShowLeadsLayer: () => void;
  onRowTap: (id: number) => void;
  onFitAll: () => void;
  onClearFilters: () => void;
  repNameById: Map<number, string>;
}) {
  const asideRef = useRef<HTMLElement | null>(null);
  const { scrollRef, onScroll, slice, start, totalHeight, offsetY } = useWindowedList(leads, ROW_H, 8, open);

  // Focus the region on open (next frame — same pattern as the search panel),
  // so Esc + screen-reader context land immediately.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => asideRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/* Phone scrim — blur-free (full-viewport blur over WebGL is banned). */}
      <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={onClose} aria-hidden="true" />
      <aside
        ref={asideRef as any}
        role="complementary"
        aria-label="Leads in view"
        data-testid="leads-panel"
        tabIndex={-1}
        className={[
          // phone: right-edge slide-in glass drawer over the map
          "fixed inset-y-0 right-0 z-40 flex w-[min(85vw,340px)] flex-col",
          "glass-sheet border-l border-white/10 rounded-l-[24px]",
          "animate-in slide-in-from-right duration-200 focus:outline-none",
          // desktop ≥1024: static flex sibling — shrinks the map, keeps bounds honest
          "lg:static lg:z-auto lg:w-[340px] lg:shrink-0 lg:rounded-none lg:animate-none",
        ].join(" ")}
        style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <header className="flex items-center gap-2 px-3 py-2 border-b border-white/10">
          <List className="w-4 h-4 text-teal-300 shrink-0" aria-hidden="true" />
          <h2 className="text-[13px] font-semibold text-white flex-1 truncate" data-testid="leads-panel-count">
            {leads.length.toLocaleString()} in view
            <span className="text-white/50 font-normal"> · {totalOnMap.toLocaleString()} total</span>
            {filtered && <span className="ml-1.5 text-2xs font-semibold text-teal-300">filtered</span>}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close leads panel"
            data-testid="leads-panel-close"
            className="h-11 w-11 -my-1 flex items-center justify-center rounded-xl text-white/70 hover:text-white hover:bg-white/10"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {/* States — each one honest about WHY the list is empty, with the fix. */}
        {!showLeadsLayer ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-[13px] text-white/60">The leads layer is hidden — the map is painting nothing.</p>
            <button onClick={onShowLeadsLayer} className="h-11 px-4 rounded-full bg-teal-500 hover:bg-teal-600 text-[#04241f] text-[13px] font-bold">
              Show leads
            </button>
          </div>
        ) : orgTotal === 0 ? (
          <div className="flex-1 flex items-center justify-center px-6 text-center">
            <p className="text-[13px] text-white/60">No leads on the map yet — scan an area or import a list to get started.</p>
          </div>
        ) : totalOnMap === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-[13px] text-white/60">No leads match the current filters.</p>
            <button onClick={onClearFilters} data-testid="leads-panel-clear-filters"
              className="h-11 px-4 rounded-full bg-white/10 hover:bg-white/20 text-white text-[13px] font-semibold">
              Clear filters
            </button>
          </div>
        ) : leads.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-[13px] text-white/60">No leads in this view — pan the map, or:</p>
            <button onClick={onFitAll} data-testid="leads-panel-fit-all"
              className="h-11 px-4 rounded-full bg-teal-500 hover:bg-teal-600 text-[#04241f] text-[13px] font-bold flex items-center gap-1.5">
              <Maximize2 className="w-3.5 h-3.5" /> Fit to all leads
            </button>
          </div>
        ) : (
          <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto overscroll-contain">
            <div style={{ height: totalHeight, position: "relative" }}>
              <ul role="list" className="absolute inset-x-0 top-0" style={{ transform: `translateY(${offsetY}px)` }}>
                {slice.map((l, i) => {
                  const ds = pinDisplayState(l);
                  const color = STATE_COLORS[ds];
                  const rep = l.assignedRepId ? repNameById.get(l.assignedRepId) : null;
                  return (
                    <li key={leadKey(l)} role="listitem" aria-setsize={leads.length} aria-posinset={start + i + 1}>
                      <button
                        type="button"
                        onClick={() => onRowTap(l.id)}
                        data-testid={`leads-panel-row-${l.id}`}
                        className="w-full h-14 min-h-[44px] px-3 flex flex-col justify-center text-left hover:bg-white/10 focus-visible:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 focus-visible:ring-inset border-b border-white/5"
                      >
                        <span className="block text-[13px] text-white font-medium truncate">{l.address}</span>
                        <span className="flex items-center gap-1.5 text-[11px] text-white/50 truncate">
                          {/* The dot carries the true pin hue; the label stays
                              white/70 — raw hues at 11px fail AA on glass
                              (contacted slate ≈2.5:1, review finding). */}
                          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} aria-hidden="true" />
                          <span className="text-white/70">{STATE_LABELS[ds]}</span>
                          <span aria-hidden="true">·</span>
                          <span className="truncate">{rep ?? "Unassigned"}</span>
                          {l.fiberStatus === "new_fiber" && (
                            <span className="text-2xs font-bold text-teal-400 shrink-0">NEW</span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
