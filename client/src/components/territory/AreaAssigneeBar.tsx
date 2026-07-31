// Who works this area — edited on the map, on the area itself.
//
// The set of holders was already editable, but only down a path: tap the area,
// the detail card opens, scroll to the bottom, "Who works this area", a modal
// opens over the map you were just looking at. Four steps and a full-screen
// takeover to add one rep to one polygon, which is the single most common thing
// a manager does out in the field.
//
// This is the same decision surfaced where the decision is made. It sits low
// over the map with the ground still visible above it (Abode's pin editor is the
// reference), so you can see the polygon you are assigning while you assign it.
//
// Three details are deliberate:
//
//   * SELECTION IS A BADGE ON THE TILE, not a checkbox in a column (Fi). At this
//     size a column of checkboxes doubles the height for no added meaning.
//   * ADD IS ITS OWN LABELLED TILE (Bump), not a "+" tacked onto the end of the
//     avatar strip. A 16px glyph between two faces is a mis-tap generator, and
//     "Add rep" says what it does without being learned.
//   * THE COLOUR DOT IS THE AREA'S COLOUR, never a holder's. One area is one
//     colour for everybody looking at it, however many reps are on it — the rep
//     hues on the avatars identify PEOPLE, which is a different question.
//
// Removal is two-step because it is not just a list edit: dropping a rep hands
// their doors back, so a mis-tap costs someone their working queue.

import { useState } from "react";
import { Loader2, Plus, Users, X } from "lucide-react";
import { FOCUS } from "@/lib/a11y";
import { repColorOf } from "@shared/repColors";
import { RepPicker } from "./RepPicker";

export interface AssignableRep {
  id: number;
  name: string;
  /** Areas this rep already holds — handing a seventh to someone at the cap is
   *  the mistake this number exists to prevent. */
  areaCount: number;
  atCap: boolean;
  /** Persisted rep colour (team_members.color); absent → legacy hash hue. */
  color?: string | null;
}

export interface AreaAssigneeBarProps {
  areaName: string;
  /** The AREA's colour. Not a rep's. */
  color: string;
  reps: AssignableRep[];
  /** Current holders, in order. The first is the primary. */
  assigneeIds: number[];
  /** Receives the COMPLETE new holder set — exactly what POST /share expects, so
   *  the control and the API agree on what "who holds this area" means. */
  onChange: (next: number[]) => void;
  onClose: () => void;
  pending?: boolean;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function AreaAssigneeBar({
  areaName,
  color,
  reps,
  assigneeIds,
  onChange,
  onClose,
  pending = false,
}: AreaAssigneeBarProps) {
  const [adding, setAdding] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null);

  const byId = new Map(reps.map((r) => [r.id, r]));
  const holders = assigneeIds.map((id) => byId.get(id) ?? { id, name: `Rep ${id}`, areaCount: 0, atCap: false });
  // An area with one rep cannot be emptied here: the API refuses an empty set
  // because emptying an area is Reclaim's job (it decides what happens to the
  // doors). Saying so on the control beats letting them tap and get an error.
  const isLastHolder = holders.length <= 1;

  const remove = (id: number) => {
    if (isLastHolder) return;
    onChange(assigneeIds.filter((x) => x !== id));
    setConfirmRemoveId(null);
  };

  const add = (id: number) => {
    if (assigneeIds.includes(id)) return;
    onChange([...assigneeIds, id]);
    setAdding(false);
  };

