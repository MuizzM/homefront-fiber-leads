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
import { useEffect, useRef, useState, useId, type ReactNode } from "react";
import { QueryClient, QueryClientContext, useQueryClient } from "@tanstack/react-query";
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
  useEffect(() => {
    // Post-commit only (the commit-gating invariant above). Move-to-end keeps
    // activation order, so the slice evicts the least recently used stage.
    if (!keepAlive(activeLocation)) return;
    const cur = keptRef.current;
    const next = [...cur.filter((p) => p !== activeLocation), activeLocation];
    keptRef.current = next.length > maxKept ? next.slice(next.length - maxKept) : next;
  }, [activeLocation, keepAlive, maxKept]);
  return (
    <>
      {stages.map((loc) => (
        <StageQueries key={`${resetKey}:${loc}`} active={loc === activeLocation}>
        <TabActivityProvider active={loc === activeLocation}>
          <div
            style={loc === activeLocation ? undefined : { display: "none" }}
            className={className}
            data-testid={loc === activeLocation ? "route-stage-active" : "route-stage-kept"}
            data-stage-path={loc}
          >
            {renderStage(loc)}
          </div>
        </TabActivityProvider>
        </StageQueries>
      ))}
    </>
  );
}

// Tag observer options (not query.meta, which shared queries overwrite) so a
// returning stage refreshes only its own stale reads. Both caches and defaults
// remain shared. The root provider alone owns focus/reconnect subscriptions.
function StageQueries({ active, children }: { active: boolean; children: ReactNode }) {
  const root = useQueryClient();
  const owner = useId();
  const [client] = useState(() => {
    const scoped = new QueryClient({ queryCache: root.getQueryCache(), mutationCache: root.getMutationCache() });
    scoped.defaultQueryOptions = options => {
      const defaults = root.defaultQueryOptions(options);
      return { ...defaults, meta: { ...defaults.meta, stageOwner: owner } };
    };
    scoped.defaultMutationOptions = options => root.defaultMutationOptions(options);
    scoped.getDefaultOptions = () => root.getDefaultOptions();
    scoped.setDefaultOptions = options => root.setDefaultOptions(options);
    scoped.getQueryDefaults = key => root.getQueryDefaults(key);
    scoped.setQueryDefaults = (key, options) => root.setQueryDefaults(key, options);
    scoped.getMutationDefaults = key => root.getMutationDefaults(key);
    scoped.setMutationDefaults = (key, options) => root.setMutationDefaults(key, options);
    return scoped;
  });
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) {
      for (const query of root.getQueryCache().getAll()) {
        const observer = query.observers.find(observer =>
          (observer.options.meta?.stageOwner === owner || observer.options.meta?.stageOwner == null)
          && observer.getCurrentResult().isStale);
        // Refetch through the matching observer to honor its own queryFn and
        // enabled/staleTime options; join an existing request instead of aborting it.
        if (observer) void observer.refetch({ cancelRefetch: false }).catch(() => {});
      }
    }
    wasActive.current = active;
  }, [active, root, owner]);
  return <QueryClientContext.Provider value={client}>{children}</QueryClientContext.Provider>;
}
