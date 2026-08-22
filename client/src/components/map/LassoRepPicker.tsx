// ── Lasso rep picker ─────────────────────────────────────────────────────────
// The Assign flow's "who gets these doors" control, as rows a manager can
// read instead of a native select: the rep's initials, their name, how many
// doors they already hold on this map and how many they knocked today, and a
// radio mark on the chosen one. Sits on the lasso panel's dark glass, so the
// chrome is white-alpha like its neighbours (the panel re-asserts the dark
// token set for anything semantic).
import { Check } from "lucide-react";
import { FOCUS } from "@/lib/a11y";

export interface PickerRep {
  id: number;
  name: string;
  /** The rep's map colour when one is set; otherwise a stable palette pick. */
  color?: string | null;
  /** Doors this rep holds on the map right now. */
  doors: number;
  /** Knocks today, when the leaderboard has answered; null while unknown. */
  knockedToday?: number | null;
}

export interface LassoRepPickerProps {
  reps: PickerRep[];
  value: string;               // selected rep id as a string, "" for none
  onChange: (id: string) => void;
  /** Doors in the refined selection: drives the "will have" preview. */
  selectionCount: number;
}

const PALETTE = ["#38bdf8", "#34d399", "#fbbf24", "#a78bfa", "#fb7185", "#22d3ee", "#a3e635", "#e879f9"];
export const initialsOf = (name: string) =>
  name.trim().split(/\s+/).map((p) => p[0] ?? "").join("").slice(0, 2).toUpperCase() || "?";
const fmt = (n: number) => n.toLocaleString("en-US");

export function LassoRepPicker({ reps, value, onChange, selectionCount }: LassoRepPickerProps) {
  const chosen = reps.find((r) => String(r.id) === value) ?? null;
  return (
    <div data-testid="lasso-rep-picker">
      <div
        role="radiogroup"
        aria-label="Assign to"
        className="flex max-h-[236px] flex-col gap-0.5 overflow-y-auto overscroll-contain pr-0.5"
      >
        {reps.length === 0 && (
          <p className="px-2 py-3 text-[12px] text-white/60">No active reps on your team yet.</p>
        )}
        {reps.map((r, i) => {
          const on = String(r.id) === value;
          const load = r.knockedToday != null
            ? `${fmt(r.doors)} doors · ${fmt(r.knockedToday)} knocked today`
            : `${fmt(r.doors)} doors`;
          return (
            <button
              key={r.id}
              type="button"
              role="radio"
              aria-checked={on}
              data-testid={`lasso-rep-${r.id}`}
              onClick={() => onChange(String(r.id))}
              className={`flex min-h-[52px] w-full items-center gap-2.5 rounded-xl border px-2 py-1.5 text-left transition ${FOCUS} ${
                on ? "border-teal-300/55 bg-teal-500/[0.14]" : "border-transparent hover:bg-white/[0.05]"
              }`}
            >
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-[#07111b]"
                style={{ background: r.color || PALETTE[i % PALETTE.length] }}
              >
                {initialsOf(r.name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-white">{r.name}</span>
                <span className="block truncate text-[11.5px] tabular-nums text-white/55">{load}</span>
              </span>
              <span
                aria-hidden="true"
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${on ? "bg-teal-300 text-[#04241f]" : "border-[1.5px] border-white/25"}`}
              >
                {on && <Check className="h-3 w-3" strokeWidth={3} />}
              </span>
            </button>
          );
        })}
      </div>
      {chosen && selectionCount > 0 && (
        <p className="mt-2 text-[12px] leading-snug tabular-nums text-white/70" data-testid="lasso-assign-preview">
          {chosen.name.split(/\s+/)[0]} will have {fmt(chosen.doors + selectionCount)} doors after this. You can undo for 30 seconds.
        </p>
      )}
    </div>
  );
}

export default LassoRepPicker;
