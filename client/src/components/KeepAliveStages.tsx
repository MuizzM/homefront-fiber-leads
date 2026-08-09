// ── Keep-alive route stages — the tab-switch freeze fix ──────────────────────
// One stage div per location; locations the `keepAlive` policy approves stay
// MOUNTED (hidden with display:none) after their first visit, so returning to
// one is a visibility flip, not a cold remount — no mapbox re-init, no chart
// rebuild, no refetch-on-remount skeletons, and each stage keeps its own
// scroll position for free. Non-kept locations (detail pages, admin one-offs)
// get a single transient stage that unmounts on leave — exactly the old
// single-stage behavior.
//
// Invariants that keep this correct:
// - keptRef only ever gains a location AFTER that stage has COMMITTED (the
//   effect below): an abandoned navigation (tap B, then C before B's chunk
//   lands) must not leave a suspending lazy route mounted in a hidden div — a
//   hidden suspension would drag the surrounding shared Suspense boundary down
//   to its fallback, resurrecting the exact skeleton-on-tap bug the deferred-
//   location work (bf40e6c) fixed.
// - Visibility is inline style, not the `hidden` attribute: stage classNames
//   commonly include display-setting utilities (`flex`), and author styles
//   beat [hidden]'s UA display:none — every stage would stay visible at once.
// - This component must live INSIDE the app's one shared Suspense boundary: a
//   first visit suspends inside an already-revealed boundary, so the
//   transition keeps the outgoing stage on screen. Committed hidden stages
//   have their chunks loaded and never suspend again.
// - display:none stages still render on state changes; their PAGES opt out of
//   recurring work via useTabActive() (lib/tabActivity), so hidden tabs stop
//   polling but keep their tree warm.
import { useEffect, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { TabActivityProvider } from "@/lib/tabActivity";

export function KeepAliveStages({ activeLocation, keepAlive, maxKept = 4, resetKey = "", className, renderStage }: {
  /** The location whose stage is visible — App passes the DEFERRED location so
   *  chunk loads keep the outgoing stage on screen (see App.tsx). */
  activeLocation: string;
  /** Which locations survive leaving. Kept per exact location string. */
  keepAlive: (location: string) => boolean;
  /** Mounted-stage cap (LRU beyond it, the active stage never evicts). A
   *  hidden MapView keeps a live WebGL context — this bounds that cost. */
  maxKept?: number;
  /** Different key → every kept stage unmounts. App keys this by signed-in
   *  identity + role: kept trees were rendered under the old role's guards
   *  and must not survive a login swap. */
  resetKey?: string;
  className?: string;
  renderStage: (location: string) => ReactNode;
}) {
  const keptRef = useRef<string[]>([]);
  const ownerRef = useRef(resetKey);
  if (ownerRef.current !== resetKey) {
    // Render-phase reset — same "derived state" pattern React documents.
    ownerRef.current = resetKey;
    keptRef.current = [];
  }
  const kept = keptRef.current;
  const stages = kept.includes(activeLocation) ? kept : [...kept, activeLocation];
  const queryClient = useQueryClient();
  useEffect(() => {
    // RE-SHOW REVALIDATION — load-bearing, not an optimization. The app's
    // freshness model was REMOUNT-driven: refetchOnWindowFocus is globally
    // false and most queries have no interval, so the unmount/remount cycle
    // this component removed was the only thing that ever refetched a
    // revisited tab's data. Returning to an already-mounted stage therefore
    // refetches every stale mounted query (staleTime still debounces — inside
    // its window this is a no-op, exactly the pre-keep-alive cadence). Scoped
    // to type:'active' observers; hidden stages' stale queries ride along,
    // which only front-loads the refetch their own return would have done.
    // A stage's FIRST activation skips this: its queries are mounting right
    // now and refetchOnMount already covers them.
    const wasAlreadyMounted = keptRef.current.includes(activeLocation);
    if (wasAlreadyMounted) {
      void queryClient.refetchQueries({ stale: true, type: "active" });
    }
    // Post-commit only (the commit-gating invariant above). Move-to-end keeps
    // activation order, so the slice evicts the least recently used stage.
    if (!keepAlive(activeLocation)) return;
    const cur = keptRef.current;
    const next = [...cur.filter((p) => p !== activeLocation), activeLocation];
    keptRef.current = next.length > maxKept ? next.slice(next.length - maxKept) : next;
  }, [activeLocation, keepAlive, maxKept, queryClient]);
  return (
    <>
      {stages.map((loc) => (
        <TabActivityProvider key={loc} active={loc === activeLocation}>
          <div
            style={loc === activeLocation ? undefined : { display: "none" }}
            className={className}
            data-testid={loc === activeLocation ? "route-stage-active" : "route-stage-kept"}
            data-stage-path={loc}
          >
            {renderStage(loc)}
          </div>
        </TabActivityProvider>
      ))}
    </>
  );
}
