import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  UserPlus, Edit2, Trash2, Phone, Mail, Shield,
  User, CheckCircle2, XCircle, Users, Crown, Star, ChevronUp
} from "lucide-react";
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

// ── Role picker card ──────────────────────────────────────────────────────────
function RolePicker({ value, onChange }: { value: RepRole; onChange: (v: RepRole) => void }) {
  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">Role *</Label>
      <div className="space-y-2">
        {ROLES.map(r => {
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
  form, setForm, onSave, onCancel, saving, isEdit, team, selfId
}: {
  form: MemberForm;
  setForm: (f: MemberForm) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  isEdit?: boolean;
  team: TeamMember[];
  selfId?: number;
}) {
  const set = (k: keyof MemberForm, v: string | boolean) =>
    setForm({ ...form, [k]: v });

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
          <Label className="text-xs text-muted-foreground">Email</Label>
          <Input
            value={form.email}
            onChange={e => set("email", e.target.value)}
            className="bg-secondary border-input mt-1"
            placeholder="rep@email.com"
            data-testid="form-rep-email"
          />
        </div>
      </div>

      {/* Role picker — changing role resets the supervisor (eligibility changes) */}
      <RolePicker value={form.role} onChange={v => setForm({ ...form, role: v, reportsToId: null })} />

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

  const { toast } = useToast();
  const qc = useQueryClient();

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

  const RoleSection = ({ title, members, role }: { title: string; members: TeamMember[]; role: string }) => {
    const ri = roleInfo(role);
    if (members.length === 0) return null;
    return (
      <div>
        <div className="flex items-center gap-2 mb-3">
          <div className={`w-6 h-6 rounded-full flex items-center justify-center ${ri.avatarColor}`}>
            <ri.Icon className="w-3 h-3" />
          </div>
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          <span className="text-xs text-muted-foreground">({members.length})</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {members.map(member => {
            const s = statsFor(member.id);
            const ri2 = roleInfo(member.role);
            return (
              <Card key={member.id} className="bg-card border-border hover:border-primary/30 transition-colors"
                data-testid={`card-rep-${member.id}`}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold flex-shrink-0 ${ri2.avatarColor}`}>
                        {member.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <div className="font-semibold text-sm text-foreground leading-tight">{member.name}</div>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <Badge className={`text-xs px-1.5 py-0 rounded-full border-0 ${ri2.color}`}>
                            <ri2.Icon className="w-2.5 h-2.5 mr-0.5" />
                            {ri2.short}
                          </Badge>
                          {member.active ? (
                            <Badge className="text-xs px-1.5 py-0 rounded-full bg-green-500/15 text-green-400 border-0">
                              <CheckCircle2 className="w-2.5 h-2.5 mr-0.5" />Active
                            </Badge>
                          ) : (
                            <Badge className="text-xs px-1.5 py-0 rounded-full bg-muted text-muted-foreground border-0">
                              <XCircle className="w-2.5 h-2.5 mr-0.5" />Inactive
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      {canAddMembers && (
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                          onClick={() => openEdit(member)} data-testid={`btn-edit-rep-${member.id}`}>
                          <Edit2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      {canDeleteMembers && (
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground hover:text-red-400"
                          onClick={() => setDeleteId(member.id)} data-testid={`btn-delete-rep-${member.id}`}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Contact info */}
                  <div className="mt-3 space-y-1">
                    {(member as any).reportsToId && (() => {
                      const sup = team.find(t => t.id === (member as any).reportsToId);
                      return sup ? (
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <ChevronUp className="w-3 h-3" /> Reports to <span className="text-foreground/80">{sup.name}</span>
                        </div>
                      ) : null;
                    })()}
                    {member.phone && (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Phone className="w-3 h-3" /> {member.phone}
                      </div>
                    )}
                    {member.email && (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Mail className="w-3 h-3" /> {member.email}
                      </div>
                    )}
                  </div>

                  {/* Mini stats */}
                  <div className="mt-3 grid grid-cols-4 gap-1 text-center">
                    {[
                      { label: "Knocks", val: s.knocks },
                      { label: "Contacts", val: s.contacts },
                      { label: "Callbacks", val: s.callbacks },
                      { label: "Sales", val: s.sales, highlight: true },
                    ].map(({ label, val, highlight }) => (
                      <div key={label} className="bg-secondary rounded p-1.5">
                        <div className={`text-base font-bold ${highlight && val > 0 ? "text-green-400" : "text-foreground"}`}>
                          {val}
                        </div>
                        <div className="text-xs text-muted-foreground leading-tight">{label}</div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
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

      {/* Role legend */}
      <div className="grid grid-cols-3 gap-2">
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
    </div>
  );
}
