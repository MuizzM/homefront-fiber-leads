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

export function isSuperAdmin(email: string | undefined | null, list: string[]): boolean {
  return !!email && list.includes(email.trim().toLowerCase());
}
