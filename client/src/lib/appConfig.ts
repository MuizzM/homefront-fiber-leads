// App-level config from the server (never hardcode role lists client-side).
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export function useSuperAdminEmails(): { emails: string[]; settled: boolean } {
  const { data, isSuccess, isError } = useQuery<{ superAdminEmails: string[] }>({
    queryKey: ["/api/config/app"],
    queryFn: async () => (await apiRequest("GET", "/api/config/app")).json(),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  // QA GATE FIX (C2): report settlement so the super-admin route can hold
  // (no flash-redirect for the legit super admin on cold load).
  return { emails: data?.superAdminEmails ?? [], settled: isSuccess || isError };
}

// Authoritative check: the flag the server stamped on the session user. The
// email+allowlist comparison is kept ONLY as a fallback for a cached user
// snapshot minted before the flag existed, so an upgrade doesn't lock the owner
// out mid-session. Server routes independently enforce requireSuperAdmin, so a
// stale client flag can never grant real access.
export function isSuperAdmin(
  user: { email?: string | null; isSuperAdmin?: boolean } | string | undefined | null,
  list: string[],
): boolean {
  if (user && typeof user === "object") {
    if (typeof user.isSuperAdmin === "boolean") return user.isSuperAdmin;
    return !!user.email && list.includes(user.email.trim().toLowerCase());
  }
  return !!user && list.includes(String(user).trim().toLowerCase());
}
