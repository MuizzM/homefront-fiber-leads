// ── Delete an area ───────────────────────────────────────────────────────────
// The destructive action on this screen, so the dialog's job is to make the
// consequence CONCRETE rather than to say "are you sure".
//
// What deleting actually does — and what a manager will otherwise assume wrongly:
//
//   · the AREA is gone, permanently
//   · its doors are NOT deleted. They detach from the area and keep the rep who
//     was working them, so nothing that was knocked is lost
//   · a rep who held those doors only THROUGH the area loses access to them,
//     because the area was the grant
//
// That third line is the one that bites, and it is the reason this dialog prints
// the door count and the holder by name instead of a generic warning. Somebody
// deleting "Maple Ridge - old" at 9pm should find out here that Marcus loses 84
// doors, not tomorrow morning when Marcus calls.
//
// Typing the name to confirm (the Notion pattern) is deliberately NOT used: the
// doors survive and keep their rep, so this is reversible-ish in the way that
// matters and a friction wall would be theatre. The count is the safeguard.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Loader2, Trash2 } from "lucide-react";

export interface AreaDeleteTarget {
  id: number;
  name: string;
  /** Doors inside the area — the number that makes this concrete. */
  total: number;
  sold: number;
  /** Who holds it, or null when it is in the pool. */
  repName?: string | null;
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

  const del = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/territories/${id}`, undefined);
      return res.json() as Promise<{ success: boolean; detached: number }>;
    },
    onSuccess: (result) => {
      // Every surface that counts areas or shows a door's area is now stale.
      // The map cache is busted server-side; these are the client's copies.
      for (const key of [
        ["/api/territories"], ["/api/territories/progress"],
        ["/api/leads"], ["/api/leads/map"],
      ]) qc.invalidateQueries({ queryKey: key });

      toast({
        title: `Deleted ${target?.name ?? "the area"}`,
        description: result.detached > 0
          ? `${result.detached} ${result.detached === 1 ? "door" : "doors"} kept their rep and went back to no area.`
          : "It had no doors in it.",
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

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="area-delete-dialog">
        <AlertDialogHeader>
          <div className="mx-auto mb-1 grid h-11 w-11 place-items-center rounded-full bg-destructive/10">
            <Trash2 className="h-5 w-5 text-destructive" aria-hidden="true" />
          </div>
          <AlertDialogTitle className="text-center">
            Delete {target?.name ?? "this area"}?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-center text-[13px]">
              <p>The area is deleted permanently. This can't be undone.</p>
              {/* The concrete consequence, not a generic warning. */}
              <p data-testid="area-delete-consequence">
                Its <span className="font-semibold text-foreground tabular-nums">{(target?.total ?? 0).toLocaleString()}</span>{" "}
                {(target?.total ?? 0) === 1 ? "door stays" : "doors stay"} in the system and keep the rep working{" "}
                {(target?.total ?? 0) === 1 ? "it" : "them"} — they just won't belong to an area any more.
              </p>
              {!!target?.sold && (
                <p className="text-muted-foreground">
                  <span className="tabular-nums">{target.sold.toLocaleString()}</span>{" "}
                  {target.sold === 1 ? "sale" : "sales"} recorded here stay on the books.
                </p>
              )}
              {held && (
                // The line that actually costs somebody their morning.
                <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-400"
                   data-testid="area-delete-holder-warning">
                  {held} holds this area. If they only had these doors through it, they lose access to them.
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
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
              if (target) del.mutate(target.id);
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
