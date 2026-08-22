// ── Quick appointment slots ──────────────────────────────────────────────────
// The four soonest sensible return-visit times as one-tap chips above the
// date/time pickers, so booking a return visit is one tap instead of two
// pickers. The times come from shared/schedule.ts (the Schedule page reads the
// same helper), and a tap only FILLS the date and time: the rep still confirms
// with Set, exactly as before. Two surfaces, one row: "glass" for the map
// card's fixed-dark sheet, "card" for the themed OutcomeSheet.
import { useMemo } from "react";
import { quickSlots, type QuickSlot } from "@shared/schedule";

export interface QuickSlotRowProps {
  date: string;
  time: string;
  onPick: (slot: QuickSlot) => void;
  surface?: "glass" | "card";
  /** Injected for tests; defaults to the device clock at open. */
  now?: Date;
}

export function QuickSlotRow({ date, time, onPick, surface = "glass", now }: QuickSlotRowProps): JSX.Element {
  // Computed once per open (not per keystroke): the row must not reshuffle
  // under a thumb because the clock ticked past a half hour.
  const slots = useMemo(() => quickSlots(now ?? new Date()), [now]);
  return (
    <div
      role="group"
      aria-label="Quick times"
      data-testid="appt-slots"
      // Bleeds to the editor's edge so a half-visible chip advertises the
      // scroll; snap keeps a flick landing on whole chips.
      className="-mx-3 px-3 mb-2.5 flex gap-2 overflow-x-auto overscroll-x-contain snap-x scrollbar-none"
    >
      {slots.map((s, i) => {
        const selected = s.date === date && s.time === time;
        const idle = surface === "glass"
          ? "bg-white/[0.05] border-white/[0.10] text-white/85"
          : "bg-card border-border text-foreground";
        return (
          <button
            key={s.label}
            type="button"
            aria-pressed={selected}
            data-testid={`appt-slot-${i}`}
            onClick={() => onPick(s)}
            className={`shrink-0 snap-start h-11 px-3.5 rounded-full border text-[12.5px] font-semibold whitespace-nowrap tap-press ${
              selected ? "bg-primary border-primary text-primary-foreground" : idle
            }`}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

export default QuickSlotRow;
