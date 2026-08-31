// ── Lasso rep picker ─────────────────────────────────────────────────────────
// The Assign flow's "who gets these doors" control, as rows a manager can
// read instead of a native select: the rep's initials, their name, how many
// doors they already hold on this map and how many they knocked today, and a
// radio mark on the chosen one. Sits on the lasso panel's dark glass, so the
// chrome is white-alpha like its neighbours (the panel re-asserts the dark
// token set for anything semantic).
import { useMemo, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { FOCUS } from "@/lib/a11y";
import { useRovingTabs } from "@/hooks/use-roving-tabs";
import {
  matchPerson,
  withRecentsFirst,
  ROSTER_SEARCH_THRESHOLD,
  ROSTER_MAX_ROWS,
} from "@/lib/rosterSearch";
import { useRecentReps, recordRecentRep } from "@/hooks/use-recent-reps";

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
  /** Doors in the selection ALREADY held by the chosen rep. Subtracted from
   *  the projection — without it "will have N doors" counted those twice
   *  (once in the rep's current holdings, once in the selection). */
  ownedByChosen?: number;
}

const PALETTE = ["#38bdf8", "#34d399", "#fbbf24", "#a78bfa", "#fb7185", "#22d3ee", "#a3e635", "#e879f9"];
// Team colours are saturated and arbitrary, and a mid-tone like violet clears
// 4.5:1 under neither ink. Keep the colour when dark ink reads on it; when it
// does not, settle the fill toward the glass ink just far enough for white
// ink to read. Every initial then clears AA on every colour a team can pick.
const INK_RGB = [9, 17, 26] as const;
function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as [number, number, number] : null;
}
function luminance([r, g, b]: readonly number[]): number {
  const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: readonly number[], b: readonly number[]): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
export function avatarColors(hex: string): { background: string; color: string } {
  const rgb = hexToRgb(hex);
  if (!rgb) return { background: hex, color: "#FFFFFF" };
  if (contrast(rgb, [7, 17, 27]) >= 4.5) return { background: hex, color: "#07111B" };
  for (let mix = 0.1; mix <= 0.6; mix += 0.05) {
    const c = rgb.map((v, i) => Math.round(v * (1 - mix) + INK_RGB[i] * mix));
    if (contrast(c, [255, 255, 255]) >= 4.5) {
      return { background: "#" + c.map((v) => v.toString(16).padStart(2, "0")).join(""), color: "#FFFFFF" };
    }
  }
  return { background: hex, color: "#FFFFFF" };
}
export const initialsOf = (name: string) =>
  name.trim().split(/\s+/).map((p) => p[0] ?? "").join("").slice(0, 2).toUpperCase() || "?";
const fmt = (n: number) => n.toLocaleString("en-US");

