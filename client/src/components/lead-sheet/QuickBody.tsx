import { DispositionGrid } from "./OutcomeButton";
import { validPhone, MUTED, BODY_TEXT } from "./utils";
import type { KnockOutcome } from "@shared/knock";

export interface QuickBodyProps {
  directionsHref: string;
  phone?: string | null;
  activeOutcome: KnockOutcome | null;
  flashKey: KnockOutcome | null;
  onStatusTap: (key: KnockOutcome) => void;
  outcomesDisabled?: boolean;
  // Live distance chip (shell-owned: needs the GPS fix state) — rendered at the
  // end of the action row; null when no honest distance exists.
  proximity?: React.ReactNode;
  // What the scanner already knows about this door (competitor, occupancy):
  // shell-owned chips under the status line so the rep reads them BEFORE the
  // knock. Null when nothing is known.
  facts?: React.ReactNode;
  // The follow-through pair (appointment + note composers) and, in the docked
  // panel, the post-mark suggestion. Shell-owned: they carry the save model.
  followThrough: React.ReactNode;
  // Recent-activity line
  recent: { label: string; who: string | null; time: string } | null;
  // Pinned latest note (shell-owned quote block).
  latestNote: React.ReactNode;
}

// The action row: getting to the door, calling it, and how far away it is.
// Directions is the one thing a rep standing on a sidewalk needs instantly, so
// it takes the primary (sky) weight and the width; Call shares the tint only
// when a dialable number exists. Both are 44px (h-11): one row, one height.
const tintBtn =
  "relative h-11 rounded-full bg-sky-500/15 border border-sky-400/30 text-sky-300 font-semibold text-[13.5px] inline-flex items-center justify-center px-5 whitespace-nowrap hover:bg-sky-500/25 hover:text-sky-200 tap-press [--press-scale:0.97] after:absolute after:-inset-1";

export function QuickBody(props: QuickBodyProps): JSX.Element {
  const {
    directionsHref, phone,
    activeOutcome, flashKey, onStatusTap,
    outcomesDisabled = false, proximity, facts, followThrough,
    recent, latestNote,
  } = props;

  return (
    <>
      {facts}

      {/* Field Map leads carry a phone only for authorized callers, so Call
          renders ONLY when a valid number exists. The proximity chip sits at
          the far end: same row as Directions because they answer the same
          question ("how do I get to this door?"). */}
      <div data-testid="knock-action-row" className="flex items-center gap-2 pt-1">
        <a
          data-testid="action-directions"
          href={directionsHref}
          target="_blank"
          rel="noopener"
          aria-label="Directions"
          className={`${tintBtn} flex-1 min-w-0`}
        >
          Directions
        </a>
        {validPhone(phone) && (
          <a
            data-testid="action-call"
            href={`tel:${phone}`}
            aria-label="Call this lead"
            className={`${tintBtn} flex-1 min-w-0`}
          >
            Call
          </a>
        )}
        {proximity}
      </div>

      {/* THE disposition surface: every field disposition as the same disc, in
          FIXED order, one tap saves immediately; the active disc mirrors the
          lead's current display state in place. */}
      <DispositionGrid
        className="mt-3"
        activeOutcome={activeOutcome}
        flashKey={flashKey}
        onTap={onStatusTap}
        disabled={outcomesDisabled}
      />
      {outcomesDisabled && (
        <p className="mt-2 text-[12px] font-semibold text-destructive" role="status">
          Outcome logging is blocked for this address.
        </p>
      )}

      {followThrough}

      {/* Recent-activity line: the last thing that happened at this door. */}
      {recent && (
        <div data-testid="knock-recent" className="mt-3 text-[12px] truncate" style={{ color: MUTED }}>
          <span className="font-semibold" style={{ color: BODY_TEXT }}>Last:</span>{" "}
          {[recent.label, recent.who, recent.time].filter(Boolean).join(" · ")}
        </div>
      )}

      {latestNote}
    </>
  );
}

export default QuickBody;
