import { useEffect, useState } from "react";
import { useNetworkStatus } from "./use-network-status";

/** Display-only subscriptions; durable writes and location tracking stay separate. */
export function useForegroundActivity(routeActive: boolean): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const online = useNetworkStatus();
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    update();
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return routeActive && visible && online;
}
