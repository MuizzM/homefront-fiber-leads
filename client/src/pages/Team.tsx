import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Edit2, Trash2, User, Users, Crown, Star, ChevronUp, Wallet, ChevronRight, DoorOpen, Handshake, PhoneCall, TrendingUp, FileSignature, UserMinus } from "lucide-react";
import { useCan } from "@/lib/capabilities";
import { TierEditor } from "@/components/commission/TierEditor";
import { validateTiers, type CommissionTier } from "@shared/commissionTiers";
import { canActOnMember, HIRABLE_ROLES, isValidSupervisorRole, type MemberRole } from "@shared/teamHierarchy";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import type { TeamMember, InsertTeamMember } from "@shared/schema";

// ── Role definitions ──────────────────────────────────────────────────────────
export const ROLES = [
  {
    value: "rep",
    label: "Sales Rep",
    short: "Rep",
    description: "Knocks doors, logs contacts, views own leads & territory only",
    color: "bg-blue-500/15 text-blue-400",
    avatarColor: "bg-blue-500/20 text-blue-400",
    Icon: User,
  },
  {
    value: "team_lead",
    label: "Team Lead",
    short: "Team Lead",
    description: "Everything a Rep can do + can onboard new reps, view team stats",
    color: "bg-purple-500/15 text-purple-400",
    avatarColor: "bg-purple-500/20 text-purple-400",
    Icon: Star,
  },
  {
    value: "manager",
    label: "Manager",
    short: "Manager",
    description: "Full visibility of all reps, leads & territories; can assign territories",
    color: "bg-amber-500/15 text-amber-400",
    avatarColor: "bg-amber-500/20 text-amber-400",
    Icon: Crown,
  },
] as const;

export type RepRole = MemberRole;

export function roleInfo(role: string) {
  return ROLES.find(r => r.value === role) ?? ROLES[0];
}

// Two-letter avatar initials (first + last word) — falls back to one letter.
function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

// ── Form state ────────────────────────────────────────────────────────────────
type MemberForm = {
  name: string;
  phone: string;
  email: string;
  role: RepRole;
  reportsToId: number | null;
  active: boolean;
};

function emptyForm(): MemberForm {
  return { name: "", phone: "", email: "", role: "rep", reportsToId: null, active: true };
}

function fromMember(m: TeamMember): MemberForm {
  return {
    name: m.name,
    phone: m.phone ?? "",
    email: m.email ?? "",
    role: (m.role as RepRole) ?? "rep",
    reportsToId: (m as any).reportsToId ?? null,
    active: m.active,
  };
}

// Hierarchy rules (who hires/kicks/edits whom, valid supervisor edges) come
// from @shared/teamHierarchy — the SAME module the server enforces with, so
// this page never renders an action the API would refuse.

