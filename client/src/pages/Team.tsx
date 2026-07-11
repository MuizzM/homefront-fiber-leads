import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  UserPlus, Edit2, Trash2, Phone, Mail,
  User, CheckCircle2, Users, Crown, Star, ChevronUp,
  Wallet, Layers, DollarSign
} from "lucide-react";
import { useCan } from "@/lib/capabilities";
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

export type RepRole = "rep" | "team_lead" | "manager";

export function roleInfo(role: string) {
  return ROLES.find(r => r.value === role) ?? ROLES[0];
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

// Org rank — a member reports to someone strictly above them.
const ROLE_RANK: Record<string, number> = { rep: 1, team_lead: 2, manager: 3 };

// Which member roles each account role may create — mirrors the server check.
// Admin hires managers; managers hire team leads + reps; team leads hire reps only.
const HIRABLE_ROLES: Record<string, RepRole[]> = {
  admin: ["rep", "team_lead", "manager"],
  manager: ["rep", "team_lead"],
  team_lead: ["rep"],
};

// ── Role picker card ──────────────────────────────────────────────────────────
function RolePicker({ value, onChange, allowed }: { value: RepRole; onChange: (v: RepRole) => void; allowed: RepRole[] }) {
  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">Role *</Label>
      <div className="space-y-2">
        {ROLES.filter(r => allowed.includes(r.value)).map(r => {
          const selected = value === r.value;
          return (
            <button
              key={r.value}
              type="button"
              onClick={() => onChange(r.value as RepRole)}
              data-testid={`role-option-${r.value}`}
              className={`w-full text-left rounded-lg border px-3 py-2.5 transition-all ${
                selected
                  ? "border-primary bg-primary/10 ring-1 ring-primary/30"
                  : "border-border bg-secondary hover:border-primary/40"
              }`}
            >
              <div className="flex items-center gap-2.5">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${r.avatarColor}`}>
                  <r.Icon className="w-3.5 h-3.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">{r.label}</span>
                    {selected && (
                      <CheckCircle2 className="w-3.5 h-3.5 text-primary flex-shrink-0" />
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
  form, setForm, onSave, onCancel, saving, isEdit, team, selfId, creatorRole
}: {
  form: MemberForm;
  setForm: (f: MemberForm) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  isEdit?: boolean;
  team: TeamMember[];
  selfId?: number;
  creatorRole: string;
}) {
  const set = (k: keyof MemberForm, v: string | boolean) =>
    setForm({ ...form, [k]: v });

  // Only offer roles the current user is allowed to hire (admin → managers too)
  const allowedRoles = HIRABLE_ROLES[creatorRole] ?? ["rep"];

  // Managers report to Admin (no picker). Reps → team lead/manager; team leads → manager.
  const showReportsTo = form.role === "rep" || form.role === "team_lead";
  const supervisors = team.filter(
    m => m.id !== selfId && (ROLE_RANK[m.role] ?? 0) > (ROLE_RANK[form.role] ?? 0)
  );

  return (
    <div className="space-y-3">
      <div>
        <Label className="text-xs text-muted-foreground">Full Name *</Label>
        <Input
          value={form.name}
          onChange={e => set("name", e.target.value)}
          className="bg-secondary border-input mt-1"
          placeholder="Marcus Johnson"
          data-testid="form-rep-name"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs text-muted-foreground">Phone</Label>
          <Input
            value={form.phone}
            onChange={e => set("phone", e.target.value)}
            className="bg-secondary border-input mt-1"
            placeholder="(704) 555-0101"
            data-testid="form-rep-phone"
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Email (login access)</Label>
          <Input
            value={form.email}
            onChange={e => set("email", e.target.value)}
            className="bg-secondary border-input mt-1"
            placeholder="rep@email.com"
            data-testid="form-rep-email"
          />
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground -mt-1">
        Members with an email can log in with a one-time code sent to that address.
      </p>

      {/* Role picker — changing role resets the supervisor (eligibility changes) */}
      <RolePicker value={form.role} onChange={v => setForm({ ...form, role: v, reportsToId: null })} allowed={allowedRoles} />

      {/* Reports To — who this member is under in the org chart */}
      {showReportsTo && (
        <div>
          <Label className="text-xs text-muted-foreground">
            Reports To {form.role === "rep" ? "(Team Lead or Manager)" : "(Manager)"}
          </Label>
          <Select
            value={form.reportsToId != null ? String(form.reportsToId) : "none"}
            onValueChange={v => setForm({ ...form, reportsToId: v === "none" ? null : Number(v) })}
          >
            <SelectTrigger className="bg-secondary border-input mt-1" data-testid="form-rep-reports-to">
              <SelectValue placeholder="Select supervisor" />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value="none">— None (reports to Admin) —</SelectItem>
              {supervisors.map(m => (
                <SelectItem key={m.id} value={String(m.id)}>
                  {m.name} · {roleInfo(m.role).short}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {supervisors.length === 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              No {form.role === "rep" ? "team leads or managers" : "managers"} added yet — leave as top-level for now.
            </p>
          )}
        </div>
      )}

      {/* Status toggle (edit only) */}
      {isEdit && (
        <div>
          <Label className="text-xs text-muted-foreground">Status</Label>
          <Select value={form.active ? "active" : "inactive"} onValueChange={v => set("active", v === "active")}>
            <SelectTrigger className="bg-secondary border-input mt-1" data-testid="form-rep-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <Button variant="outline" onClick={onCancel} className="border-border flex-1">Cancel</Button>
        <Button
          onClick={onSave}
          disabled={saving || !form.name.trim()}
          className="bg-primary hover:bg-primary/90 text-white flex-1"
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
  const [addOpen, setAddOpen] = useState(false);
  const [editMember, setEditMember] = useState<TeamMember | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [addForm, setAddForm] = useState<MemberForm>(emptyForm());
  const [editForm, setEditForm] = useState<MemberForm>(emptyForm());
  const [commissionMember, setCommissionMember] = useState<TeamMember | null>(null);

  const { toast } = useToast();
  const qc = useQueryClient();
  const canManageCommission = useCan("commission.structure.manage");

  const { data: team = [], isLoading } = useQuery<TeamMember[]>({
    queryKey: ["/api/team"],
  });

  const { data: leaderboard = [] } = useQuery<{
    rep: TeamMember; knocks: number; contacts: number; callbacks: number; sales: number;
  }[]>({
    queryKey: ["/api/leaderboard"],
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
    onSuccess: () => {
      toast({ title: "Member removed" });
      qc.invalidateQueries({ queryKey: ["/api/team"] });
      qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      setDeleteId(null);
    },
    onError: (err: any) => {
      toast({ title: err.message || "Failed to remove", variant: "destructive" });
    },
  });

  const statsFor = (repId: number) =>
    leaderboard.find(l => l.rep.id === repId) ?? { knocks: 0, contacts: 0, callbacks: 0, sales: 0 };

  const openEdit = (m: TeamMember) => {
    setEditForm(fromMember(m));
    setEditMember(m);
  };

  // Permission check — team_lead, manager, admin can add members
  const canAddMembers = user?.role && ["admin", "manager", "team_lead"].includes(user.role);
  const canDeleteMembers = user?.role && ["admin", "manager"].includes(user.role);

  // Group by role for display
  const managers = team.filter(m => m.role === "manager");
  const leads = team.filter(m => m.role === "team_lead");
  const reps = team.filter(m => m.role === "rep");

  // Team totals for the metric strip (derived from leaderboard/team — no new calls)
  const activeCount = team.filter(m => m.active).length;
  const totalKnocks = leaderboard.reduce((a, l) => a + l.knocks, 0);
  const totalContacts = leaderboard.reduce((a, l) => a + l.contacts, 0);
  const totalCallbacks = leaderboard.reduce((a, l) => a + l.callbacks, 0);
  const totalSales = leaderboard.reduce((a, l) => a + l.sales, 0);

  const RoleSection = ({ title, members, role }: { title: string; members: TeamMember[]; role: string }) => {
    const ri = roleInfo(role);
    if (members.length === 0) return null;
    return (
      <div>
        {/* Section header — micro-label + count */}
        <div className="flex items-center gap-2 mb-2 px-1">
          <div className={`w-5 h-5 rounded-full flex items-center justify-center ${ri.avatarColor}`}>
            <ri.Icon className="w-2.5 h-2.5" />
          </div>
          <h2 className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">{title}</h2>
          <span className="text-[11px] text-muted-foreground tabular-nums">{members.length}</span>
        </div>

        {/* Roster — hairline-divided rows */}
        <Card className="bg-card border-border overflow-hidden">
          <div className="divide-y divide-border">
            {members.map(member => {
              const s = statsFor(member.id);
              const ri2 = roleInfo(member.role);
              const sup = (member as any).reportsToId
                ? team.find(t => t.id === (member as any).reportsToId)
                : null;
              const metrics = [
                { label: "Knocks", val: s.knocks },
                { label: "Contacts", val: s.contacts },
                { label: "Callbacks", val: s.callbacks },
                { label: "Sales", val: s.sales, highlight: true },
              ];
              return (
                <div key={member.id} data-testid={`card-rep-${member.id}`}
                  className="flex items-center gap-3 p-4 hover:bg-secondary/40 transition-colors">
                  {/* Avatar */}
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 ${ri2.avatarColor}`}>
                    {member.name.charAt(0).toUpperCase()}
                  </div>

                  {/* Identity */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm text-foreground leading-tight truncate">{member.name}</span>
                      <Badge className={`text-[11px] px-1.5 py-0 rounded-full border-0 ${ri2.color}`}>
                        <ri2.Icon className="w-2.5 h-2.5 mr-0.5" />
                        {ri2.short}
                      </Badge>
                      <span className="inline-flex items-center gap-1 text-[11px]">
                        <span className={`w-1.5 h-1.5 rounded-full ${member.active ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
                        <span className={member.active ? "text-emerald-400" : "text-muted-foreground"}>
                          {member.active ? "Active" : "Inactive"}
                        </span>
                      </span>
                    </div>

                    {/* Secondary line — reports-to + contact */}
                    <div className="flex items-center gap-x-3 gap-y-0.5 mt-1 flex-wrap text-[11px] text-muted-foreground">
                      {sup && (
                        <span className="inline-flex items-center gap-1">
                          <ChevronUp className="w-3 h-3" /> Reports to <span className="text-foreground/80">{sup.name}</span>
                        </span>
                      )}
                      {member.phone && (
                        <span className="inline-flex items-center gap-1">
                          <Phone className="w-3 h-3" /> {member.phone}
                        </span>
                      )}
                      {member.email && (
                        <span className="inline-flex items-center gap-1">
                          <Mail className="w-3 h-3" /> {member.email}
                          <span className="text-[10px] px-1.5 py-0 rounded-full bg-primary/15 text-primary">login</span>
                        </span>
                      )}
                    </div>

                    {/* Metrics — mobile (below identity) */}
                    <div className="flex md:hidden items-center gap-4 mt-2">
                      {metrics.map(({ label, val, highlight }) => (
                        <div key={label}>
                          <span className={`text-sm font-semibold tabular-nums ${highlight && val > 0 ? "text-emerald-400" : "text-foreground"}`}>{val}</span>
                          <span className="text-[10px] uppercase tracking-wide text-muted-foreground ml-1">{label}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Metrics — desktop (tabular columns) */}
                  <div className="hidden md:flex items-center gap-5 flex-shrink-0">
                    {metrics.map(({ label, val, highlight }) => (
                      <div key={label} className="w-14 text-right">
                        <div className={`text-sm font-semibold tabular-nums ${highlight && val > 0 ? "text-emerald-400" : "text-foreground"}`}>{val}</div>
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
                      </div>
                    ))}
                  </div>

                  {/* Row actions */}
                  <div className="flex gap-1 flex-shrink-0">
                    {canManageCommission && member.role !== "manager" && (
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-primary"
                        onClick={() => setCommissionMember(member)} data-testid={`btn-commission-rep-${member.id}`}
                        title="Commission structure">
                        <Wallet className="w-3.5 h-3.5" />
                      </Button>
                    )}
                    {canAddMembers && (
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                        onClick={() => openEdit(member)} data-testid={`btn-edit-rep-${member.id}`}>
                        <Edit2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                    {canDeleteMembers && (
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-rose-400"
                        onClick={() => setDeleteId(member.id)} data-testid={`btn-delete-rep-${member.id}`}>
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
    );
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">Team Management</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {team.filter(m => m.active).length} active member{team.filter(m => m.active).length !== 1 ? "s" : ""}
            {" · "}
            {managers.length} manager{managers.length !== 1 ? "s" : ""},
            {" "}{leads.length} team lead{leads.length !== 1 ? "s" : ""},
            {" "}{reps.length} rep{reps.length !== 1 ? "s" : ""}
          </p>
        </div>
        {canAddMembers && (
          <Button
            onClick={() => { setAddForm(emptyForm()); setAddOpen(true); }}
            className="bg-primary hover:bg-primary/90 text-white text-sm"
            data-testid="btn-add-rep"
          >
            <UserPlus className="w-4 h-4 mr-1" /> Add Member
          </Button>
        )}
      </div>

      {/* Team totals — hairline-divided metric strip */}
      {team.length > 0 && (
        <Card className="bg-card border-border overflow-hidden">
          <div className="flex divide-x divide-border overflow-x-auto">
            {[
              { label: "Active Members", val: activeCount },
              { label: "Knocks", val: totalKnocks },
              { label: "Contacts", val: totalContacts },
              { label: "Callbacks", val: totalCallbacks },
              { label: "Sales", val: totalSales, highlight: true },
            ].map(({ label, val, highlight }) => (
              <div key={label} className="flex-1 min-w-[110px] px-4 py-3">
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
                <div className={`text-xl font-bold tabular-nums mt-0.5 ${highlight ? "text-emerald-400" : "text-foreground"}`}>{val}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Role legend — stacks on phones so the icon + label + description of each
          role stays readable instead of being crushed into a third of 320px. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        {ROLES.map(r => (
          <div key={r.value} className={`rounded-lg border border-border p-3 bg-card`}>
            <div className="flex items-center gap-1.5 mb-1">
              <div className={`w-5 h-5 rounded-full flex items-center justify-center ${r.avatarColor}`}>
                <r.Icon className="w-2.5 h-2.5" />
              </div>
              <span className="text-xs font-semibold text-foreground">{r.label}</span>
            </div>
            <p className="text-xs text-muted-foreground leading-tight">{r.description}</p>
          </div>
        ))}
      </div>

      {/* Members list */}
      {isLoading ? (
        <div className="text-center py-12 text-muted-foreground text-sm">Loading team...</div>
      ) : team.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="py-12 text-center">
            <Users className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-30" />
            <div className="text-sm text-muted-foreground mb-3">No team members yet.</div>
            {canAddMembers && (
              <Button
                onClick={() => { setAddForm(emptyForm()); setAddOpen(true); }}
                className="bg-primary hover:bg-primary/90 text-white text-sm"
              >
                <UserPlus className="w-4 h-4 mr-1" /> Add First Member
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          <RoleSection title="Managers" members={managers} role="manager" />
          <RoleSection title="Team Leads" members={leads} role="team_lead" />
          <RoleSection title="Sales Reps" members={reps} role="rep" />
        </div>
      )}

      {/* Add Member Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="bg-card border-border text-foreground max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base">Add Team Member</DialogTitle>
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
            <DialogTitle className="text-base">Edit Team Member</DialogTitle>
          </DialogHeader>
          {editMember && (
            <MemberFormUI
              form={editForm}
              setForm={setEditForm}
              onSave={() => updateMutation.mutate({ id: editMember.id, data: editForm as Partial<InsertTeamMember> })}
              onCancel={() => setEditMember(null)}
              saving={updateMutation.isPending}
              isEdit
              team={team}
              selfId={editMember.id}
              creatorRole={user?.role ?? "team_lead"}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={deleteId !== null} onOpenChange={v => !v && setDeleteId(null)}>
        <DialogContent className="bg-card border-border text-foreground max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base">Remove Member?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will remove the member from the team. Their knock history stays in the database.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)} className="border-border">Cancel</Button>
            <Button
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
              disabled={deleteMutation.isPending}
              className="bg-destructive hover:bg-destructive/90 text-white"
              data-testid="btn-confirm-delete-rep"
            >
              Remove
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
const TIER_LADDER = [
  { range: "1–7", rate: "$150" }, { range: "8–12", rate: "$200" },
  { range: "13–16", rate: "$250" }, { range: "17+", rate: "$300" },
];

function CommissionDialog({ member, onClose }: { member: TeamMember | null; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [structure, setStructure] = useState<"TIERED" | "FLAT">("TIERED");
  const [flatRate, setFlatRate] = useState("150");

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
      setFlatRate(String(Math.round((current.flatRateCents || 15000) / 100)));
    } else if (current.structure === "TIERED") {
      setStructure("TIERED");
    }
  }, [current]);

  const assignMutation = useMutation({
    mutationFn: async () => {
      const body: any = { repId: member!.id, structure, closeExisting: true };
      if (structure === "FLAT") body.flatRateDollars = parseFloat(flatRate) || 0;
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
            <Wallet className="w-4 h-4 text-primary" /> Commission — {member?.name}
          </DialogTitle>
        </DialogHeader>

        {/* Current structure */}
        <div className="rounded-lg bg-secondary/40 border border-border px-3 py-2 text-xs">
          <span className="text-muted-foreground">Current: </span>
          {isLoading ? (
            <span className="text-muted-foreground">loading…</span>
          ) : curStruct === "FLAT" ? (
            <span className="text-foreground font-semibold">Flat — ${((current.flatRateCents || 0) / 100).toLocaleString()}/sale</span>
          ) : curStruct === "TIERED" ? (
            <span className="text-foreground font-semibold">Tiered — {current.planName || "weekly ladder"}</span>
          ) : (
            <span className="text-amber-400">No plan assigned yet</span>
          )}
        </div>

        {/* Structure picker */}
        <div className="grid grid-cols-2 gap-2 mt-1">
          <button type="button" onClick={() => setStructure("TIERED")}
            className={`flex items-start gap-2 rounded-xl border p-2.5 text-left transition-colors ${structure === "TIERED" ? "border-primary/60 bg-primary/10 ring-1 ring-primary/40" : "border-border bg-secondary/40 hover:bg-secondary/70"}`}
            data-testid="btn-team-structure-tiered">
            <Layers className={`w-4 h-4 mt-0.5 ${structure === "TIERED" ? "text-primary" : "text-muted-foreground"}`} />
            <span><span className="block text-xs font-semibold">Tiered</span><span className="block text-[10px] text-muted-foreground leading-tight">Retroactive weekly</span></span>
          </button>
          <button type="button" onClick={() => setStructure("FLAT")}
            className={`flex items-start gap-2 rounded-xl border p-2.5 text-left transition-colors ${structure === "FLAT" ? "border-primary/60 bg-primary/10 ring-1 ring-primary/40" : "border-border bg-secondary/40 hover:bg-secondary/70"}`}
            data-testid="btn-team-structure-flat">
            <DollarSign className={`w-4 h-4 mt-0.5 ${structure === "FLAT" ? "text-primary" : "text-muted-foreground"}`} />
            <span><span className="block text-xs font-semibold">Flat</span><span className="block text-[10px] text-muted-foreground leading-tight">Per qualified sale</span></span>
          </button>
        </div>

        {structure === "TIERED" ? (
          <div className="rounded-xl bg-secondary/30 border border-border p-2.5 mt-1">
            <p className="text-[10px] text-muted-foreground mb-2">Total weekly sales set one rate for every sale:</p>
            <div className="grid grid-cols-4 gap-1.5">
              {TIER_LADDER.map(t => (
                <div key={t.range} className="rounded-lg bg-card border border-border px-1 py-1.5 text-center">
                  <div className="text-[9px] text-muted-foreground">{t.range}</div>
                  <div className="text-xs font-bold text-primary">{t.rate}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="mt-1">
            <Label className="text-xs text-muted-foreground">Rate per qualified sale</Label>
            <div className="flex items-center gap-1.5 mt-1">
              <span className="text-muted-foreground">$</span>
              <Input type="number" min={1} step={1} value={flatRate} onChange={e => setFlatRate(e.target.value)}
                className="w-28 bg-secondary border-border" data-testid="input-team-flat-rate" />
              <span className="text-xs text-muted-foreground">per sale</span>
            </div>
          </div>
        )}

        <DialogFooter className="mt-2">
          <Button variant="outline" onClick={onClose} className="border-border">Cancel</Button>
          <Button onClick={() => assignMutation.mutate()} disabled={assignMutation.isPending}
            className="bg-primary hover:bg-primary/90 text-white" data-testid="btn-save-commission">
            {assignMutation.isPending ? "Saving…" : "Apply structure"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