export function LassoRepPicker({ reps, value, onChange, selectionCount, ownedByChosen = 0 }: LassoRepPickerProps) {
  const chosen = reps.find((r) => String(r.id) === value) ?? null;
  // The scale contract (lib/rosterSearch): past ROSTER_SEARCH_THRESHOLD reps a
  // search box appears, at most ROSTER_MAX_ROWS rows render (with an honest
  // count of the rest), and with an empty query the reps this device assigned
  // to recently float to the top. A 6-rep crew sees exactly the old picker;
  // a 300-rep org types three letters instead of scroll-hunting 15,000px.
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const recents = useRecentReps();
  const showSearch = reps.length > ROSTER_SEARCH_THRESHOLD;
  const { shown, hidden } = useMemo(() => {
    let ordered = reps.filter((r) => matchPerson(r.name, q));
    if (!q.trim() && showSearch && recents.length) ordered = withRecentsFirst(ordered, recents);
    const shown = ordered.slice(0, ROSTER_MAX_ROWS);
    return { shown, hidden: ordered.length - shown.length };
  }, [reps, q, showSearch, recents]);
  const pick = (id: number) => {
    recordRecentRep(id);
    onChange(String(id));
  };
  // The radiogroup role promises arrow-key movement ("1 of N, use arrow
  // keys") - deliver it over the RENDERED rows. With nothing chosen yet,
  // the first row is the tab stop.
  const chosenIdx = shown.findIndex((r) => String(r.id) === value);
  const roving = useRovingTabs(shown.length, Math.max(0, chosenIdx), (i) => pick(shown[i].id));
  // Net new doors for the chosen rep: the selection minus what they already
  // hold in it. Clamped — a stale count must never project a negative gain.
  const gained = Math.max(0, selectionCount - ownedByChosen);
  return (
    <div data-testid="lasso-rep-picker">
      {showSearch && (
        <div className="relative mb-1.5">
          <input
            ref={inputRef}
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search reps…"
            aria-label="Search reps"
            data-testid="lasso-rep-search"
            className={`h-10 w-full rounded-lg border border-white/15 bg-white/5 px-3 pr-8 text-[13px] text-white placeholder:text-white/40 ${FOCUS}`}
          />
          {q && (
            <button
              type="button"
              onClick={() => { setQ(""); inputRef.current?.focus(); }}
              aria-label="Clear search"
              className={`absolute right-1.5 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-white/50 hover:text-white ${FOCUS}`}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      <div
        role="radiogroup"
        aria-label="Assign to"
        onKeyDown={roving.onKeyDown}
        className="flex max-h-[236px] flex-col gap-0.5 overflow-y-auto overscroll-contain pr-0.5"
      >
        {reps.length === 0 && (
          <p className="px-2 py-3 text-[12px] text-white/60">No active reps on your team yet.</p>
        )}
        {reps.length > 0 && shown.length === 0 && (
          <p role="status" className="px-2 py-3 text-[12px] text-white/60">
            No rep matches “{q.trim()}”.
          </p>
        )}
        {shown.map((r, i) => {
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
              tabIndex={on || (chosenIdx < 0 && i === 0) ? 0 : -1}
              ref={roving.itemRef(i)}
              data-testid={`lasso-rep-${r.id}`}
              onClick={() => pick(r.id)}
              className={`flex min-h-[52px] w-full items-center gap-2.5 rounded-xl border px-2 py-1.5 text-left transition active:bg-white/[0.10] ${FOCUS} ${
                on ? "border-teal-300/55 bg-teal-500/[0.14]" : "border-transparent hover:bg-white/[0.05]"
              }`}
            >
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-bold"
                // Team colours are saturated and arbitrary (a rep's blue measured
                // 3.7:1 under dark ink), so the initials pick their ink by contrast.
                style={avatarColors(r.color || PALETTE[i % PALETTE.length])}
              >
                {initialsOf(r.name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-white">{r.name}</span>
                <span className="block truncate text-[11.5px] tabular-nums text-white/75">{load}</span>
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
      {hidden > 0 && (
        // Never silently truncate: a manager who can't find someone must learn
        // the list is cut, not conclude the rep doesn't exist.
        <p className="mt-1 px-1 text-[11px] tabular-nums text-white/50" data-testid="lasso-rep-hidden">
          {hidden} more {hidden === 1 ? "rep" : "reps"} - keep typing to narrow the list.
        </p>
      )}
      {chosen && selectionCount > 0 && (
        // Only server-authoritative numbers: the gain comes from the preview
        // (total minus doors already theirs). The old "will have N doors"
        // added that gain to a VIEWPORT-SAMPLED holdings figure, so it read
        // as the rep's total while undercounting exactly when selections were
        // large. And the undo window is the server's 10 minutes, not 30s.
        <p className="mt-2 text-[12px] leading-snug tabular-nums text-white/70" data-testid="lasso-assign-preview">
          {chosen.name.split(/\s+/)[0]} gains {fmt(gained)} {gained === 1 ? "door" : "doors"}
          {ownedByChosen > 0 ? ` (${fmt(ownedByChosen)} here already theirs)` : ""}. You can undo for 10 minutes after.
        </p>
      )}
    </div>
  );
}

export default LassoRepPicker;
