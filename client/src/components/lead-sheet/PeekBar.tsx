import { X, type LucideIcon } from "lucide-react";
import { relativeTime } from "./utils";
import { StatusPinChip } from "./StatusPinChip";

export interface PeekBarProps {
  address: string;
  pinColor: string;          // the pin fill (chip)
  statusIcon?: LucideIcon;
  statusColor: string;       // the readable status ink (onDark)
  statusLabel: string;
  lastKnockedAt?: string | null;
  freshFiber: boolean;
  directionsHref: string;
  onClose: () => void;
  /** The short-lived Undo chip after a mark (shell-owned). */
  undo?: React.ReactNode;
  /** The post-mark next step (Set a time / Next door), shell-owned. */
  followThrough?: React.ReactNode;
  /** The outcome just marked on this door: pops the chip once as the visible
   *  confirmation (the tapped disc leaves the viewport during the collapse). */
  pop?: string | null;
}

// Copy and close share one control: a 36px glass disc with a 44px hit area.
// The close disc is the same at every level (peek included) so it is found
// without looking.
export const circleBtn =
  "relative shrink-0 h-9 w-9 flex items-center justify-center rounded-full bg-white/[0.08] border border-white/[0.12] text-white/80 hover:bg-white/[0.14] hover:text-white tap-press [--press-scale:0.9] after:absolute after:-inset-1";

export function PeekBar(props: PeekBarProps): JSX.Element {
  const {
    address, pinColor, statusIcon, statusColor, statusLabel, lastKnockedAt, freshFiber,
    directionsHref, onClose, undo, followThrough, pop = null,
  } = props;
  const lastRel = relativeTime(lastKnockedAt);
  const freshness = freshFiber ? "Fresh fiber" : lastRel ? `Last ${lastRel}` : "";
  return (
    <div data-testid="knock-peek-bar" className="px-4 pb-2.5 pt-0.5">
      <div className="flex items-center gap-2.5 min-w-0">
        <span key={pop ?? "idle"} className={`inline-flex shrink-0 ${pop ? "status-pop" : ""}`}>
          <StatusPinChip color={pinColor} icon={statusIcon} size={28} data-testid="knock-peek-dot" iconTestId="knock-peek-status-icon" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="min-w-0 text-[15px] leading-tight font-semibold text-white truncate">
            {address}
          </h2>
          <div className="mt-0.5 text-[12px] leading-tight flex items-center min-w-0">
            <span className="truncate min-w-0">
              <span key={statusLabel} data-testid="knock-peek-status" className="font-semibold card-swap-in" style={{ color: statusColor }}>
                {statusLabel}
              </span>
              {freshness && <span className="text-white/45"> · {freshness}</span>}
            </span>
            {undo}
          </div>
        </div>
        {/* ONE primary action in peek: get to the door. */}
        <a
          data-testid="peek-action-directions"
          href={directionsHref}
          target="_blank"
          rel="noopener"
          aria-label={`Directions to ${address}`}
          className="relative shrink-0 h-9 px-3.5 rounded-full bg-sky-500/15 border border-sky-400/30 text-sky-300 inline-flex items-center text-[12.5px] font-semibold hover:bg-sky-500/25 tap-press after:absolute after:-inset-1"
        >
          Directions
        </a>
        <button
          type="button"
          data-testid="knock-peek-close"
          aria-label="Close"
          onClick={onClose}
          className={circleBtn}
        >
          <X className="w-[17px] h-[17px]" />
        </button>
      </div>
      {followThrough}
    </div>
  );
}

export default PeekBar;