  return (
    <div
      data-testid="area-assignee-bar"
      role="group"
      aria-label={`Who works ${areaName}`}
      style={{ bottom: "calc(env(safe-area-inset-bottom) + 1rem)" }}
      // glass-surface glass-opaque glass-ink-scope: the same liquid-glass family
      // as the territory panel and the overlap picker floating over this map.
      // bg-background/95 rendered as a stark white card in light theme, visibly
      // detached from the dark chrome around it; the ink scope keeps the
      // semantic tokens (card/secondary/border/foreground) dark in BOTH themes.
      className="glass-surface glass-opaque glass-ink-scope absolute left-1/2 z-30 w-[min(430px,calc(100vw-20px))] -translate-x-1/2 rounded-2xl p-3 text-foreground animate-in fade-in slide-in-from-bottom-2 duration-200"
    >
      {/* Header: the area, in the area's own colour, so the card is visibly
          about the polygon still showing above it. */}
      <div className="flex items-center gap-2">
        <span
          data-testid="area-color-dot"
          className="h-3 w-3 flex-shrink-0 rounded-full ring-1 ring-white/20"
          style={{ backgroundColor: color }}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{areaName}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          data-testid="area-assignee-close"
          className={`flex h-11 w-11 -my-1 -mr-1 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground ${FOCUS}`}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Users className="h-3 w-3" />
        {holders.length === 1 ? "1 rep on this area" : `${holders.length} reps on this area`}
      </div>

      {/* Holders. Tap a face to take that rep off; the tap arms, the second
          confirms, because the doors go with them. */}
      <div className="mt-2.5 flex flex-wrap gap-2">
        {holders.map((rep, i) => {
          const arming = confirmRemoveId === rep.id;
          return (
            <button
              key={rep.id}
              type="button"
              disabled={pending || isLastHolder}
              data-testid={`area-assignee-${rep.id}`}
              aria-label={arming ? `Confirm removing ${rep.name}` : `Remove ${rep.name}`}
              title={isLastHolder ? "Use Reclaim to empty this area" : undefined}
              onClick={() => (arming ? remove(rep.id) : setConfirmRemoveId(rep.id))}
              onBlur={() => setConfirmRemoveId((c) => (c === rep.id ? null : c))}
              className={`group relative flex h-11 items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-[12px] font-medium transition-colors disabled:opacity-60 ${
                arming
                  ? "border-red-500/60 bg-red-500/10 text-red-400"
                  : "border-border bg-secondary/60 text-foreground hover:bg-secondary"
              } ${FOCUS}`}
            >
              <span
                className="flex h-9 w-9 items-center justify-center rounded-full text-[11px] font-bold text-white"
                style={{ backgroundColor: repColorOf(rep) }}
              >
                {initials(rep.name)}
              </span>
              <span className="max-w-[7.5rem] truncate">{arming ? "Remove?" : rep.name}</span>
              {/* Primary badge: the first holder is what the API treats as
                  primary, so it should not be a hidden property. Token chip —
                  the old bg-foreground/10 wash was near-invisible on the light
                  card and read as a malformed empty pill. */}
              {i === 0 && !arming && holders.length > 1 && (
                <span className="rounded-full border border-primary/30 bg-primary/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-primary">
                  1st
                </span>
              )}
              {!isLastHolder && !arming && (
                <X className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-foreground" />
              )}
            </button>
          );
        })}

        {/* Its own labelled tile, at the same height as a holder chip. */}
        {!adding && (
          <button
            type="button"
            disabled={pending}
            data-testid="area-assignee-add"
            onClick={() => setAdding(true)}
            className={`flex h-11 items-center gap-1.5 rounded-full border border-dashed border-border px-3.5 text-[12px] font-semibold text-muted-foreground transition-colors hover:border-solid hover:bg-secondary hover:text-foreground disabled:opacity-60 ${FOCUS}`}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add rep
          </button>
        )}
      </div>

      {isLastHolder && (
        <p data-testid="area-assignee-last" className="mt-2 text-[11px] text-muted-foreground">
          The last rep can't be removed here — use Reclaim to empty the area.
        </p>
      )}

      {adding && (
        <div className="mt-2.5 border-t border-border pt-2.5">
          <RepPicker
            label="Add a rep to this area"
            disabled={pending}
            reps={reps.filter((r) => !assigneeIds.includes(r.id))}
            onChange={add}
          />
          <button
            type="button"
            onClick={() => setAdding(false)}
            disabled={pending}
            data-testid="area-assignee-add-cancel"
            className={`mt-2 h-11 w-full rounded-lg border border-border bg-secondary/60 text-[12px] font-semibold text-foreground transition-colors hover:bg-secondary disabled:opacity-60 ${FOCUS}`}
          >
            Cancel
          </button>
        </div>
      )}

      {pending && (
        <div data-testid="area-assignee-pending" role="status" className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Saving…
        </div>
      )}
    </div>
  );
}
