// Client capability gate — reads the SAME shared map the server authorizes
// against, so UI never renders an action the API will reject. Unauthorized
// controls are omitted entirely (not disabled), per the enterprise spec.

import { useAuth } from "@/lib/auth";
import { can, type Capability } from "@shared/capabilities";

export type { Capability };

// useCan("lead.assign") → boolean for the current user's role. Gate rendering:
//   { useCan("lead.assign") && <AssignButton/> }
export function useCan(cap: Capability): boolean {
  const { user } = useAuth();
  return can(user?.role, cap);
}
