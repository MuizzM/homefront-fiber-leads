// ── Capability Governance (Phase 2) ───────────────────────────────────────────
// Permissions as first-class governance objects: the role×capability matrix,
// grouped by domain, with high-risk grants flagged and "who can do this" read
// straight from the shared map the middleware enforces. Gated on
// settings.manage.org.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle } from "lucide-react";

interface CapRow { capability: string; highRisk: boolean; roles: string[] }
interface Group { domain: string; capabilities: CapRow[] }
interface Matrix { roles: string[]; groups: Group[] }
interface TeamMember { id: number; name: string; active: boolean }
interface UserCapRow { capability: string; highRisk: boolean; granted: boolean }
interface UserCaps { user: { id: number; name: string; role: string }; grantedCount: number; groups: { domain: string; capabilities: UserCapRow[] }[] }

const ROLE_LABEL: Record<string, string> = { rep: "Rep", team_lead: "Team Lead", manager: "Manager", admin: "Admin" };

// Effective-permissions preview: pick a person → see exactly what their role
// grants (the same shared map the middleware enforces).
function UserPreview({ members }: { members: TeamMember[] }) {
  const [uid, setUid] = useState<number | "">("");
  const { data } = useQuery<UserCaps>({
    queryKey: [`/api/governance/user/${uid}/capabilities`],
    queryFn: () => apiRequest("GET", `/api/governance/user/${uid}/capabilities`).then(r => r.json()),
    enabled: uid !== "",
    staleTime: 60_000,
  });
  return (
    <section className="rounded-2xl bg-card border border-border p-4 space-y-3" data-testid="gov-user-preview">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-[13px] font-semibold text-foreground">Effective permissions by user</h2>
          <p className="text-[11px] text-muted-foreground">What a specific person can do, from their role.</p>
        </div>
        <select
          value={uid} onChange={e => setUid(e.target.value ? Number(e.target.value) : "")}
          data-testid="gov-user-select"
          className="h-9 rounded-xl bg-secondary border border-border px-3 text-[13px] text-foreground"
        >
          <option value="">Select a person…</option>
          {members.filter(m => m.active).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>
      {data && (
        <div>
          <div className="text-[12px] text-muted-foreground mb-2">
            <span className="font-semibold text-foreground">{data.user.name}</span> · {ROLE_LABEL[data.user.role] ?? data.user.role} · {data.grantedCount} capabilities
          </div>
          <div className="flex flex-wrap gap-1.5">
            {data.groups.flatMap(g => g.capabilities).filter(c => c.granted).map(c => (
              <span key={c.capability}
                className={`inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] font-medium border ${c.highRisk
                  ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                  : "bg-primary/10 text-primary border-primary/20"}`}>
                {c.highRisk && <AlertTriangle className="w-3 h-3" />}
                {c.capability}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export default function Governance() {
  const { data, isLoading } = useQuery<Matrix>({
    queryKey: ["/api/governance/capabilities"],
    queryFn: () => apiRequest("GET", "/api/governance/capabilities").then(r => r.json()),
    staleTime: 5 * 60_000, // policy rarely changes within a session
  });
  const { data: members = [] } = useQuery<TeamMember[]>({
    queryKey: ["/api/team"],
    staleTime: 5 * 60_000,
  });
  const [q, setQ] = useState("");

  const groups = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return data.groups;
    return data.groups
      .map(g => ({ ...g, capabilities: g.capabilities.filter(c => c.capability.includes(needle) || g.domain.includes(needle)) }))
      .filter(g => g.capabilities.length > 0);
  }, [data, q]);

  const roles = data?.roles ?? [];

  return (
    <div className="p-4 md:p-6 pb-24 md:pb-6 max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="text-lg font-bold text-foreground">Permissions</h1>
        <p className="text-[13px] text-muted-foreground">
          Capability governance · what each role can do · <AlertTriangle className="inline w-3 h-3 text-amber-400 -mt-0.5" /> = high-risk grant
        </p>
      </div>

      <UserPreview members={members} />

      <input
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Search capabilities…"
        data-testid="gov-search"
        className="w-full max-w-sm h-10 rounded-xl bg-card border border-border px-3.5 text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60"
      />

      {isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-24 rounded-2xl" />)}</div>
      ) : (
        <div className="space-y-6">
          {groups.map(g => (
            <section key={g.domain} data-testid={`gov-domain-${g.domain}`}>
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">{g.domain}</div>
              {/* Matrix scrolls horizontally on narrow screens instead of
                  crushing capability names to a few characters (WCAG 1.4.10
                  reflow — content stays reachable, it just scrolls). */}
              <div className="rounded-2xl bg-card border border-border overflow-x-auto">
                {/* Header row of roles */}
                <div className="flex items-center gap-2 px-3.5 py-2 border-b border-border bg-white/[0.02] min-w-[520px]">
                  <span className="flex-1 text-[11px] font-semibold text-muted-foreground">Capability</span>
                  {roles.map(r => (
                    <span key={r} className="w-[68px] text-center text-[11px] font-semibold text-muted-foreground">{ROLE_LABEL[r] ?? r}</span>
                  ))}
                </div>
                {g.capabilities.map(cap => (
                  <div key={cap.capability} data-testid={`gov-cap-${cap.capability}`}
                    className="flex items-center gap-2 px-3.5 py-2.5 border-b border-border/60 last:border-0 min-w-[520px]">
                    <span className="flex-1 min-w-0 flex items-center gap-1.5">
                      {cap.highRisk && <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
                      <code className="text-[12.5px] text-foreground truncate">{cap.capability}</code>
                    </span>
                    {roles.map(r => {
                      const granted = cap.roles.includes(r);
                      return (
                        <span key={r} className="w-[68px] flex justify-center" data-granted={granted}>
                          <span
                            className={`w-4 h-4 rounded-full ${granted
                              ? (cap.highRisk ? "bg-amber-400/90" : "bg-primary")
                              : "bg-white/[0.06] border border-white/10"}`}
                            title={granted ? `${ROLE_LABEL[r] ?? r} has ${cap.capability}` : "not granted"}
                          />
                        </span>
                      );
                    })}
                  </div>
                ))}
              </div>
            </section>
          ))}
          {groups.length === 0 && <p className="text-[13px] text-muted-foreground italic">No capabilities match “{q}”.</p>}
        </div>
      )}
    </div>
  );
}
