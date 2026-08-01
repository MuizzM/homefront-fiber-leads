import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { REP_PALETTE } from "@shared/repColors";
import { normalizeTerritoryColor } from "@shared/territory";

// Choosing the colour BEFORE the area is drawn.
//
// The colour describes the ground, not the person: two reps sharing a patch see
// one colour, and a manager scanning the map reads "that's the Inman sweep" from
// the hue. Before this existed the save endpoint stamped colorForRep(repId), so
// an area silently inherited whichever rep happened to be listed first and the
// colour changed the moment the area was handed to someone else.
//
// It sits in a bottom bar that already holds a name field, a rep select and a
// Save button, so the closed state is a single swatch. The grid only opens on
// demand.

/** The bright band of the shared rep palette. Reusing it keeps ONE colour
 *  vocabulary across pins, halos and areas rather than inventing a second set
 *  that looks almost-but-not-quite the same. The deep band is deliberately left
 *  out: at area-fill opacity the dark hues read as grey. */
export const TERRITORY_SWATCHES: readonly string[] = REP_PALETTE.slice(0, 12);

export interface TerritoryColorPickerProps {
  value: string;
  onChange: (color: string) => void;
  colors?: readonly string[];
  disabled?: boolean;
  label?: string;
  /** Which way the grid opens. "up" suits the lasso bottom bar this was built
   *  for. The territory detail panel sits at the TOP of the viewport inside an
   *  overflow-y-auto container, where an upward popover lands in the container's
   *  negative overflow — clipped, unreachable, invisible — so that surface
   *  passes "down" and the grid overlays content that actually exists. */
  direction?: "up" | "down";
}

export function TerritoryColorPicker({
  value,
  onChange,
  colors = TERRITORY_SWATCHES,
  disabled = false,
  label = "Area colour",
  direction = "up",
}: TerritoryColorPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = normalizeTerritoryColor(value) ?? colors[0];

  // Close on outside click and on Escape. Without this the grid survives the tap
  // that starts the next stroke and floats over the map you're drawing on.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative flex-shrink-0">
      <button
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="true"
        aria-expanded={open}
        data-testid="territory-color-trigger"
        onClick={() => setOpen((v) => !v)}
        className="h-11 w-11 rounded-full border-2 border-white/25 disabled:opacity-40 flex items-center justify-center"
        style={{ backgroundColor: current }}
      >
        {/* The swatch IS the affordance — a glyph on top would fight the colour
            it is meant to show. Screen readers get the name from aria-label. */}
        <span className="sr-only">{current}</span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={label}
          data-testid="territory-color-grid"
          className={`absolute ${direction === "up" ? "bottom-[calc(100%+8px)]" : "top-[calc(100%+8px)]"} left-0 z-50 grid grid-cols-6 gap-1.5 rounded-2xl bg-[#0b1f1c]/95 p-2 shadow-xl ring-1 ring-white/15 backdrop-blur`}
        >
          {colors.map((color) => {
            const isOn = color.toLowerCase() === current.toLowerCase();
            return (
              <button
                key={color}
                type="button"
                role="option"
                aria-selected={isOn}
                aria-label={color}
                data-testid={`territory-color-${color.replace("#", "").toLowerCase()}`}
                onClick={() => { onChange(color); setOpen(false); }}
                className="h-7 w-7 rounded-full border border-white/20 flex items-center justify-center"
                style={{ backgroundColor: color }}
              >
                {isOn && <Check className="h-3.5 w-3.5 text-white drop-shadow" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default TerritoryColorPicker;