// ── Role picker card ──────────────────────────────────────────────────────────
function RolePicker({ value, onChange, allowed }: { value: RepRole; onChange: (v: RepRole) => void; allowed: readonly RepRole[] }) {
  // Single-choice group → radiogroup semantics, so the visible "Role" label
  // and the selected state are announced (plain buttons read as unrelated toggles).
  return (
    <div className="space-y-2">
      <Label id="role-picker-label" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Role *</Label>
      <div className="space-y-2" role="radiogroup" aria-labelledby="role-picker-label">
        {ROLES.filter(r => allowed.includes(r.value)).map(r => {
          const selected = value === r.value;
          return (
            <button
              key={r.value}
              type="button"
              role="radio"
              onClick={() => onChange(r.value as RepRole)}
              data-testid={`role-option-${r.value}`}
              aria-checked={selected}
              className={`w-full text-left rounded-lg border px-3 py-2.5 transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                selected
                  ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                  : "border-border bg-secondary hover:border-primary/40"
              }`}
            >
              <div className="flex items-center gap-2.5">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${r.avatarColor}`}>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{r.label}</span>
                    {selected && (
                      null
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground leading-tight mt-0.5">{r.description}</p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Member form UI ────────────────────────────────────────────────────────────
function MemberFormUI({
  form, setForm, onSave, onCancel, saving, isEdit, selfEdit, team, selfId, creatorRole
}: {
  form: MemberForm;
  setForm: (f: MemberForm) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  isEdit?: boolean;
  /** Editing your own row — the server only accepts name/phone, so only offer those. */
  selfEdit?: boolean;
  team: TeamMember[];
  selfId?: number;
  creatorRole: string;
}) {
  const set = (k: keyof MemberForm, v: string | boolean) =>
    setForm({ ...form, [k]: v });

  // Only offer roles the current user is allowed to hire (admin → managers too)
  const allowedRoles = (HIRABLE_ROLES[creatorRole] ?? ["rep"]) as readonly RepRole[];

  // Managers report to Admin (no picker). Reps → team lead/manager; team leads → manager.
  // Only ACTIVE members who rank strictly above can supervise (server-enforced).
  const showReportsTo = form.role === "rep" || form.role === "team_lead";
  const supervisors = team.filter(
    m => m.id !== selfId && m.active && isValidSupervisorRole(form.role, m.role)
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="form-rep-name" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Full name *</Label>
        <Input
          id="form-rep-name"
          value={form.name}
          onChange={e => set("name", e.target.value)}
          className="h-9 bg-secondary border-input"
          placeholder="Marcus Johnson"
          data-testid="form-rep-name"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="form-rep-phone" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Phone</Label>
          <Input
            id="form-rep-phone"
            value={form.phone}
            onChange={e => set("phone", e.target.value)}
            className="h-9 bg-secondary border-input"
            placeholder="(704) 555-0101"
            data-testid="form-rep-phone"
          />
        </div>
        {!selfEdit && (
          <div className="space-y-1.5">
            <Label htmlFor="form-rep-email" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Email (login)</Label>
            <Input
              id="form-rep-email"
              value={form.email}
              onChange={e => set("email", e.target.value)}
              className="h-9 bg-secondary border-input"
              placeholder="rep@email.com"
              data-testid="form-rep-email"
            />
          </div>
        )}
      </div>
      {!selfEdit && (
        <p className="text-[11px] text-muted-foreground -mt-1.5 flex items-center gap-1.5">
          
          Members with an email can log in with a one-time code sent to that address.
        </p>
      )}
      {selfEdit && (
        <p className="text-[11px] text-muted-foreground -mt-1.5 flex items-center gap-1.5">
          
          Your role, status, supervisor, and login email can only be changed by someone above you.
        </p>
      )}

      {/* Role picker — changing role resets the supervisor (eligibility changes) */}
      {!selfEdit && (
        <RolePicker value={form.role} onChange={v => setForm({ ...form, role: v, reportsToId: null })} allowed={allowedRoles} />
      )}

      {/* Reports To — who this member is under in the org chart */}
      {!selfEdit && showReportsTo && (
        <div className="space-y-1.5">
          <Label htmlFor="form-rep-reports-to" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Reports to {form.role === "rep" ? "(team lead or manager)" : "(manager)"}
          </Label>
          <Select
            value={form.reportsToId != null ? String(form.reportsToId) : "none"}
            onValueChange={v => setForm({ ...form, reportsToId: v === "none" ? null : Number(v) })}
          >
            <SelectTrigger id="form-rep-reports-to" className="h-9 bg-secondary border-input" data-testid="form-rep-reports-to">
              <SelectValue placeholder="Select supervisor" />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value="none"> - None (reports to Admin) - </SelectItem>
              {supervisors.map(m => (
                <SelectItem key={m.id} value={String(m.id)}>
                  {m.name} · {roleInfo(m.role).short}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {supervisors.length === 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              No {form.role === "rep" ? "team leads or managers" : "managers"} added yet - leave as top-level for now.
            </p>
          )}
        </div>
      )}

      {/* Lifecycle (offboard / reactivate) is deliberately NOT a form field —
          it runs through the dedicated flows that also disable the login,
          revoke live sessions, and re-home direct reports. */}
      {isEdit && !selfEdit && (
        <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
          
          To deactivate or restore this member, use Offboard / Reactivate on their row.
        </p>
      )}

      <div className="flex gap-2 pt-2">
        <Button variant="outline" onClick={onCancel} className="h-9 border-border flex-1">Cancel</Button>
        <Button
          onClick={onSave}
          disabled={saving || !form.name.trim()}
          className="h-9 bg-primary hover:bg-primary/90 text-primary-foreground flex-1"
          data-testid="btn-save-rep"
        >
          {saving ? "Saving..." : isEdit ? "Update Member" : "Add Member"}
        </Button>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Team() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [addOpen, setAddOpen] = useState(false);
  const [editMember, setEditMember] = useState<TeamMember | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [offboardMember, setOffboardMember] = useState<TeamMember | null>(null);
  const [addForm, setAddForm] = useState<MemberForm>(emptyForm());
  const [editForm, setEditForm] = useState<MemberForm>(emptyForm());
  const [commissionMember, setCommissionMember] = useState<TeamMember | null>(null);

  const { toast } = useToast();
  const qc = useQueryClient();
  const canManageCommission = useCan("commission.structure.manage");
  const canManageDocuments = useCan("onboarding.documents.manage");
  const canManageOverrides = useCan("commission.overrides.manage");
  // Per-member override rates (what uplines keep on this seller's sales), as
  // draft dollar strings; "" = inherit the org default. Seeded when the edit
  // dialog opens, saved through their own endpoint — pay is its own decision,
  // same reasoning as the Commission section below.
  const [overrideTlDollars, setOverrideTlDollars] = useState("");
  const [overrideMgrDollars, setOverrideMgrDollars] = useState("");
  useEffect(() => {
    const centsDraft = (cents: number | null | undefined) =>
      cents == null ? "" : String(cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2));
    setOverrideTlDollars(centsDraft((editMember as any)?.overrideTeamLeadCents));
    setOverrideMgrDollars(centsDraft((editMember as any)?.overrideManagerCents));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editMember?.id]);

  // HONESTY FIX: a query failure used to paint "No team members yet" + an Add
  // CTA (inviting duplicates after a transient error). Distinguish the two.
  const { data: team = [], isLoading, isError, refetch: refetchTeam } = useQuery<TeamMember[]>({
    queryKey: ["/api/team"],
  });

  const { data: leaderboard = [] } = useQuery<{
    rep: TeamMember; knocks: number; contacts: number; callbacks: number; sales: number;
  }[]>({
    queryKey: ["/api/leaderboard"],
  });

  const overrideRatesMutation = useMutation({
    mutationFn: async () => {
      // "" = inherit (null on the wire); dollars → integer cents ONCE here.
      const toCents = (draft: string): number | null => {
        const trimmed = draft.trim();
        if (!trimmed) return null;
        const dollars = Number(trimmed);
        return Number.isFinite(dollars) && dollars >= 0 ? Math.round(dollars * 100) : null;
      };
      const res = await apiRequest("PATCH", `/api/commission/reps/${editMember!.id}/override-rates`, {
        overrideTeamLeadCents: toCents(overrideTlDollars),
        overrideManagerCents: toCents(overrideMgrDollars),
      });
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/team"] });
      toast({ title: "Override rates updated", description: "Applies to future sales only - settled weeks keep their frozen amounts." });
    },
    onError: (error: any) => toast({ title: "Rates not saved", description: error.message, variant: "destructive" }),
  });

  const createMutation = useMutation({
    mutationFn: async (data: InsertTeamMember) => {
      const res = await apiRequest("POST", "/api/team", data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Team member added" });
      qc.invalidateQueries({ queryKey: ["/api/team"] });
      qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      setAddOpen(false);
      setAddForm(emptyForm());
    },
    onError: (err: any) => {
      toast({ title: err.message || "Failed to add member", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<InsertTeamMember> }) => {
      const res = await apiRequest("PATCH", `/api/team/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Member updated" });
      qc.invalidateQueries({ queryKey: ["/api/team"] });
      qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      setEditMember(null);
    },
    onError: (err: any) => {
      toast({ title: err.message || "Failed to update", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/team/${id}`);
    },
    // Optimistic: the dialog closes and the row leaves the roster on tap.
    // Failure rolls the roster back and raises an error toast (auto-dismisses
    // after its long beat; the failure stays in the error center).
    onMutate: async (id: number) => {
      setDeleteId(null);
      await qc.cancelQueries({ queryKey: ["/api/team"] });
      const previous = qc.getQueryData<TeamMember[]>(["/api/team"]);
      qc.setQueryData<TeamMember[]>(["/api/team"], old => (old ?? []).filter(m => m.id !== id));
      return { previous };
    },
    onSuccess: () => {
      toast({ title: "Member removed" });
    },
    onError: (err: any, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(["/api/team"], ctx.previous);
      toast({ title: err.message || "Failed to remove", variant: "destructive" });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["/api/team"] });
      qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
    },
  });

  const offboardMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/team/${id}/offboard`);
      return res.json() as Promise<{ reassignedReports: number; sessionsRevoked: number; loginDisabled: boolean }>;
    },
    // Optimistic: the member drops to Former Members and the dialog closes on
    // tap; the server truth (sessions revoked, reports re-homed) arrives in
    // the success toast. Failure restores the roster.
    onMutate: async (id: number) => {
      setOffboardMember(null);
      await qc.cancelQueries({ queryKey: ["/api/team"] });
      const previous = qc.getQueryData<TeamMember[]>(["/api/team"]);
      qc.setQueryData<TeamMember[]>(["/api/team"], old =>
        (old ?? []).map(m => (m.id === id ? { ...m, active: false } : m)));
      return { previous };
    },
    onSuccess: (result, id) => {
      const who = team.find(m => m.id === id)?.name ?? "Member";
      const bits = [
        result.loginDisabled ? "login disabled" : null,
        result.sessionsRevoked > 0 ? "signed out everywhere" : null,
        result.reassignedReports > 0 ? `${result.reassignedReports} report${result.reassignedReports === 1 ? "" : "s"} re-homed` : null,
      ].filter(Boolean).join(" · ");
      toast({ title: `${who} offboarded`, description: bits || "Access removed." });
    },
    onError: (err: any, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(["/api/team"], ctx.previous);
      toast({ title: err.message || "Failed to offboard", variant: "destructive" });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["/api/team"] });
      qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
    },
  });

  const reactivateMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/team/${id}/reactivate`);
      return res.json();
    },
    // Optimistic: the member rejoins the active roster on tap; failure rolls back.
    onMutate: async (id: number) => {
      await qc.cancelQueries({ queryKey: ["/api/team"] });
      const previous = qc.getQueryData<TeamMember[]>(["/api/team"]);
      qc.setQueryData<TeamMember[]>(["/api/team"], old =>
        (old ?? []).map(m => (m.id === id ? { ...m, active: true } : m)));
      return { previous };
    },
    onSuccess: (_r, id) => {
      const who = team.find(m => m.id === id)?.name ?? "Member";
      toast({ title: `${who} reactivated`, description: "Their login works again." });
    },
    onError: (err: any, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(["/api/team"], ctx.previous);
      toast({ title: err.message || "Failed to reactivate", variant: "destructive" });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["/api/team"] });
      qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
    },
  });

  // O(1) row lookups built once per render — the roster is rendered inside a
  // .map, so a per-row leaderboard.find / activeMembers.filter / team.find was
  // O(n²) and janked large orgs. These maps make each row a constant-time get.
  const statsById = useMemo(() => {
    const m = new Map<number, { knocks: number; contacts: number; callbacks: number; sales: number }>();
    for (const l of leaderboard) m.set(l.rep.id, { knocks: l.knocks, contacts: l.contacts, callbacks: l.callbacks, sales: l.sales });
    return m;
  }, [leaderboard]);
  const memberById = useMemo(() => {
    const m = new Map<number, TeamMember>();
    for (const t of team) m.set(t.id, t);
    return m;
  }, [team]);
  const directReportCountById = useMemo(() => {
    const m = new Map<number, number>();
    for (const t of team) {
      if (!t.active) continue;
      const sup = (t as any).reportsToId;
      if (sup != null) m.set(sup, (m.get(sup) ?? 0) + 1);
    }
    return m;
  }, [team]);
  const NO_STATS = { knocks: 0, contacts: 0, callbacks: 0, sales: 0 };
  const statsFor = (repId: number) => statsById.get(repId) ?? NO_STATS;

  const openEdit = (m: TeamMember) => {
    setEditForm(fromMember(m));
    setEditMember(m);
  };

  // Permission checks — the hierarchy rule (strictly above) comes from the
  // SAME shared module the server enforces, so buttons only render when the
  // API would say yes.
  const myRole = user?.role ?? "";
  const myMemberId = user?.teamMemberId ?? null;
  const canAddMembers = ["admin", "manager", "team_lead"].includes(myRole);
  /** Lifecycle authority over a member: outrank them, and never yourself. */
  const canLifecycle = (m: TeamMember) => m.id !== myMemberId && canActOnMember(myRole, m.role);
  const canEditMember = (m: TeamMember) => canLifecycle(m) || m.id === myMemberId;
  const canHardDelete = (m: TeamMember) => ["admin", "manager"].includes(myRole) && canLifecycle(m);

  // Group by role for display — active members in the org sections; inactive
  // members live in the Former Members section below.
  const activeMembers = team.filter(m => m.active);
  const formerMembers = team.filter(m => !m.active);
  const managers = activeMembers.filter(m => m.role === "manager");
  const leads = activeMembers.filter(m => m.role === "team_lead");
  const reps = activeMembers.filter(m => m.role === "rep");
  /** Active direct reports of a member — shown as a chip, and listed in the
   * offboard dialog since they get re-homed. */
  const directReportsOf = (id: number) => activeMembers.filter(m => (m as any).reportsToId === id);

  // Team totals for the metric strip (derived from leaderboard/team — no new calls)
  const activeCount = activeMembers.length;
  const totalKnocks = leaderboard.reduce((a, l) => a + l.knocks, 0);
  const totalContacts = leaderboard.reduce((a, l) => a + l.contacts, 0);
  const totalCallbacks = leaderboard.reduce((a, l) => a + l.callbacks, 0);
  const totalSales = leaderboard.reduce((a, l) => a + l.sales, 0);

  // Whether any per-member action is available to this viewer (reserves the
  // actions column so the metric columns stay aligned across every row).
  const showActions = Boolean(canAddMembers || canManageCommission || canManageDocuments);
  const metricCols = ["Knocks", "Contacts", "Callbacks", "Sales"];

  const RoleSection = ({ title, members, role }: { title: string; members: TeamMember[]; role: string }) => {
    const ri = roleInfo(role);
    if (members.length === 0) return null;
    return (
      <div>
        {/* Section header — role chip + eyebrow + count pill + hairline rule */}
        <div className="flex items-center gap-2.5 mb-2.5 px-0.5">
          <div className={`w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 ${ri.avatarColor}`}>
          </div>
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
          <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-muted text-[11px] font-medium text-muted-foreground tabular-nums">{members.length}</span>
          <div className="flex-1 h-px bg-border" />
        </div>

        {/* Roster — hairline-divided rows */}
        <Card className="bg-card border-border overflow-hidden rounded-xl">
          {/* Column header (desktop) — aligns to the metric columns below */}
          <div className="hidden md:flex items-center gap-3 px-4 py-2 border-b border-border bg-muted/30">
            <div className="w-10 flex-shrink-0" />
            <div className="flex-1 min-w-0 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Member</div>
            <div className="flex items-center gap-5 flex-shrink-0">
              {metricCols.map(label => (
                <div key={label} className="w-14 text-right text-2xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
              ))}
            </div>
            {showActions && (
              <div className="w-[156px] flex-shrink-0 text-right text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</div>
            )}
          </div>

          <div className="divide-y divide-border">
            {members.map(member => {
              const s = statsFor(member.id);
              const ri2 = roleInfo(member.role);
              const sup = (member as any).reportsToId
                ? memberById.get((member as any).reportsToId)
                : null;
              const metrics = [
                { label: "Knocks", val: s.knocks },
                { label: "Contacts", val: s.contacts },
                { label: "Callbacks", val: s.callbacks },
                { label: "Sales", val: s.sales, highlight: true },
              ];
              return (
                <div key={member.id} data-testid={`card-rep-${member.id}`}
                  className="render-lazy group flex items-center gap-3 p-4 hover:bg-secondary/40 transition-colors">
                  {/* Avatar */}
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ring-1 ring-inset ring-black/5 dark:ring-white/10 ${ri2.avatarColor} ${!member.active ? "opacity-60" : ""}`}>
                    {initials(member.name)}
                  </div>

                  {/* Identity */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm text-foreground leading-tight truncate">{member.name}</span>
                      <Badge className={`h-5 gap-1 px-1.5 rounded-full border-0 text-[11px] font-medium ${ri2.color}`}>
                        {ri2.short}
                      </Badge>
                      <span className={`inline-flex items-center gap-1 h-5 pl-1.5 pr-2 rounded-full text-[11px] font-medium ${member.active ? "bg-emerald-500/10 text-emerald-400" : "bg-muted text-muted-foreground"}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${member.active ? "bg-emerald-500" : "bg-muted-foreground/50"}`} />
                        {member.active ? "Active" : "Inactive"}
                      </span>
                    </div>

                    {/* Secondary line — reports-to + contact */}
                    <div className="flex items-center gap-x-3 gap-y-0.5 mt-1 flex-wrap text-[11px] text-muted-foreground">
                      {sup && (
                        <span className="inline-flex items-center gap-1">
                          <ChevronUp className="w-3 h-3" /> Reports to <span className="text-foreground/80 font-medium">{sup.name}</span>
                        </span>
                      )}
                      {/* Recruited-by — the sponsor edge, read-only. It never
                          drives pay or authority (the reports-to chain does),
                          so it is a muted fact here and appears in NO form.
                          Renders only when the roster carries the id AND the
                          recruiter is still on the roster to name. */}
                      {(() => {
                        const recruiter = (member as any).recruitedByMemberId != null
                          ? memberById.get((member as any).recruitedByMemberId)
                          : undefined;
                        return recruiter ? (
                          <span className="inline-flex items-center gap-1" data-testid={`recruited-by-${member.id}`}>
                             Recruited by <span className="text-foreground/80 font-medium">{recruiter.name}</span>
                          </span>
                        ) : null;
                      })()}
                      {(directReportCountById.get(member.id) ?? 0) > 0 && (
                        <span className="inline-flex items-center gap-1" data-testid={`chip-reports-${member.id}`}>
                          
                          <span className="tabular-nums font-medium text-foreground/80">{directReportCountById.get(member.id)}</span> direct report{directReportCountById.get(member.id) === 1 ? "" : "s"}
                        </span>
                      )}
                      {member.phone && (
                        <span className="inline-flex items-center gap-1">
                           {member.phone}
                        </span>
                      )}
                      {member.email && (
                        <span className="inline-flex items-center gap-1">
                           {member.email}
                          <span className="text-2xs font-medium px-1.5 py-0 rounded-full bg-primary/15 text-primary">login</span>
                        </span>
                      )}
                    </div>

                    {/* Metrics — mobile (below identity) */}
                    <div className="flex md:hidden items-center gap-4 mt-2.5">
                      {metrics.map(({ label, val, highlight }) => (
                        <div key={label} className="flex items-baseline gap-1">
                          <span className={`text-sm font-semibold tabular-nums ${highlight && val > 0 ? "text-emerald-400" : "text-foreground"}`}>{val.toLocaleString()}</span>
                          <span className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Metrics — desktop (tabular columns) */}
                  <div className="hidden md:flex items-center gap-5 flex-shrink-0">
                    {metrics.map(({ label, val, highlight }) => (
                      <div key={label} className="w-14 text-right">
                        <div className={`text-sm font-semibold tabular-nums ${highlight && val > 0 ? "text-emerald-400" : val > 0 ? "text-foreground" : "text-muted-foreground/50"}`}>{val.toLocaleString()}</div>
                      </div>
                    ))}
                  </div>

                  {/* Row actions */}
                  {showActions && (
                    <div className="flex items-center justify-end gap-1 flex-shrink-0 w-[156px]">
                      {canManageDocuments && member.role === "rep" && (
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-primary hover:bg-primary/10"
                          onClick={() => navigate("/applications")} data-testid={`btn-documents-rep-${member.id}`}
                          aria-label={`Open rep onboarding for ${member.name}`}
                          title="Open rep onboarding">
                          <FileSignature className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      {canManageCommission && member.role !== "manager" && canLifecycle(member) && (
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-primary hover:bg-primary/10"
                          onClick={() => setCommissionMember(member)} data-testid={`btn-commission-rep-${member.id}`}
                          aria-label={`Set commission structure for ${member.name}`}
                          title="Commission structure">
                          <Wallet className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      {canEditMember(member) && (
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground hover:bg-secondary"
                          onClick={() => openEdit(member)} data-testid={`btn-edit-rep-${member.id}`}
                          aria-label={`Edit ${member.name}`} title={member.id === myMemberId ? "Edit your profile" : "Edit member"}>
                          <Edit2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      {canLifecycle(member) && member.active && (
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-amber-400 hover:bg-amber-500/10"
                          onClick={() => setOffboardMember(member)} data-testid={`btn-offboard-rep-${member.id}`}
                          aria-label={`Offboard ${member.name}`} title="Offboard - remove access, keep records">
                          <UserMinus className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      {canHardDelete(member) && (
                        <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
                          onClick={() => setDeleteId(member.id)} data-testid={`btn-delete-rep-${member.id}`}
                          aria-label={`Remove ${member.name}`} title="Delete member record">
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    );
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 p-4 pt-5 pb-24 md:space-y-6 md:p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Organization</div>
          <h1 className="text-xl font-bold text-foreground mt-0.5">Team management</h1>
          <p className="text-sm text-muted-foreground mt-1">
            <span className="tabular-nums font-medium text-foreground">{activeCount}</span> active member{activeCount !== 1 ? "s" : ""}
            <span className="mx-1.5 text-border">·</span>
            <span className="tabular-nums">{managers.length}</span> manager{managers.length !== 1 ? "s" : ""}
            <span className="mx-1.5 text-border">·</span>
            <span className="tabular-nums">{leads.length}</span> team lead{leads.length !== 1 ? "s" : ""}
            <span className="mx-1.5 text-border">·</span>
            <span className="tabular-nums">{reps.length}</span> rep{reps.length !== 1 ? "s" : ""}
          </p>
        </div>
        {canAddMembers && (
          <Button
            onClick={() => { setAddForm(emptyForm()); setAddOpen(true); }}
            className="h-9 bg-primary hover:bg-primary/90 text-primary-foreground text-sm shadow-sm"
            data-testid="btn-add-rep"
          >
             Add Member
          </Button>
        )}
      </div>

      {/* Team totals — hairline-divided metric strip */}
      {team.length > 0 && (
        <Card className="bg-card border-border overflow-hidden rounded-xl">
          <div className="flex divide-x divide-border overflow-x-auto">
            {[
              { label: "Active Members", val: activeCount, Icon: Users },
              { label: "Knocks", val: totalKnocks, Icon: DoorOpen },
              { label: "Contacts", val: totalContacts, Icon: Handshake },
              { label: "Callbacks", val: totalCallbacks, Icon: PhoneCall },
              { label: "Sales", val: totalSales, highlight: true, Icon: TrendingUp },
            ].map(({ label, val, highlight, }) => (
              <div key={label} className="flex-1 min-w-[120px] px-4 py-3">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  
                  <span className="text-[11px] font-semibold uppercase tracking-wide">{label}</span>
                </div>
                <div className={`text-2xl font-bold tabular-nums mt-1.5 ${highlight ? "text-emerald-400" : "text-foreground"}`}>{val.toLocaleString()}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Role legend — stacks on phones so the icon + label + description of each
          role stays readable instead of being crushed into a third of 320px. */}
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2 px-0.5">Roles &amp; Access</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {ROLES.map(r => (
            <div key={r.value} className="rounded-xl border border-border p-3.5 bg-card">
              <div className="flex items-center gap-2 mb-1.5">
                <div className={`w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 ${r.avatarColor}`}>
                </div>
                <span className="text-sm font-semibold text-foreground">{r.label}</span>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{r.description}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Members list */}
      {isLoading ? (
        <div className="space-y-6" aria-busy="true">
          {[0, 1].map(sec => (
            <div key={sec}>
              <div className="flex items-center gap-2.5 mb-2.5 px-0.5">
                <div className="w-6 h-6 rounded-lg bg-muted animate-pulse" />
                <div className="h-3 w-24 rounded bg-muted animate-pulse" />
              </div>
              <Card className="bg-card border-border overflow-hidden rounded-xl">
                <div className="divide-y divide-border">
                  {[0, 1, 2].map(i => (
                    <div key={i} className="flex items-center gap-3 p-4">
                      <div className="w-10 h-10 rounded-full bg-muted animate-pulse flex-shrink-0" />
                      <div className="flex-1 space-y-2">
                        <div className="h-3.5 w-40 rounded bg-muted animate-pulse" />
                        <div className="h-3 w-56 rounded bg-muted animate-pulse" />
                      </div>
                      <div className="hidden md:flex items-center gap-5">
                        {[0, 1, 2, 3].map(k => <div key={k} className="h-5 w-10 rounded bg-muted animate-pulse" />)}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          ))}
        </div>
      ) : isError && !isLoading ? (
        <Card className="bg-card border-red-500/25 rounded-xl">
          <CardContent className="py-14 text-center">
            <div className="text-sm font-semibold text-red-400">Couldn't load the team</div>
            <p className="text-sm text-muted-foreground mt-1 mb-4 max-w-xs mx-auto">This is a fetch problem, not an empty roster.</p>
            <button type="button" onClick={() => void refetchTeam()} className="h-9 rounded-lg border border-border px-4 text-xs font-semibold hover:bg-secondary">Retry</button>
          </CardContent>
        </Card>
      ) : team.length === 0 ? (
        <Card className="bg-card border-border rounded-xl">
          <CardContent className="py-14 text-center">
            
            <div className="text-sm font-semibold text-foreground">No team members yet</div>
            <p className="text-sm text-muted-foreground mt-1 mb-4 max-w-xs mx-auto">
              Add your first manager, team lead, or rep to start building your org chart.
            </p>
            {canAddMembers && (
              <Button
                onClick={() => { setAddForm(emptyForm()); setAddOpen(true); }}
                className="h-9 bg-primary hover:bg-primary/90 text-primary-foreground text-sm shadow-sm"
              >
                 Add First Member
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <RoleSection title="Managers" members={managers} role="manager" />
          <RoleSection title="Team leads" members={leads} role="team_lead" />
          <RoleSection title="Sales reps" members={reps} role="rep" />

          {/* Former members - offboarded people keep their records but lose all
              access. Anyone who outranks them can bring them back. */}
          {formerMembers.length > 0 && (
            <div>
              <div className="flex items-center gap-2.5 mb-2.5 px-0.5">
                
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Former members</h2>
                <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-muted text-[11px] font-medium text-muted-foreground tabular-nums">{formerMembers.length}</span>
                <div className="flex-1 h-px bg-border" />
              </div>
              <Card className="bg-card border-border overflow-hidden rounded-xl">
                <div className="divide-y divide-border">
                  {formerMembers.map(member => {
                    const ri2 = roleInfo(member.role);
                    return (
                      <div key={member.id} data-testid={`card-former-${member.id}`}
                        className="flex items-center gap-3 p-4 hover:bg-secondary/40 transition-colors">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ring-1 ring-inset ring-black/5 dark:ring-white/10 opacity-50 grayscale ${ri2.avatarColor}`}>
                          {initials(member.name)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-sm text-muted-foreground leading-tight truncate">{member.name}</span>
                            <Badge className={`h-5 gap-1 px-1.5 rounded-full border-0 text-[11px] font-medium opacity-60 ${ri2.color}`}>
                              {ri2.short}
                            </Badge>
                            <span className="inline-flex items-center gap-1 h-5 pl-1.5 pr-2 rounded-full text-[11px] font-medium bg-muted text-muted-foreground">
                              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
                              Offboarded
                            </span>
                          </div>
                          <div className="text-[11px] text-muted-foreground mt-1">
                            Login disabled · records retained{member.email ? ` · ${member.email}` : ""}
                          </div>
                        </div>
                        <div className="flex items-center justify-end gap-1 flex-shrink-0">
                          {canLifecycle(member) && (
                            <Button variant="outline" size="sm"
                              className="h-8 border-border text-emerald-500 hover:text-emerald-400 hover:bg-emerald-500/10"
                              onClick={() => reactivateMutation.mutate(member.id)}
                              disabled={reactivateMutation.isPending && reactivateMutation.variables === member.id}
                              data-testid={`btn-reactivate-rep-${member.id}`}
                              aria-label={`Reactivate ${member.name}`} title="Restore access">
                              
                              {reactivateMutation.isPending && reactivateMutation.variables === member.id ? "Restoring…" : "Reactivate"}
                            </Button>
                          )}
                          {canHardDelete(member) && (
                            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-red-400 hover:bg-red-500/10"
                              onClick={() => setDeleteId(member.id)} data-testid={`btn-delete-rep-${member.id}`}
                              aria-label={`Remove ${member.name}`} title="Delete member record">
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            </div>
          )}
        </div>
      )}

      {/* Offboard confirm - spells out exactly what the kick does before it happens */}
      <Dialog open={!!offboardMember} onOpenChange={v => !v && setOffboardMember(null)}>
        <DialogContent className="bg-card border-border text-foreground max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              
              Offboard {offboardMember?.name}?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground -mt-1">
            This removes their access immediately, but keeps every record. You can reactivate them later.
          </p>
          <div className="rounded-xl bg-secondary/40 border border-border divide-y divide-border text-sm">
            <div className="flex items-start gap-2.5 px-3 py-2.5">
              
              <div>
                <div className="font-medium text-foreground">Login disabled &amp; signed out everywhere</div>
                <div className="text-xs text-muted-foreground">Every live session ends now - not at their next login.</div>
              </div>
            </div>
            {offboardMember && directReportsOf(offboardMember.id).length > 0 && (
              <div className="flex items-start gap-2.5 px-3 py-2.5">
                
                <div>
                  <div className="font-medium text-foreground">
                    {directReportsOf(offboardMember.id).length} direct report{directReportsOf(offboardMember.id).length === 1 ? "" : "s"} re-homed
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {directReportsOf(offboardMember.id).map(r => r.name).join(", ")} will report to {
                      (offboardMember as any).reportsToId
                        ? (team.find(t => t.id === (offboardMember as any).reportsToId)?.name ?? "their next supervisor")
                        : "the organization admin"
                    }.
                  </div>
                </div>
              </div>
            )}
            <div className="flex items-start gap-2.5 px-3 py-2.5">
              
              <div>
                <div className="font-medium text-foreground">Knocks, sales &amp; documents retained</div>
                <div className="text-xs text-muted-foreground">History stays for commissions and audit. The action itself is logged.</div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOffboardMember(null)} className="h-9 border-border">Cancel</Button>
            <Button
              onClick={() => offboardMember && offboardMutation.mutate(offboardMember.id)}
              disabled={offboardMutation.isPending}
              className="h-9 bg-amber-600 hover:bg-amber-600/90 text-white"
              data-testid="btn-confirm-offboard"
            >
              {offboardMutation.isPending ? "Offboarding…" : "Offboard Member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Member Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="bg-card border-border text-foreground max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              
              Add Team Member
            </DialogTitle>
          </DialogHeader>
          <MemberFormUI
            form={addForm}
            setForm={setAddForm}
            onSave={() => createMutation.mutate(addForm as InsertTeamMember)}
            onCancel={() => setAddOpen(false)}
            saving={createMutation.isPending}
            team={team}
            creatorRole={user?.role ?? "team_lead"}
          />
        </DialogContent>
      </Dialog>

      {/* Edit Member Dialog */}
      <Dialog open={!!editMember} onOpenChange={v => !v && setEditMember(null)}>
        <DialogContent className="bg-card border-border text-foreground max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              
              Edit Team Member
            </DialogTitle>
          </DialogHeader>
          {editMember && (
            <MemberFormUI
              form={editForm}
              setForm={setEditForm}
              onSave={() => {
                // Self-edits may only carry profile fields; other edits send the
                // editable fields but never `active` - lifecycle changes go
                // through Offboard/Reactivate so sessions and reports are handled.
                const data: Partial<InsertTeamMember> = editMember.id === myMemberId
                  ? { name: editForm.name, phone: editForm.phone }
                  : {
                      name: editForm.name, phone: editForm.phone, email: editForm.email,
                      role: editForm.role, reportsToId: editForm.reportsToId,
                    } as Partial<InsertTeamMember>;
                updateMutation.mutate({ id: editMember.id, data });
              }}
              onCancel={() => setEditMember(null)}
              saving={updateMutation.isPending}
              isEdit
              selfEdit={editMember.id === myMemberId}
              team={team}
              selfId={editMember.id}
              creatorRole={user?.role ?? "team_lead"}
            />
          )}

          {/* COMMISSION, in the same place you edit everything else about the
              member. It lived behind a separate button on the roster row, which
              meant setting up a new rep was two dialogs and a hunt. Kept as a
              clearly separated section rather than merged into the form: the
              profile fields save together, pay is its own decision with its own
              confirmation, and quietly re-pricing someone while renaming them is
              not a mistake worth enabling. */}
          {editMember && canManageCommission && editMember.id !== myMemberId && (
            <div className="mt-1 border-t border-border pt-3">
              <button
                type="button"
                onClick={() => setCommissionMember(editMember)}
                data-testid="btn-edit-commission-inline"
                className="w-full flex items-center justify-between gap-2 rounded-xl border border-border bg-secondary/40 px-3 py-2.5 text-left transition-colors hover:bg-secondary/70"
              >
                <span className="flex items-center gap-2 min-w-0">
                  
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold">Commission</span>
                    <span className="block text-2xs text-muted-foreground truncate">
                      Flat per sale, or retroactive weekly tiers
                    </span>
                  </span>
                </span>
                <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground" />
              </button>
            </div>
          )}

          {/* OVERRIDE RATES - what the upline keeps from each of this member's
              qualified sales, the same knobs the invite form sets for new
              hires, editable here for everyone who predates them. Hidden for
              manager rows (no slot above a manager ever pays) and gated on the
              same capability as every other override money write. Future sales
              only: earned ledger rows carry frozen snapshots. */}
          {editMember && canManageOverrides && editMember.role !== "manager" && editMember.id !== myMemberId && (
            <div className="mt-1 border-t border-border pt-3" data-testid="override-rates-section">
              <div className="flex items-center gap-2 mb-2">
                
                <div className="min-w-0">
                  <span className="block text-xs font-semibold">Upline keep per sale</span>
                  <span className="block text-2xs text-muted-foreground">Overrides on this member's sales · blank = org default</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor="override-tl-rate" className="text-2xs text-muted-foreground">Team lead keeps</Label>
                  <div className="mt-1 flex h-9 items-center rounded-lg border border-border bg-background px-2.5">
                    <span className="mr-1 text-sm text-muted-foreground">$</span>
                    <input
                      id="override-tl-rate" inputMode="decimal"
                      value={overrideTlDollars}
                      onChange={e => setOverrideTlDollars(e.target.value)}
                      placeholder="org default"
                      className="w-full bg-transparent text-sm text-foreground outline-none"
                      data-testid="override-tl-rate"
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor="override-mgr-rate" className="text-2xs text-muted-foreground">Manager keeps</Label>
                  <div className="mt-1 flex h-9 items-center rounded-lg border border-border bg-background px-2.5">
                    <span className="mr-1 text-sm text-muted-foreground">$</span>
                    <input
                      id="override-mgr-rate" inputMode="decimal"
                      value={overrideMgrDollars}
                      onChange={e => setOverrideMgrDollars(e.target.value)}
                      placeholder="org default"
                      className="w-full bg-transparent text-sm text-foreground outline-none"
                      data-testid="override-mgr-rate"
                    />
                  </div>
                </div>
              </div>
              <Button
                type="button" size="sm" variant="secondary"
                onClick={() => overrideRatesMutation.mutate()}
                disabled={overrideRatesMutation.isPending}
                className="mt-2 w-full"
                data-testid="save-override-rates"
              >
                {overrideRatesMutation.isPending ? "Saving…" : "Save override rates"}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={deleteId !== null} onOpenChange={v => !v && setDeleteId(null)}>
        <DialogContent className="bg-card border-border text-foreground max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              
              Remove Member?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This permanently removes{" "}
            <span className="font-medium text-foreground">
              {team.find(m => m.id === deleteId)?.name ?? "this member"}
            </span>{" "}
            from the roster. Their login is disabled, live sessions end, and any direct
            reports are re-homed. Knock history stays in the database. If you might bring
            them back, use <span className="font-medium text-foreground">Offboard</span> instead.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)} className="h-9 border-border">Cancel</Button>
            <Button
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
              disabled={deleteMutation.isPending}
              className="h-9 bg-destructive hover:bg-destructive/90 text-white"
              data-testid="btn-confirm-delete-rep"
            >
              {deleteMutation.isPending ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Commission structure */}
      <CommissionDialog member={commissionMember} onClose={() => setCommissionMember(null)} />
    </div>
  );
}

// ── Per-rep commission structure control ──────────────────────────────────────
// Reads the rep's current effective structure, lets a manager set FLAT vs TIERED
// (a flat rate, or the standard retroactive weekly tiers), and re-assigns via
// POST /api/commission/assign-structure (which closes the current period first).

function CommissionDialog({ member, onClose }: { member: TeamMember | null; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [structure, setStructure] = useState<"TIERED" | "FLAT">("TIERED");
  const [flatRate, setFlatRate] = useState("150");
  // Chargeback reserve, per rep. A BLANK field means "inherit the org default" —
  // the placeholder states what that inherited value currently is, so an empty
  // box is never a mystery. Set here and at onboarding; both write the same
  // columns through the same money-config capability.
  const [reservePct, setReservePct] = useState("");
  const [reserveCap, setReserveCap] = useState("");
  // Editable ladder. Defaults to the operator's stated plan: 1–6 at $150, 7+ at
  // $200 — the final band open-ended so beating it still pays.
  const [tiers, setTiers] = useState<CommissionTier[]>([
    { position: 0, minimumSales: 1, maximumSales: 6, rateCents: 15000, label: "1-6" },
    { position: 1, minimumSales: 7, maximumSales: null, rateCents: 20000, label: "7+" },
  ]);

  const { data: current, isLoading } = useQuery<any>({
    queryKey: ["/api/commission/reps", member?.id, "structure"],
    queryFn: () => apiRequest("GET", `/api/commission/reps/${member!.id}/structure`).then(r => r.json()),
    enabled: !!member,
  });

  // Seed the picker from the rep's current structure when it loads.
  useEffect(() => {
    if (!current) return;
    if (current.structure === "FLAT") {
      setStructure("FLAT");
      // Divide, don't Math.round the cents first — $150.50 was seeding as "151",
      // and a manager who then hit Apply re-booked the rep at a rate 50 cents
      // off from what the screen had shown them as "current".
      setFlatRate(String((current.flatRateCents || 15000) / 100));
    } else if (current.structure === "TIERED") {
      setStructure("TIERED");
      // Edit the ladder the rep is ACTUALLY on, not the default. Without this
      // the dialog always opened on 1-6/$150 · 7+/$200 — a manager reviewing a
      // custom plan saw the wrong numbers, and "Apply" would quietly reset the
      // rep to the ladder shown rather than the ladder assigned.
      if (Array.isArray(current.tiers) && current.tiers.length > 0) {
        setTiers(current.tiers.map((t: any, i: number) => ({
          position: i, minimumSales: t.minimumSales, maximumSales: t.maximumSales ?? null,
          rateCents: t.rateCents, label: t.label || "",
        })));
      }
    }
    // Reserve overrides seed from the rep's RAW override (null = inherited), so
    // reopening the dialog and hitting Apply can never silently promote an
    // inherited value into a hard per-rep override.
    const r = current.reserve;
    if (r) {
      setReservePct(r.repReservePercent == null ? "" : String(r.repReservePercent));
      setReserveCap(r.repReserveCapCents == null ? "" : String(r.repReserveCapCents / 100));
    }
  }, [current]);

  // Client-side gate mirroring the server's shared validator, so Apply is
  // never an armed button for a plan the server will reject — and when it is
  // blocked, the reason is on screen (the dead-button rule).
  const tierValidation = useMemo(() => validateTiers(tiers), [tiers]);
  const flatCents = Math.round((parseFloat(flatRate) || 0) * 100);
  // Reserve inputs: blank = inherit. Anything else must be a whole percent
  // 0..100 / a non-negative dollar amount, mirroring the server's validator.
  const reservePctTrimmed = reservePct.trim();
  const reserveCapTrimmed = reserveCap.trim();
  const reservePctValue = reservePctTrimmed === "" ? null : Number(reservePctTrimmed);
  const reserveCapValue = reserveCapTrimmed === "" ? null : Number(reserveCapTrimmed);
  const reserveBlocked =
    reservePctValue != null && (!Number.isInteger(reservePctValue) || reservePctValue < 0 || reservePctValue > 100)
      ? "Reserve percent must be a whole number from 0 to 100 (leave blank to inherit)"
    : reserveCapValue != null && (!Number.isFinite(reserveCapValue) || reserveCapValue < 0)
      ? "Reserve maximum must be $0 or more (leave blank to inherit)"
    : null;
  const blockedReason =
    structure === "TIERED" && !tierValidation.ok ? tierValidation.errors[0]
    : structure === "FLAT" && !(flatCents > 0) ? "Enter a per-sale rate above $0"
    : structure === "FLAT" && flatCents > 100000 ? "Rate above $1,000/sale - check the number"
    : reserveBlocked;

  const assignMutation = useMutation({
    mutationFn: async () => {
      const body: any = { repId: member!.id, structure, closeExisting: true };
      // Integer cents cross the wire — the dollars → cents conversion happens
      // ONCE, here. `null` explicitly clears the override back to the org default.
      body.reservePercent = reservePctValue == null ? null : Math.trunc(reservePctValue);
      body.reserveCapCents = reserveCapValue == null ? null : Math.round(reserveCapValue * 100);
      if (structure === "FLAT") body.flatRateCents = flatCents;
      // Tiers travel as integer cents; the server re-validates before it books
      // anything, so this is a request, not a decision.
      else body.tiers = tiers.map(t => ({
        minimumSales: t.minimumSales, maximumSales: t.maximumSales,
        rateCents: t.rateCents, label: t.label || (t.maximumSales == null ? `${t.minimumSales}+` : `${t.minimumSales}-${t.maximumSales}`),
      }));
      const res = await apiRequest("POST", "/api/commission/assign-structure", body);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Commission structure updated", description: `${member?.name} is now on the ${structure === "FLAT" ? "flat per-sale" : "tiered weekly"} plan.` });
      qc.invalidateQueries({ queryKey: ["/api/commission/reps", member?.id, "structure"] });
      onClose();
    },
    onError: (err: any) => toast({ title: err.message || "Failed to update commission", variant: "destructive" }),
  });

  const curStruct = current?.structure as ("FLAT" | "TIERED" | undefined);

  return (
    <Dialog open={!!member} onOpenChange={v => !v && onClose()}>
      <DialogContent className="bg-card border-border text-foreground max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
             Commission - {member?.name}
          </DialogTitle>
        </DialogHeader>

        {/* Current structure */}
        <div className="flex items-center gap-2 rounded-xl bg-secondary/40 border border-border px-3 py-2.5 text-xs">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Current</span>
          {isLoading ? (
            <span className="text-muted-foreground">loading…</span>
          ) : curStruct === "FLAT" ? (
            <span className="text-foreground font-semibold tabular-nums">Flat - ${((current.flatRateCents || 0) / 100).toLocaleString()}/sale</span>
          ) : curStruct === "TIERED" ? (
            <span className="text-foreground font-semibold">Tiered - {current.planName || "weekly ladder"}</span>
          ) : (
            <span className="text-amber-400 font-medium">No plan assigned yet</span>
          )}
        </div>

        {/* Structure picker */}
        <div className="grid grid-cols-2 gap-2 mt-1">
          <button type="button" onClick={() => setStructure("TIERED")}
            aria-pressed={structure === "TIERED"}
            className={`flex items-start gap-2 rounded-xl border p-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${structure === "TIERED" ? "border-primary/60 bg-primary/10 ring-1 ring-primary/40" : "border-border bg-secondary/40 hover:bg-secondary/70"}`}
            data-testid="btn-team-structure-tiered">
            
            <span><span className="block text-xs font-semibold">Tiered</span><span className="block text-2xs text-muted-foreground leading-tight">Retroactive weekly</span></span>
          </button>
          <button type="button" onClick={() => setStructure("FLAT")}
            aria-pressed={structure === "FLAT"}
            className={`flex items-start gap-2 rounded-xl border p-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${structure === "FLAT" ? "border-primary/60 bg-primary/10 ring-1 ring-primary/40" : "border-border bg-secondary/40 hover:bg-secondary/70"}`}
            data-testid="btn-team-structure-flat">
            
            <span><span className="block text-xs font-semibold">Flat</span><span className="block text-2xs text-muted-foreground leading-tight">Per qualified sale</span></span>
          </button>
        </div>

        {structure === "TIERED" ? (
          <div className="rounded-xl bg-secondary/30 border border-border p-2.5 mt-1">
            <p className="text-2xs text-muted-foreground mb-2">
              Total weekly sales set one rate for <span className="font-semibold text-foreground">every</span> sale
              - hit the next band and the whole week re-prices at that rate.
            </p>
            {/* The ladder was a fixed display. Editable now: bands stay tiled and
                the last stays open-ended by construction, so a rep can never sell
                into a gap or past the top and earn nothing. */}
            <TierEditor tiers={tiers} onChange={setTiers} disabled={assignMutation.isPending} />
          </div>
        ) : (
          <div className="mt-1 space-y-1.5">
            <Label htmlFor="input-team-flat-rate" className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Rate per qualified sale</Label>
            <div className="flex items-center gap-1.5">
              <span className="text-muted-foreground">$</span>
              <Input id="input-team-flat-rate" type="number" min={1} step={1} value={flatRate} onChange={e => setFlatRate(e.target.value)}
                className="h-9 w-28 bg-secondary border-border tabular-nums" data-testid="input-team-flat-rate" />
              <span className="text-xs text-muted-foreground">per sale</span>
            </div>
          </div>
        )}

        {/* ── Chargeback reserve ────────────────────────────────────────────
            Percent AND maximum are both per-rep. Blank inherits the org
            default (stated in the placeholder), so nothing changes for a rep
            an admin never touches. Money is entered in dollars and converted
            to integer cents once, at submit. */}
        <div className="mt-1 rounded-2xl border border-border bg-secondary/30 p-3">
          <div className="flex items-center gap-2">
            
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Chargeback reserve</Label>
          </div>
          <p className="mt-1 text-2xs text-muted-foreground leading-snug">
            Holds part of each week's pay to cover cancellations. It builds to the maximum and then stops.
          </p>
          <div className="mt-2.5 grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="reserve-percent" className="text-2xs font-semibold text-muted-foreground">Held each week</Label>
              <div className="flex items-center gap-1.5">
                <Input id="reserve-percent" type="number" min={0} max={100} step={1} inputMode="numeric"
                  value={reservePct} onChange={e => setReservePct(e.target.value)}
                  placeholder={String(current?.reserve?.orgReservePercent ?? 0)}
                  className="h-9 w-20 bg-secondary border-border tabular-nums" data-testid="input-team-reserve-percent" />
                <span className="text-xs text-muted-foreground">%</span>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="reserve-cap" className="text-2xs font-semibold text-muted-foreground">Maximum held</Label>
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">$</span>
                <Input id="reserve-cap" type="number" min={0} step={100} inputMode="decimal"
                  value={reserveCap} onChange={e => setReserveCap(e.target.value)}
                  placeholder={String(Math.round((current?.reserve?.reserveCapCents ?? 250000) / 100))}
                  className="h-9 w-24 bg-secondary border-border tabular-nums" data-testid="input-team-reserve-cap" />
              </div>
            </div>
          </div>
          <p className="mt-2 text-2xs text-muted-foreground" data-testid="text-reserve-inherit-hint">
            Leave blank to use the company default
            {" "}({current?.reserve?.orgReservePercent ?? 0}% up to{" "}
            <span className="tabular-nums">
              ${(((current?.reserve?.orgReserveCapCents ?? 250000)) / 100).toLocaleString()}
            </span>).
          </p>
        </div>

        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={onClose} className="h-9 border-border">Cancel</Button>
          <Button onClick={() => assignMutation.mutate()} disabled={assignMutation.isPending || !!blockedReason}
            className="h-9 bg-primary hover:bg-primary/90 text-primary-foreground" data-testid="btn-save-commission">
            {assignMutation.isPending ? "Saving…" : "Apply structure"}
          </Button>
        </DialogFooter>
        {blockedReason && (
          <p className="text-[11px] text-amber-400 text-right -mt-1" data-testid="commission-blocked-reason">
            {blockedReason}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
