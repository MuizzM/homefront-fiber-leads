// ── Delete an area ───────────────────────────────────────────────────────────
// The destructive action on this screen, so the dialog's job is to make the
// consequence CONCRETE rather than to say "are you sure".
//
// What deleting actually does — and what a manager will otherwise assume wrongly:
//
//   · the AREA is gone, permanently
//   · its doors are NOT deleted. They detach from the area and, by default, go
//     back to the pool — nothing that was knocked is lost
//   · the rep who was working them stops seeing them, because the area was the
//     grant and the grant is what was deleted
//
// THE CHOICE this dialog makes explicit: deleting used to keep the doors on
// their rep unconditionally. An area handed to a rep and then deleted left every
// door inside it still assigned to them — on their dialing list, in their stats,
// in their knock sheet — with the area that explained it gone from every screen.
// So the rep assignment now goes with the area by DEFAULT, and keeping it is a
// deliberate, visible choice rather than an invisible one.
//
// Which doors lose their rep is decided server-side by @shared/territory
// (areaGrantedRepIds / areaDeleteClearsRep): the ones held by a rep this area is
// or was a grant for. A door handed directly to a rep who never held this area
// keeps them under either option — that assignment did not come from the area.
//
// Typing the name to confirm (the Notion pattern) is deliberately NOT used: the
// doors survive either way, so this is reversible-ish in the way that matters
// and a friction wall would be theatre. The count is the safeguard.
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { DEFAULT_AREA_DELETE_REP_POLICY, type AreaDeleteRepPolicy } from "@shared/territory";

export interface AreaDeleteTarget {
  id: number;
  name: string;
  /** Doors inside the area — the number that makes this concrete. */
  total: number;
  sold: number;
  /** Who holds it, or null when it is in the pool. */
  repName?: string | null;
}

export interface AreaDeleteResult {
  success: boolean;
  detached: number;
  repAssignments: AreaDeleteRepPolicy;
  repCleared: number;
  clearedRepNames: string[];
}

