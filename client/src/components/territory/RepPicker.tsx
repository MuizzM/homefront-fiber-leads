import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { X, Check } from "lucide-react";
import { repColorOf } from "@shared/repColors";
import { FOCUS } from "@/lib/a11y";
import {
  matchPerson,
  withRecentsFirst,
  ROSTER_SEARCH_THRESHOLD,
  ROSTER_MAX_ROWS,
} from "@/lib/rosterSearch";
import { useRecentReps, recordRecentRep } from "@/hooks/use-recent-reps";

// Choosing who gets an area - or anything else that needs one rep out of many.
//
// This replaced a plain <select>. That works for six reps and collapses at
// forty: no search, no way to see who is already loaded up, and on mobile it
// becomes a full-screen wheel you scroll blind. Assignment is the single most
// frequent territory action, so it gets a real picker.
//
// The scale contract (shared through lib/rosterSearch): search appears past
// ROSTER_SEARCH_THRESHOLD people, at most ROSTER_MAX_ROWS rows render with an
// honest "N more - keep typing" note, and on a long list with an empty query
// the reps this device assigned to recently float to the top under a "Recent"
// label. A 6-rep team sees none of that machinery; a 300-rep org needs all of
// it - nobody finds a name by scrolling 300 rows, they type three letters.
//
// What it shows beyond the name is deliberate: how many areas each rep already
// holds, because handing a seventh area to someone at the cap is the mistake
// this screen exists to prevent.

export interface RepOption {
  id: number;
  name: string;
  /** Active areas this rep already holds — drives the load hint. */
  areaCount?: number;
  /** True when they cannot take another area; the row is shown but not choosable. */
  atCap?: boolean;
  /** The rep's persisted colour (team_members.color via /api/team). Omitted or
   *  null → repColorOf falls back to the legacy repId-hash hue. */
  color?: string | null;
  /** Optional per-surface load line ("497 doors · 12 knocked today"). Rendered
   *  under the name when present; the areaCount grammar is unaffected. */
  detail?: string;
}

export interface RepPickerProps {
  reps: RepOption[];
  value?: number | null;
  /** Single-select pick. Optional so pure multi-select sites need not pass a
   *  dead handler; every single-select site still supplies it. */
  onChange?: (repId: number) => void;
  /** Multi-select: an area can be worked by several reps at once. When set, rows
   *  toggle instead of choosing, and `selected` is the full set of holders —
   *  which is exactly what POST /share expects, so the UI and the API agree on
   *  what "who holds this area" means. */
  multiple?: boolean;
  selected?: number[];
  onToggle?: (repId: number, next: number[]) => void;
  /** Rendered above the list; use for "Assign this area to…". */
  label?: string;
  placeholder?: string;
  /** Search box appears only past this many reps — it's noise for a small team. */
  searchThreshold?: number;
  disabled?: boolean;
  /** Max rows rendered at once; the rest are reachable by searching. */
  maxRows?: number;
  /** repId -> areas currently held. When provided, rows switch to the
   *  assign-sheet grammar: ring avatar with the rep's initial, and a status
   *  line under the name — "Assigned to N areas" or "Unassigned" — so a
   *  manager can see who is loaded before handing out another area. Omit it
   *  and rows render exactly as before. */
  areaCounts?: Record<number, number>;
  /** "glass" restyles for the dark-glass panels (lasso sheet, map cards):
   *  white-alpha chrome instead of the light token set. Behavior identical. */
  tone?: "light" | "glass";
}

/** First letter of the name for the ring avatar; "?" for a blank name. */
function initialOf(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "?";
}

