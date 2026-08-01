import { useEffect, useState } from "react";

// True only after `active` has held true for `delayMs` straight; false the
// instant it drops. Gates "work in progress" chrome (sync badges, status
// bars) so the sub-second blip of a normal online save never flashes UI —
// only genuinely stuck/waiting work surfaces (owner directive: no syncing
// shown during normal operation).
export function useSustained(active: boolean, delayMs = 3000): boolean {
  const [sustained, setSustained] = useState(false);
  useEffect(() => {
    if (!active) {
      setSustained(false);
      return;
    }
    const t = setTimeout(() => setSustained(true), delayMs);
    return () => clearTimeout(t);
  }, [active, delayMs]);
  return sustained;
}
