import { X } from "lucide-react";
import { relativeTime } from "./utils";

export interface PeekBarProps {
  address: string;
  statusColor: string;
  statusLabel: string;
  lastKnockedAt?: string | null;
  freshFiber: boolean;
  directionsHref: string;
  onClose: () => void;
}

export function PeekBar(props: PeekBarProps): JSX.Element {
  const { address, statusColor, statusLabel, lastKnockedAt, freshFiber, directionsHref, onClose } = props;
  const lastRel = relativeTime(lastKnockedAt);
  const freshness = freshFiber ? "Fresh fiber" : lastRel ? `Last ${lastRel}` : "";
  return (
    <div data-testid="knock-peek-bar" className="px-4 pb-2.5 pt-0.5">
      <div className="flex items-center gap-2.5 min-w-0">
        <span
          aria-hidden
          className="w-2.5 h-2.5 rounded-full shrink-0"
          style={{ background: statusColor }}
        />
        <h2 className="min-w-0 flex-1 text-[15px] leading-tight font-semibold text-white truncate">
          {address}
        </h2>
        {/* ONE primary action in peek: get to the door. */}
        <a
          data-testid="peek-action-directions"
          href={directionsHref}
          target="_blank"
          rel="noopener"
          aria-label={`Directions to ${address}`}
          className="relative shrink-0 h-9 px-3 rounded-full bg-white/[0.07] border border-white/[0.1] inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-white active:scale-95 transition after:absolute after:-inset-1"
        >
          
          Directions
        </a>
        <button
          type="button"
          data-testid="knock-peek-close"
          aria-label="Close"
          onClick={onClose}
          className="relative shrink-0 h-9 w-9 flex items-center justify-center rounded-full text-white/50 hover:text-white hover:bg-white/10 active:scale-90 transition after:absolute after:-inset-1"
        >
          <X className="w-[18px] h-[18px]" />
        </button>
      </div>
      <div className="mt-1 pl-[22px] text-[12px] leading-tight truncate">
        <span data-testid="knock-peek-status" className="font-semibold" style={{ color: statusColor }}>
          {statusLabel}
        </span>
        {freshness && <span className="text-white/45"> · {freshness}</span>}
      </div>
    </div>
  );
}

export default PeekBar;