export function RepPicker({
  reps, value, onChange, label, placeholder = "Search reps…",
  searchThreshold = ROSTER_SEARCH_THRESHOLD, disabled = false, maxRows = ROSTER_MAX_ROWS,
  multiple = false, selected = [], onToggle, areaCounts, tone = "light",
}: RepPickerProps) {
  // The richer row grammar only when the caller supplies the holdings map.
  const showStatus = areaCounts != null;
  const glass = tone === "glass";
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const showSearch = reps.length > searchThreshold;
  const recents = useRecentReps();

  const { shown, hidden, recentCount } = useMemo(() => {
    const hits = reps.filter((r) => matchPerson(r.name, q));
    // Reps with room first — the ones you can actually pick. Stable by name
    // inside each group so rows never jump around as you type.
    let ordered = [...hits].sort((a, b) =>
      Number(!!a.atCap) - Number(!!b.atCap) || a.name.localeCompare(b.name));
    let recentCount = 0;
    // Recents float only on a LONG list with an empty query: search results
    // must never reorder under the cursor, and a 6-rep team needs no shortcut.
    if (!q.trim() && showSearch && recents.length) {
      ordered = withRecentsFirst(ordered, recents);
      const recentSet = new Set(recents);
      while (recentCount < ordered.length && recentSet.has(ordered[recentCount].id)) recentCount++;
    }
    const shown = ordered.slice(0, maxRows);
    return { shown, hidden: ordered.length - shown.length, recentCount };
  }, [reps, q, maxRows, showSearch, recents]);

  const pick = (rep: RepOption) => {
    recordRecentRep(rep.id);
    if (!multiple) return onChange?.(rep.id);
    const next = selectedSet.has(rep.id)
      ? selected.filter((id) => id !== rep.id)
      : [...selected, rep.id];
    onToggle?.(rep.id, next);
  };

  // Keyboard: arrows move focus through the rendered rows (manual activation —
  // Enter/Space picks via the button itself; auto-select here would fire a
  // preview round-trip per keystroke on surfaces that preview per rep).
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  rowRefs.current.length = shown.length;
  const focusRow = (i: number) => rowRefs.current[i]?.focus();
  const onListKeyDown = (e: KeyboardEvent) => {
    if (!shown.length) return;
    const active = rowRefs.current.findIndex((el) => el === document.activeElement);
    let next: number | null = null;
    if (e.key === "ArrowDown") next = active < 0 ? 0 : Math.min(active + 1, shown.length - 1);
    else if (e.key === "ArrowUp") {
      if (active === 0 && showSearch) { e.preventDefault(); inputRef.current?.focus(); return; }
      next = active < 0 ? 0 : Math.max(active - 1, 0);
    }
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = shown.length - 1;
    if (next != null) { e.preventDefault(); focusRow(next); }
  };

  const mutedText = glass ? "text-white/60" : "text-muted-foreground";

  return (
    <div className="space-y-2">
      {label && <div className={`text-sm font-medium ${glass ? "text-white" : ""}`}>{label}</div>}

      {showSearch && (
        <div className="relative">
          <input
            ref={inputRef}
            type="text"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "ArrowDown") { e.preventDefault(); focusRow(0); } }}
            placeholder={placeholder}
            aria-label="Search reps"
            disabled={disabled}
            className={`w-full rounded-lg border py-2 pl-3 pr-8 text-sm disabled:opacity-50 ${
              glass
                ? "border-white/15 bg-white/5 text-white placeholder:text-white/40"
                : "bg-background"
            } ${FOCUS}`}
          />
          {q && (
            <button
              type="button"
              onClick={() => { setQ(""); inputRef.current?.focus(); }}
              aria-label="Clear search"
              className={`absolute right-2 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded ${mutedText} ${glass ? "hover:text-white" : "hover:text-foreground"} ${FOCUS}`}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      {shown.length === 0 ? (
        <div role="status" className={`rounded-lg border border-dashed p-3 text-sm ${mutedText} ${glass ? "border-white/20" : ""}`}>
          No rep matches “{q.trim()}”.
        </div>
      ) : (
        <ul
          role="listbox"
          aria-label={label ?? "Reps"}
          onKeyDown={onListKeyDown}
          className={`max-h-64 overflow-y-auto overscroll-contain rounded-lg border divide-y ${
            glass ? "border-white/15 divide-white/10" : ""
          }`}
        >
          {shown.map((rep, i) => {
            const isOn = multiple ? selectedSet.has(rep.id) : value === rep.id;
            const held = areaCounts?.[rep.id] ?? 0;
            return (
              <li key={rep.id}>
                {recentCount > 0 && i === 0 && (
                  <div aria-hidden="true" data-testid="rep-picker-recent-label"
                    className={`px-3 pt-2 pb-1 text-2xs font-bold uppercase tracking-wide ${mutedText}`}>
                    Recent
                  </div>
                )}
                {recentCount > 0 && i === recentCount && (
                  <div aria-hidden="true"
                    className={`px-3 pt-2 pb-1 text-2xs font-bold uppercase tracking-wide ${mutedText}`}>
                    Everyone
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={isOn}
                  tabIndex={i === 0 ? 0 : -1}
                  ref={(el) => { rowRefs.current[i] = el; }}
                  // A rep already ON the area is always removable, even at cap —
                  // otherwise a full rep could never be taken off anything.
                  disabled={disabled || (rep.atCap && !isOn)}
                  onClick={() => pick(rep)}
                  data-testid={`rep-option-${rep.id}`}
                  className={[
                    "w-full min-h-11 flex items-center justify-between gap-2 px-3 py-2.5 text-left text-sm transition",
                    rep.atCap && !isOn
                      ? "opacity-55 cursor-not-allowed"
                      : glass ? "hover:bg-white/[0.06]" : "hover:bg-secondary",
                    isOn ? (glass ? "bg-teal-500/[0.14]" : "bg-primary/10") : "",
                    glass ? "text-white" : "",
                    FOCUS,
                  ].join(" ")}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    {showStatus && (
                      // Ring in the rep's OWN colour — the same hue their pins,
                      // halos, and default area fill wear — so the picker teaches
                      // the mapping instead of painting every rep theme-primary.
                      <span
                        aria-hidden="true"
                        data-testid={`rep-avatar-${rep.id}`}
                        style={{ borderColor: repColorOf(rep) }}
                        className={`w-9 h-9 rounded-full border-2 flex items-center justify-center text-[12px] font-bold shrink-0 ${glass ? "text-white" : "text-foreground"}`}
                      >
                        {initialOf(rep.name)}
                      </span>
                    )}
                    {isOn && <Check className={`h-4 w-4 shrink-0 ${glass ? "text-teal-300" : "text-primary"}`} aria-hidden="true" />}
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{rep.name}</span>
                      {rep.detail && (
                        <span className={`block truncate text-[11px] tabular-nums ${mutedText}`}>{rep.detail}</span>
                      )}
                      {showStatus && (
                        <span
                          data-testid={`rep-status-${rep.id}`}
                          className={`flex items-center gap-1.5 text-[11px] ${mutedText}`}
                        >
                          <span
                            aria-hidden="true"
                            className={`h-1.5 w-1.5 rounded-full shrink-0 ${held > 0 ? "bg-success" : glass ? "bg-white/40" : "bg-muted-foreground"}`}
                          />
                          {held > 0 ? (
                            <>Assigned to <span className="tabular-nums">{held}</span> {held === 1 ? "area" : "areas"}</>
                          ) : (
                            "Unassigned"
                          )}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className={`shrink-0 text-xs tabular-nums ${mutedText}`}>
                    {rep.atCap
                      ? "At area limit"
                      : !showStatus && rep.areaCount != null
                        ? `${rep.areaCount} ${rep.areaCount === 1 ? "area" : "areas"}`
                        : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {hidden > 0 && (
        // Never silently truncate: a manager who can't find someone needs to know
        // the list is cut, not conclude the rep doesn't exist.
        <div className={`text-xs tabular-nums ${mutedText}`}>
          {hidden} more {hidden === 1 ? "rep" : "reps"} - keep typing to narrow the list.
        </div>
      )}
    </div>
  );
}

export default RepPicker;
