// Cross-page filter handoff for the Leads list.
//
// The obvious approach - a hash query like "#/leads?status=follow_up" - 404s
// this app's wouter hash router on a hard reload / restored PWA tab (the query
// gets folded into the matched path). So instead the source (a Dashboard glance
// tile) stashes the intended status here on tap, navigates to the CLEAN
// "#/leads", and the Leads page reads-and-clears it. Survives keep-alive (Leads
// stays mounted) because Leads also re-reads on hashchange.

const KEY = "hfs.leads.status";

/** Stash a status for the Leads page to apply on arrival. Call in an onClick
 *  right before navigating to "#/leads". */
export function leadsFilterHandoff(status: string): void {
  try { sessionStorage.setItem(KEY, status); } catch { /* private mode - the list just opens unfiltered */ }
}

/** Read and clear the pending status (one-shot, so a later reload does not
 *  re-apply a stale filter). */
export function consumeLeadsFilterHandoff(): string | null {
  try {
    const v = sessionStorage.getItem(KEY);
    if (v) sessionStorage.removeItem(KEY);
    return v;
  } catch { return null; }
}

// ── "Add a lead" intent ──────────────────────────────────────────────────────
// The command palette's "Add a lead" action lands on the Leads page with its
// Add dialog already open. Same mechanism as the filter handoff, same reason.
const ADD_KEY = "hfs.leads.intent";

/** Ask the Leads page to open its Add dialog on arrival. */
export function leadsAddIntent(): void {
  try { sessionStorage.setItem(ADD_KEY, "add"); } catch { /* private mode - the page just opens */ }
}

/** Read and clear the pending intent (one-shot). */
export function consumeLeadsAddIntent(): boolean {
  try {
    const v = sessionStorage.getItem(ADD_KEY);
    if (v) sessionStorage.removeItem(ADD_KEY);
    return v === "add";
  } catch { return false; }
}
