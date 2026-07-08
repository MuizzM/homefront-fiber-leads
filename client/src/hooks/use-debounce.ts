import { useEffect, useState } from "react";

/**
 * Debounce a rapidly-changing value. Used for search inputs so we don't fire a
 * network query on every keystroke — the query runs once typing pauses.
 */
export function useDebounce<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
