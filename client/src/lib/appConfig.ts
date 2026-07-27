// App-level config from the server (never hardcode role lists client-side).
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export function useSuperAdminEmails(): string[] {
  const { data } = useQuery<{ superAdminEmails: string[] }>({
    queryKey: ["/api/config/app"],
    queryFn: async () => (await apiRequest("GET", "/api/config/app")).json(),
    staleTime: 5 * 60_000,
    retry: 1,
  });
  return data?.superAdminEmails ?? [];
}

export function isSuperAdmin(email: string | undefined | null, list: string[]): boolean {
  return !!email && list.includes(email.trim().toLowerCase());
}
