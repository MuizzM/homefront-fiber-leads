// ── Nearest doors strip ──────────────────────────────────────────────────────
// The rep's next three doors, ordered by live distance from where they are
// standing, as a thumb-height row over the bottom of the field map. It is the
// "Next door" FAB grown up: instead of flying to ONE door it shows the nearest
// open doors with an honest distance each, lights "At door" under 60 m, and a
// tap opens that door's card exactly as a pin tap does. Device-local only: the
// position feeding it never leaves the phone (see docs/FIELD_LOCATION_PRIVACY.md
// for what the app does collect, and when).
//
// Minimal-chrome rule: the strip renders only when the rep has a fix, there is
// at least one open door within the radius, and nothing else owns the bottom
// of the map (no card, no lasso, no scan). The X hides it for the session and
// hands the slot back to the Next-door FAB.
import { X, LocateFixed } from "lucide-react";
import { FOCUS } from "@/lib/a11y";
import { distanceHint, pinDisplayState, STATE_COLORS, STATE_LABELS, type RoutablePin } from "@shared/knock";
import { STATUS_CONFIG, isLeadMapStatus } from "@shared/statusConfig";
import type { RankedDoor } from "@shared/nearestDoors";
import { relativeTime, MUTED } from "@/components/lead-sheet/utils";

export interface StripPin extends RoutablePin {
  address: string;
  lastKnockedAt?: string | null;
}

export interface NearestDoorsStripProps {
  doors: RankedDoor<StripPin>[];
  /** Open doors inside the radius, for the "3 of 12 nearby" count. */
  nearbyTotal: number;
  onOpen: (pin: StripPin) => void;
  onHide: () => void;
  style?: React.CSSProperties;
}

export function NearestDoorsStrip({ doors, nearbyTotal, onOpen, onHide, style }: NearestDoorsStripProps) {
  if (doors.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Nearest doors"
      data-testid="nearest-doors"
      style={style}
      // glass-ink-scope: the cards are dark in both app themes, so the At door
      // chip's success token must resolve to the dark palette (the light one
      // measured about 3:1 on this glass).
      className="absolute inset-x-0 z-20 pointer-events-none glass-ink-scope"
    >
      <div className="flex items-center gap-2 pl-3 pb-2">
        <span className="glass-capsule glass-opaque pointer-events-auto inline-flex h-7 items-center gap-1.5 pl-3 pr-1 text-2xs font-semibold text-white/85 tabular-nums">
          Nearest doors
          <span className="text-white/50" data-testid="nearest-doors-count">{doors.length} of {nearbyTotal} nearby</span>
          <button
            type="button"
            onClick={onHide}
            aria-label="Hide nearest doors"
            data-testid="nearest-doors-hide"
            className={`tap-expand relative ml-0.5 flex h-6 w-6 items-center justify-center rounded-full text-white/60 hover:bg-white/10 hover:text-white ${FOCUS}`}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </span>
      </div>
      <div className="pointer-events-auto flex gap-2.5 overflow-x-auto overscroll-x-contain snap-x scrollbar-none px-3">
        {doors.map(({ pin, meters, atDoor }, i) => {
          const ds = pinDisplayState(pin);
          const color = STATE_COLORS[ds];
          const status = isLeadMapStatus(ds) ? STATUS_CONFIG[ds] : null;
          const ink = status?.onDark ?? color;
          const rel = relativeTime(pin.lastKnockedAt);
          const meta = ds === "unworked" ? "Never knocked" : rel ? `Last ${rel}` : "";
          return (
            <button
              key={pin.id}
              type="button"
              onClick={() => onOpen(pin)}
              data-testid={`nearest-door-${pin.id}`}
              data-dist-m={Math.round(meters)}
              aria-label={`${pin.address}, ${atDoor ? "at door" : distanceHint(meters) + " away"}, ${STATE_LABELS[ds]}`}
              // glass-opaque: the ink at 0.94, no blur. Measured over light street
              // tiles the panel glass (0.74) left 12px muted text at 2.8:1 and the
              // green Prospect label at 2.6:1; the opaque fill clears 4.5:1 for
              // every status colour and saves three blurred surfaces on a phone GPU.
              className={`glass-surface glass-opaque snap-start flex w-[272px] shrink-0 flex-col gap-1 rounded-[20px] px-3.5 py-3 text-left active:scale-[0.98] transition-transform ${FOCUS} ${
                i === 0 && atDoor ? "ring-[1.5px] ring-success/45" : ""
              }`}
            >
              <span className="flex items-center gap-2 min-w-0">
                <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
                <span className="flex-1 min-w-0 truncate text-[15px] font-semibold text-white">{pin.address}</span>
                <span
                  // At door is THE signal on this surface, so it is a filled pill
                  // with dark ink (9:1), not a tint whose ink measured 3.2:1.
                  className={`inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-2xs font-bold tabular-nums ${
                    atDoor ? "bg-success text-[#04241f]" : "border border-white/10 bg-white/[0.06] text-white/85"
                  }`}
                >
                  <LocateFixed aria-hidden="true" className="h-3 w-3" />
                  {atDoor ? "At door" : distanceHint(meters)}
                </span>
              </span>
              <span className="truncate pl-[18px] text-[12px]" style={{ color: MUTED }}>
                <span className="font-semibold" style={{ color: ink }}>{STATE_LABELS[ds]}</span>
                {meta ? ` · ${meta}` : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default NearestDoorsStrip;
