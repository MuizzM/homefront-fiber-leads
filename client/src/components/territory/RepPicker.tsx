import { useMemo, useRef, useState } from "react";
import { Search, X, Check } from "lucide-react";

// Choosing who gets an area.
//
// This replaced a plain <select>. That works for six reps and collapses at
// forty: no search, no way to see who is already loaded up, and on mobile it
// becomes a full-screen wheel you scroll blind. Assignment is the single most
// frequent territory action, so it gets a real picker.
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
}

export interface RepPickerProps {
  reps: RepOption[];
  value?: number | null;
  onChange: (repId: number) => void;
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
}

/** Match on any word start, so "riv" finds "Ann Rivera" and "ann" does too —
 *  with a substring fallback, so "iver" finds her as well. The fallback is
 *  deliberate leniency for a name box, but it is NOT what this comment used to
 *  claim (word-start only), and shared/territoryFilter.ts implements the
 *  stricter documented rule. Two search behaviours in one product is a real
 *  inconsistency; unifying them is a product decision, not a tidy-up, so it is
 *  flagged here rather than silently changed in either direction. */
function matches(name: string, q: string): boolean {
  const n = name.toLowerCase();
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return needle.split(/\s+/).every(term =>
    n.split(/\s+/).some(word => word.startsWith(term)) || n.includes(term));
}

export function RepPicker({
  reps, value, onChange, label, placeholder = "Search reps…",
  searchThreshold = 8, disabled = false, maxRows = 60,
  multiple = false, selected = [], onToggle,
}: RepPickerProps) {
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const showSearch = reps.length > searchThreshold;

  const filtered = useMemo(() => {
    const hits = reps.filter(r => matches(r.name, q));
    // Reps with room first — the ones you can actually pick. Stable by name
    // inside each group so rows never jump around as you type.
    return [...hits].sort((a, b) =>
      Number(!!a.atCap) - Number(!!b.atCap) || a.name.localeCompare(b.name));
  }, [reps, q]);

  const shown = filtered.slice(0, maxRows);
  const hidden = filtered.length - shown.length;

  return (
    <div className="space-y-2">
      {label && <div className="text-sm font-medium">{label}</div>}

      {showSearch && (
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder={placeholder}
            aria-label="Search reps"
            disabled={disabled}
            className="w-full rounded-lg border bg-background py-2 pl-8 pr-8 text-sm disabled:opacity-50"
          />
          {q && (
            <button
              type="button"
              onClick={() => { setQ(""); inputRef.current?.focus(); }}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      {filtered.length === 0 ? (
        <div role="status" className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          No rep matches “{q.trim()}”.
        </div>
      ) : (
        <ul role="listbox" aria-label={label ?? "Reps"} className="max-h-64 overflow-y-auto rounded-lg border divide-y">
          {shown.map(rep => {
            const isOn = multiple ? selectedSet.has(rep.id) : value === rep.id;
            return (
              <li key={rep.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isOn}
                  // A rep already ON the area is always removable, even at cap —
                  // otherwise a full rep could never be taken off anything.
                  disabled={disabled || (rep.atCap && !isOn)}
                  onClick={() => {
                    if (!multiple) return onChange(rep.id);
                    const next = selectedSet.has(rep.id)
                      ? selected.filter((id) => id !== rep.id)
                      : [...selected, rep.id];
                    onToggle?.(rep.id, next);
                  }}
                  data-testid={`rep-option-${rep.id}`}
                  className={[
                    "w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left text-sm transition",
                    rep.atCap && !isOn ? "opacity-55 cursor-not-allowed" : "hover:bg-secondary",
                    isOn ? "bg-primary/10" : "",
                  ].join(" ")}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    {isOn && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
                    <span className="truncate font-medium">{rep.name}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {rep.atCap
                      ? "At area limit"
                      : rep.areaCount != null
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
        <div className="text-xs text-muted-foreground">
          {hidden} more {hidden === 1 ? "rep" : "reps"} — keep typing to narrow the list.
        </div>
      )}
    </div>
  );
}

export default RepPicker;
