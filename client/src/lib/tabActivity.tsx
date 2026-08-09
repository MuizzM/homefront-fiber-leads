// ── Tab activity — "is my route stage the one on screen?" ────────────────────
// The route stage keeps heavy tabs MOUNTED after their first visit (App.tsx
// keep-alive): returning to one is instant because nothing remounted. The
// trade is that a hidden tab's polling would keep spending radio/battery for
// a screen nobody is looking at. This context is the off switch: a kept-alive
// page reads useTabActive() and turns its refetchIntervals (and any other
// recurring background work) off while hidden. Data freshness on return is
// KeepAliveStages' job, not this file's: re-showing an already-mounted stage
// refetches every stale mounted query there (the remount that used to be the
// app's only refresh trigger is exactly what keep-alive removed) — cheaper
// and fresher than having polled blind the whole time.
//
// Pages that never opted in behave exactly as before: the default is `true`,
// so useTabActive() outside a provider (tests, detail routes, dialogs mounted
// in portals) means "assume visible" — the pre-keep-alive behavior.
import { createContext, useContext, type ReactNode } from "react";

const TabActivityContext = createContext<boolean>(true);

export function TabActivityProvider({ active, children }: { active: boolean; children: ReactNode }) {
  return <TabActivityContext.Provider value={active}>{children}</TabActivityContext.Provider>;
}

/** True while this component's route stage is the visible one. */
export function useTabActive(): boolean {
  return useContext(TabActivityContext);
}
