// ── Capability Governance (Phase 2) ───────────────────────────────────────────
// Permissions as first-class governance objects: the role×capability matrix,
// grouped by domain, with high-risk grants flagged and "who can do this" read
// straight from the shared map the middleware enforces. Gated on
// settings.manage.org.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { Check } from "lucide-react";

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
    <section className="rounded-xl bg-card border border-border overflow-hidden" data-testid="gov-user-preview">
      <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3.5 border-b border-border">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Effective permissions</div>
          <h2 className="text-[15px] font-semibold tracking-tight text-foreground">Preview a person's access</h2>
        </div>
        <select
          value={uid} onChange={e => setUid(e.target.value ? Number(e.target.value) : "")}
          data-testid="gov-user-select"
          aria-label="Preview a person's access"
          className="h-11 md:h-9 rounded-lg bg-secondary border border-border px-3 text-[13px] text-foreground focus:outline-none focus:border-primary/60"
        >
          <option value="">Select a person…</option>
          {members.filter(m => m.active).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>
      {data ? (
        <div className="p-4 space-y-3">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="font-semibold tracking-tight text-foreground">{data.user.name}</span>
            <span className="inline-flex items-center h-5 px-2 rounded-full bg-muted text-[11px] font-medium text-muted-foreground">
              {ROLE_LABEL[data.user.role] ?? data.user.role}
            </span>
            <span className="text-muted-foreground tabular-nums">{data.grantedCount} capabilities</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {data.groups.flatMap(g => g.capabilities).filter(c => c.granted).map(c => (
              <span key={c.capability}
                className={`inline-flex items-center gap-1 h-6 px-2.5 rounded-full text-[11px] font-medium ${c.highRisk
                  ? "bg-warning/10 text-warning"
                  : "bg-primary/10 text-primary"}`}>
                {c.highRisk
                  ? null
                  : <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
                {c.capability}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <p className="px-4 py-4 text-[12px] text-muted-foreground">Select a person to see exactly what their role grants.</p>
      )}
    </section>
  );
}

export default function Governance() {
  const { data, isLoading, isError, refetch } = useQuery<Matrix>({
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
  const totalCaps = data?.groups.reduce((n, g) => n + g.capabilities.length, 0) ?? 0;
  const highRiskCaps = data?.groups.reduce((n, g) => n + g.capabilities.filter(c => c.highRisk).length, 0) ?? 0;

  return (
    <div className="p-4 md:p-6 pb-24 md:pb-6 max-w-5xl mx-auto space-y-6">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Capability governance</div>
        <h1 className="text-xl font-bold tracking-tight text-foreground">Permissions</h1>
        <p className="text-[13px] text-muted-foreground">What each role can do - read straight from the map the middleware enforces.</p>
      </div>

      {/* A permissions console must never render "0 high-risk capabilities"
          because a fetch failed - that is the exact false reassurance the
          Diagnostics page was built to avoid. */}
      {isError && (
        <div role="alert" className="rounded-xl bg-card border border-destructive/25 p-5 text-center">
          <div className="text-sm font-semibold text-foreground">Couldn't load the capability map</div>
          <div className="mt-1 text-sm text-muted-foreground">The numbers and matrix below are unknown, not zero.</div>
          <button onClick={() => refetch()}
            className="mt-3 inline-flex min-h-11 items-center justify-center rounded-lg border border-border bg-secondary px-4 text-sm font-semibold text-foreground hover:bg-secondary/70">
            Retry
          </button>
        </div>
      )}

      {/* Hairline metric strip */}
      <div className="flex items-stretch rounded-xl bg-card border border-border divide-x divide-border">
        <div className="flex-1 px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Roles</div>
          <div className="text-[18px] font-semibold tracking-tight text-foreground tabular-nums">{data ? roles.length : " - "}</div>
        </div>
        <div className="flex-1 px-4 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Capabilities</div>
          <div className="text-[18px] font-semibold tracking-tight text-foreground tabular-nums">{data ? totalCaps : " - "}</div>
        </div>
        <div className="flex-1 px-4 py-3">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
             High-risk
          </div>
          <div className="text-[18px] font-semibold tracking-tight text-warning tabular-nums">{data ? highRiskCaps : " - "}</div>
        </div>
      </div>

      <UserPreview members={members} />

      <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Role × capability matrix</div>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search capabilities…"
          aria-label="Search capabilities"
          data-testid="gov-search"
          className="w-full max-w-xs h-11 md:h-9 rounded-lg bg-card border border-border px-3.5 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60"
        />
      </div>

      {isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
      ) : (
        <div className="space-y-6">
          {groups.map(g => (
            <section key={g.domain} data-testid={`gov-domain-${g.domain}`}>
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">{g.domain}</div>
              {/* Matrix scrolls horizontally on narrow screens instead of
                  crushing capability names to a few characters (WCAG 1.4.10
                  reflow - content stays reachable, it just scrolls). */}
              <div className="rounded-xl bg-card border border-border overflow-x-auto">
                {/* Header row of roles */}
                <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-border min-w-[520px]">
                  <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Capability</span>
                  {roles.map(r => (
                    <span key={r} className="w-[68px] text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{ROLE_LABEL[r] ?? r}</span>
                  ))}
                </div>
                {g.capabilities.map(cap => (
                  <div key={cap.capability} data-testid={`gov-cap-${cap.capability}`}
                    className="flex items-center gap-2 px-3.5 py-2.5 border-b border-border last:border-0 min-w-[520px]">
                    <span className="flex-1 min-w-0 flex items-center gap-1.5">
                      {cap.highRisk && null}
                      <code className="text-[12.5px] text-foreground truncate">{cap.capability}</code>
                    </span>
                    {roles.map(r => {
                      const granted = cap.roles.includes(r);
                      return (
                        <span key={r} className="w-[68px] flex justify-center" data-granted={granted}>
                          {/* A check glyph inside the dot + a real accessible
                              name: the grant state was previously encoded ONLY
                              as a hue in a title tooltip - invisible to screen
                              readers, touch, and anyone who can't split the
                              tints. */}
                          <span
                            role="img"
                            aria-label={granted ? `${ROLE_LABEL[r] ?? r}: granted${cap.highRisk ? " (high-risk)" : ""}` : `${ROLE_LABEL[r] ?? r}: not granted`}
                            className={`w-4 h-4 rounded-full inline-flex items-center justify-center ${granted
                              ? (cap.highRisk ? "bg-warning" : "bg-primary")
                              : "bg-muted border border-border"}`}
                            title={granted ? `${ROLE_LABEL[r] ?? r} has ${cap.capability}` : "not granted"}
                          >
                            {granted && <Check className="w-3 h-3 text-background" aria-hidden="true" strokeWidth={3} />}
                          </span>
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