/** Plain-language list — "Talal", "Talal and Bo", "Talal, Bo and Cam". */
function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function AreaDeleteDialog({
  target, open, onOpenChange, onDeleted,
}: {
  target: AreaDeleteTarget | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Called after a successful delete — the list closes the dialog, the detail
   *  page navigates away, so the caller decides. */
  onDeleted?: (target: AreaDeleteTarget) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [repPolicy, setRepPolicy] = useState<AreaDeleteRepPolicy>(DEFAULT_AREA_DELETE_REP_POLICY);

  // A choice made for one area must never carry into the next one opened.
  useEffect(() => {
    if (open) setRepPolicy(DEFAULT_AREA_DELETE_REP_POLICY);
  }, [open, target?.id]);

  const del = useMutation({
    mutationFn: async ({ id, policy }: { id: number; policy: AreaDeleteRepPolicy }) => {
      const res = await apiRequest("DELETE", `/api/territories/${id}?repAssignments=${policy}`, undefined);
      return res.json() as Promise<AreaDeleteResult>;
    },
    onSuccess: (result) => {
      // Every surface that counts areas, shows a door's area, or works off a
      // rep's assigned doors is now stale. The map cache is busted server-side;
      // these are the client's copies. The Area's own skip-trace/dialing queries
      // are keyed by area id and go away with the page, but the CALLING queue is
      // built from assigned doors and has to be re-read.
      for (const key of [
        ["/api/territories"], ["/api/territories/progress"],
        ["/api/leads"], ["/api/leads/map"],
        ["/api/calling/queue"], ["/api/leads/ready-to-call"],
      ]) qc.invalidateQueries({ queryKey: key });

      const doors = result.detached;
      const noun = (n: number) => (n === 1 ? "door" : "doors");
      const names = nameList(result.clearedRepNames ?? []);
      toast({
        title: `Deleted ${target?.name ?? "the area"}`,
        description: doors === 0
          ? "It had no doors in it."
          : result.repCleared > 0
            // The line a manager needs: who lost what.
            ? `${doors} ${noun(doors)} left the area. ${result.repCleared} ${noun(result.repCleared)} ${result.repCleared === 1 ? "was" : "were"} unassigned from ${names || "their rep"}.`
            : result.repAssignments === "keep"
              ? `${doors} ${noun(doors)} left the area and kept their rep.`
              : `${doors} ${noun(doors)} went back to no area. None were assigned to a rep through it.`,
      });
      const t = target;
      onOpenChange(false);
      if (t) onDeleted?.(t);
    },
    onError: (e: any) => toast({
      title: "Couldn't delete the area",
      description: String(e?.message ?? e),
      variant: "destructive",
    }),
  });

  const held = target?.repName?.trim();
  const total = target?.total ?? 0;
  const doorWord = total === 1 ? "door" : "doors";

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="area-delete-dialog">
        <AlertDialogHeader>
          
          <AlertDialogTitle className="text-center">
            Delete {target?.name ?? "this area"}?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-center text-[13px]">
              <p>The area is deleted permanently. This can't be undone.</p>
              {/* The concrete consequence, and it changes with the choice below. */}
              <p data-testid="area-delete-consequence">
                Its <span className="font-semibold text-foreground tabular-nums">{total.toLocaleString()}</span>{" "}
                {total === 1 ? "door stays" : "doors stay"} in the system
                {repPolicy === "keep"
                  ? <> and keep the rep working {total === 1 ? "it" : "them"} - {total === 1 ? "it" : "they"} just won't belong to an area any more.</>
                  : <> - {total === 1 ? "it goes" : "they go"} back to the pool, ready to be assigned again.</>}
              </p>
              {!!target?.sold && (
                <p className="text-muted-foreground">
                  <span className="tabular-nums">{target.sold.toLocaleString()}</span>{" "}
                  {target.sold === 1 ? "sale" : "sales"} recorded here stay on the books.
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* ── The choice ─────────────────────────────────────────────────────
            Outside AlertDialogDescription on purpose: the description is the
            dialog's aria-describedby, and burying controls inside it reads the
            whole radio group out as the description. */}
        <fieldset className="space-y-1.5" data-testid="area-delete-rep-policy">
          <legend className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            The {doorWord} inside it
          </legend>
          <div className="space-y-1.5" role="radiogroup" aria-label={`What happens to the ${doorWord} inside it`}>
            <PolicyOption
              checked={repPolicy === "clear"}
              onSelect={() => setRepPolicy("clear")}
              disabled={del.isPending}
              testId="area-delete-policy-clear"
              title="Clear the rep too"
              detail={held
                ? `${held} stops seeing them. They go back to the pool for whoever picks up the ground next.`
                : "They go back to the pool for whoever picks up the ground next."}
            />
            <PolicyOption
              checked={repPolicy === "keep"}
              onSelect={() => setRepPolicy("keep")}
              disabled={del.isPending}
              testId="area-delete-policy-keep"
              title={held ? `Keep them with ${held}` : "Keep them with their rep"}
              detail={held
                ? `${held} keeps working these ${doorWord} with no area around them.`
                : "Whoever each door is assigned to keeps it, with no area around it."}
            />
          </div>
          {repPolicy === "keep" && held && (
            // The line that actually costs somebody their morning — only true
            // under "keep", where the doors stay but the grant that explained
            // them is gone from every screen.
            <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-[12px] text-warning"
               data-testid="area-delete-holder-warning">
              {held} will still have these {doorWord} with no area to explain them. Reclaim or reassign them later from the Leads table.
            </p>
          )}
        </fieldset>

        <AlertDialogFooter className="sm:justify-center">
          <AlertDialogCancel data-testid="area-delete-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction
            data-testid="area-delete-confirm"
            disabled={del.isPending || !target}
            onClick={(e) => {
              // The dialog must stay open while the request is in flight —
              // Radix closes on click by default, which would flash the list
              // back with the area still on it.
              e.preventDefault();
              if (target) del.mutate({ id: target.id, policy: repPolicy });
            }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {del.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Delete area
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PolicyOption({
  checked, onSelect, disabled, testId, title, detail,
}: {
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
  testId: string;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      data-testid={testId}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-50",
        checked ? "border-primary bg-primary/5" : "border-border hover:bg-secondary/40",
        FOCUS,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border-2",
          checked ? "border-primary" : "border-muted-foreground/40",
        )}
      >
        {checked && <span className="h-2 w-2 rounded-full bg-primary" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-foreground">{title}</span>
        <span className="block text-[12px] leading-snug text-muted-foreground">{detail}</span>
      </span>
    </button>
  );
}
