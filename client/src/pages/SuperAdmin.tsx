import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Building2, Plus, DollarSign, Users, Zap, BarChart2,
  Edit2, Trash2, Shield, Globe, CheckCircle, XCircle,
  TrendingUp, ChevronDown, ChevronUp, Settings, Copy
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

type TenantStats = { reps: number; leads: number; sold: number; territories: number };
type Tenant = {
  id: number; slug: string; companyName: string; ownerName: string; ownerEmail: string;
  ownerPhone?: string; brandName: string; brandColor: string; tagline?: string;
  plan: string; monthlyFee: number; revenueSharePct: number; status: string;
  maxReps: number; allowedMarkets?: string; notes?: string; trialEndsAt?: string;
  createdAt: string; stats: TenantStats;
};
type Revenue = {
  summary: Array<{ tenantId: number; slug: string; brandName: string; plan: string; monthlyFee: number; yourCut: number } & TenantStats>;
  totalMrr: number; yourMrr: number; tenantCount: number;
};

const PLAN_COLORS: Record<string, string> = {
  trial: "bg-amber-500/15 text-amber-400",
  starter: "bg-blue-500/15 text-blue-400",
  pro: "bg-primary/15 text-primary",
  enterprise: "bg-purple-500/15 text-purple-400",
};

const PLAN_PRICES: Record<string, number> = {
  trial: 0, starter: 99, pro: 249, enterprise: 499,
};

// ── Tenant Form ───────────────────────────────────────────────────────────────
function TenantForm({ initial, onSave, onCancel, saving }: {
  initial?: Partial<Tenant>;
  onSave: (data: any) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState({
    slug: initial?.slug ?? "",
    companyName: initial?.companyName ?? "",
    ownerName: initial?.ownerName ?? "",
    ownerEmail: initial?.ownerEmail ?? "",
    ownerPhone: initial?.ownerPhone ?? "",
    brandName: initial?.brandName ?? "",
    brandColor: initial?.brandColor ?? "#3EA394",
    tagline: initial?.tagline ?? "Field Sales Intelligence",
    plan: initial?.plan ?? "trial",
    monthlyFee: initial?.monthlyFee ?? 0,
    revenueSharePct: initial?.revenueSharePct ?? 0.20,
    maxReps: initial?.maxReps ?? 10,
    notes: initial?.notes ?? "",
    trialEndsAt: initial?.trialEndsAt ?? "",
    allowedMarkets: initial?.allowedMarkets ?? "",
  });
  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs text-muted-foreground">Company Name *</Label>
          <Input value={form.companyName} onChange={e => {
            set("companyName", e.target.value);
            if (!initial) set("slug", e.target.value.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-"));
          }} placeholder="Acme Fiber LLC" className="bg-secondary border-input text-sm mt-1" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">URL Slug *</Label>
          <Input value={form.slug} onChange={e => set("slug", e.target.value)} placeholder="acme-fiber"
            className="bg-secondary border-input text-sm mt-1 font-mono" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs text-muted-foreground">Owner Name *</Label>
          <Input value={form.ownerName} onChange={e => set("ownerName", e.target.value)}
            placeholder="John Smith" className="bg-secondary border-input text-sm mt-1" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Owner Email *</Label>
          <Input type="email" value={form.ownerEmail} onChange={e => set("ownerEmail", e.target.value)}
            placeholder="john@acme.com" className="bg-secondary border-input text-sm mt-1" />
        </div>
      </div>

      <Separator className="bg-border/50" />
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">White-Label Branding</p>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs text-muted-foreground">Brand Name (shown in app)</Label>
          <Input value={form.brandName} onChange={e => set("brandName", e.target.value)}
            placeholder="Acme Fiber" className="bg-secondary border-input text-sm mt-1" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Tagline</Label>
          <Input value={form.tagline} onChange={e => set("tagline", e.target.value)}
            placeholder="Field Sales Intelligence" className="bg-secondary border-input text-sm mt-1" />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex-1">
          <Label className="text-xs text-muted-foreground">Brand Color</Label>
          <div className="flex gap-2 mt-1">
            <input type="color" value={form.brandColor} onChange={e => set("brandColor", e.target.value)}
              className="w-9 h-9 rounded border border-input bg-secondary cursor-pointer" />
            <Input value={form.brandColor} onChange={e => set("brandColor", e.target.value)}
              className="bg-secondary border-input text-sm font-mono flex-1" />
          </div>
        </div>
        <div style={{ width: 80 }}>
          <Label className="text-xs text-muted-foreground">Max Reps</Label>
          <Input type="number" value={form.maxReps} onChange={e => set("maxReps", Number(e.target.value))}
            className="bg-secondary border-input text-sm mt-1" min={1} />
        </div>
      </div>

      <Separator className="bg-border/50" />
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Billing</p>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label className="text-xs text-muted-foreground">Plan</Label>
          <Select value={form.plan} onValueChange={v => {
            set("plan", v);
            set("monthlyFee", PLAN_PRICES[v] || 0);
          }}>
            <SelectTrigger className="bg-secondary border-input text-sm mt-1 h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value="trial">Trial (Free)</SelectItem>
              <SelectItem value="starter">Starter ($99/mo)</SelectItem>
              <SelectItem value="pro">Pro ($249/mo)</SelectItem>
              <SelectItem value="enterprise">Enterprise ($499/mo)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Monthly Fee ($)</Label>
          <Input type="number" value={form.monthlyFee} onChange={e => set("monthlyFee", Number(e.target.value))}
            className="bg-secondary border-input text-sm mt-1" min={0} />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Your Cut (%)</Label>
          <Input type="number" value={Math.round(form.revenueSharePct * 100)}
            onChange={e => set("revenueSharePct", Number(e.target.value) / 100)}
            className="bg-secondary border-input text-sm mt-1" min={0} max={100} />
        </div>
      </div>

      <div>
        <Label className="text-xs text-muted-foreground">Notes</Label>
        <Textarea value={form.notes} onChange={e => set("notes", e.target.value)}
          placeholder="Internal notes about this client..." rows={2}
          className="bg-secondary border-input text-sm mt-1 resize-none" />
      </div>

      <div className="flex gap-2 pt-2">
        <Button variant="outline" onClick={onCancel} className="border-border flex-1">Cancel</Button>
        <Button onClick={() => onSave(form)} disabled={saving || !form.companyName || !form.ownerEmail || !form.brandName}
          className="bg-primary hover:bg-primary/90 text-white flex-1">
          {saving ? "Saving..." : initial ? "Save Changes" : "Create Tenant"}
        </Button>
      </div>
    </div>
  );
}

// ── Tenant Card ───────────────────────────────────────────────────────────────
function TenantCard({ tenant, onEdit, onDelete }: {
  tenant: Tenant; onEdit: () => void; onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();
  const yourCut = (tenant.monthlyFee || 0) * (tenant.revenueSharePct || 0.2);

  return (
    <Card className="bg-card border-border hover:border-primary/20 transition-colors" data-testid={`card-tenant-${tenant.id}`}>
      <CardContent className="py-4 px-5">
        <div className="flex items-start gap-3">
          {/* Brand color dot */}
          <div className="w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center mt-0.5"
            style={{ background: tenant.brandColor + "22", border: `1px solid ${tenant.brandColor}44` }}>
            <Building2 className="w-5 h-5" style={{ color: tenant.brandColor }} />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm text-foreground">{tenant.brandName}</span>
              <span className="text-xs text-muted-foreground">· {tenant.companyName}</span>
              <Badge className={`text-xs px-2 py-0 rounded-full border-0 ${PLAN_COLORS[tenant.plan] ?? "bg-secondary text-muted-foreground"}`}>
                {tenant.plan}
              </Badge>
              {tenant.status !== "active" && (
                <Badge className="text-xs px-2 py-0 rounded-full border-0 bg-red-500/15 text-red-400">{tenant.status}</Badge>
              )}
            </div>

            <div className="flex items-center gap-4 mt-1.5 flex-wrap">
              <span className="text-xs text-muted-foreground">{tenant.ownerName} · {tenant.ownerEmail}</span>
              <span className="text-xs text-primary font-mono">/{tenant.slug}</span>
            </div>

            {/* Stats row */}
            <div className="flex items-center gap-4 mt-2">
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Users className="w-3 h-3" /> {tenant.stats.reps} reps
              </span>
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Zap className="w-3 h-3" /> {tenant.stats.leads} leads
              </span>
              <span className="text-xs text-green-400 flex items-center gap-1">
                <CheckCircle className="w-3 h-3" /> {tenant.stats.sold} sold
              </span>
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Globe className="w-3 h-3" /> {tenant.stats.territories} territories
              </span>
            </div>
          </div>

          {/* Revenue */}
          <div className="text-right flex-shrink-0">
            <div className="text-sm font-bold text-foreground">${(tenant.monthlyFee || 0).toFixed(0)}<span className="text-xs font-normal text-muted-foreground">/mo</span></div>
            <div className="text-xs text-primary font-medium">Your cut: ${yourCut.toFixed(0)}</div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-1 flex-shrink-0 ml-2">
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
              onClick={() => setExpanded(v => !v)}>
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </Button>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-primary"
              onClick={onEdit} data-testid={`btn-edit-tenant-${tenant.id}`}>
              <Edit2 className="w-3.5 h-3.5" />
            </Button>
            <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground hover:text-red-400"
              onClick={onDelete} data-testid={`btn-delete-tenant-${tenant.id}`}>
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        {/* Expanded detail */}
        {expanded && (
          <div className="mt-4 pt-4 border-t border-border/50 space-y-3">
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <div className="text-muted-foreground mb-0.5">Revenue Share</div>
                <div className="text-foreground">{Math.round((tenant.revenueSharePct || 0.2) * 100)}%</div>
              </div>
              <div>
                <div className="text-muted-foreground mb-0.5">Max Reps</div>
                <div className="text-foreground">{tenant.maxReps}</div>
              </div>
              <div>
                <div className="text-muted-foreground mb-0.5">Trial Ends</div>
                <div className="text-foreground">{tenant.trialEndsAt || "—"}</div>
              </div>
              <div>
                <div className="text-muted-foreground mb-0.5">Created</div>
                <div className="text-foreground">{new Date(tenant.createdAt).toLocaleDateString()}</div>
              </div>
            </div>
            {tenant.notes && (
              <div className="text-xs text-muted-foreground bg-secondary/50 rounded-lg p-2">{tenant.notes}</div>
            )}
            <div className="flex gap-2">
              <button onClick={() => { navigator.clipboard.writeText(tenant.slug); toast({ title: "Slug copied" }); }}
                className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1">
                <Copy className="w-3 h-3" /> Copy slug
              </button>
              <button onClick={() => { navigator.clipboard.writeText(tenant.ownerEmail); toast({ title: "Email copied" }); }}
                className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 ml-3">
                <Copy className="w-3 h-3" /> Copy email
              </button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function SuperAdmin() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [editTenant, setEditTenant] = useState<Tenant | null>(null);
  const [deleteTenant, setDeleteTenant] = useState<Tenant | null>(null);

  // Only muizzm21@gmail.com can see this
  if (user?.role !== "admin" || user?.email !== "muizzm21@gmail.com") {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="text-center">
          <Shield className="w-10 h-10 mx-auto mb-3 text-red-400" />
          <p className="text-sm text-muted-foreground">Super-admin access only.</p>
        </div>
      </div>
    );
  }

  const { data: tenants = [], isLoading } = useQuery<Tenant[]>({ queryKey: ["/api/sa/tenants"] });
  const { data: revenue } = useQuery<Revenue>({ queryKey: ["/api/sa/revenue"] });

  const createMutation = useMutation({
    mutationFn: async (data: any) => { const r = await apiRequest("POST", "/api/sa/tenants", data); return r.json(); },
    onSuccess: () => { toast({ title: "Tenant created" }); qc.invalidateQueries({ queryKey: ["/api/sa/tenants"] }); qc.invalidateQueries({ queryKey: ["/api/sa/revenue"] }); setAddOpen(false); },
    onError: (e: any) => toast({ title: e.message || "Error", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: any }) => { const r = await apiRequest("PATCH", `/api/sa/tenants/${id}`, data); return r.json(); },
    onSuccess: () => { toast({ title: "Updated" }); qc.invalidateQueries({ queryKey: ["/api/sa/tenants"] }); qc.invalidateQueries({ queryKey: ["/api/sa/revenue"] }); setEditTenant(null); },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => { await apiRequest("DELETE", `/api/sa/tenants/${id}`); },
    onSuccess: () => { toast({ title: "Tenant cancelled" }); qc.invalidateQueries({ queryKey: ["/api/sa/tenants"] }); setDeleteTenant(null); },
  });

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-bold">SaaS Control Center</h1>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">Your proprietary platform · white-label to any Kinetic market</p>
        </div>
        <Button onClick={() => setAddOpen(true)} className="bg-primary hover:bg-primary/90 text-white text-sm"
          data-testid="btn-add-tenant">
          <Plus className="w-4 h-4 mr-1" /> Add Tenant
        </Button>
      </div>

      {/* Revenue KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Active Tenants", value: revenue?.tenantCount ?? 0, icon: Building2, color: "text-primary" },
          { label: "Total MRR", value: `$${(revenue?.totalMrr ?? 0).toFixed(0)}`, icon: TrendingUp, color: "text-green-400" },
          { label: "Your MRR Cut", value: `$${(revenue?.yourMrr ?? 0).toFixed(0)}`, icon: DollarSign, color: "text-amber-400" },
          { label: "Total Leads", value: tenants.reduce((s, t) => s + (t.stats?.leads ?? 0), 0), icon: BarChart2, color: "text-blue-400" },
        ].map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="bg-card border-border">
            <CardContent className="py-4 px-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs text-muted-foreground">{label}</span>
                <Icon className={`w-4 h-4 ${color}`} />
              </div>
              <div className="text-xl font-bold text-foreground">{value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Plan breakdown */}
      {revenue && revenue.summary.length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-2 pt-4 px-5">
            <CardTitle className="text-sm font-semibold text-foreground flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-primary" /> Revenue by Tenant
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-4">
            <div className="space-y-2">
              {revenue.summary.map(t => (
                <div key={t.tenantId} className="flex items-center gap-3 text-xs">
                  <span className="flex-1 text-foreground font-medium">{t.brandName}</span>
                  <Badge className={`text-xs px-2 py-0 rounded-full border-0 ${PLAN_COLORS[t.plan] ?? ""}`}>{t.plan}</Badge>
                  <span className="text-muted-foreground">${t.monthlyFee}/mo</span>
                  <span className="text-primary font-medium">→ ${t.yourCut.toFixed(0)} yours</span>
                  <span className="text-muted-foreground">{t.leads} leads · {t.sold} sold</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tenant list */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Tenants</h2>
        {isLoading ? (
          <div className="text-center py-12 text-muted-foreground text-sm">Loading...</div>
        ) : tenants.length === 0 ? (
          <Card className="bg-card border-border">
            <CardContent className="py-12 text-center">
              <Building2 className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-30" />
              <p className="text-sm text-muted-foreground">No tenants yet — add your first white-label client.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {tenants.map(t => (
              <TenantCard key={t.id} tenant={t}
                onEdit={() => setEditTenant(t)}
                onDelete={() => setDeleteTenant(t)} />
            ))}
          </div>
        )}
      </div>

      {/* Add Dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="bg-card border-border text-foreground max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <Plus className="w-4 h-4 text-primary" /> New Tenant
            </DialogTitle>
          </DialogHeader>
          <TenantForm onSave={data => createMutation.mutate(data)} onCancel={() => setAddOpen(false)} saving={createMutation.isPending} />
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editTenant} onOpenChange={v => !v && setEditTenant(null)}>
        <DialogContent className="bg-card border-border text-foreground max-w-xl">
          <DialogHeader><DialogTitle className="text-base">Edit Tenant</DialogTitle></DialogHeader>
          {editTenant && (
            <TenantForm initial={editTenant}
              onSave={data => updateMutation.mutate({ id: editTenant.id, data })}
              onCancel={() => setEditTenant(null)} saving={updateMutation.isPending} />
          )}
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <Dialog open={!!deleteTenant} onOpenChange={v => !v && setDeleteTenant(null)}>
        <DialogContent className="bg-card border-border text-foreground max-w-sm">
          <DialogHeader><DialogTitle className="text-base">Cancel Tenant?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will mark <strong>{deleteTenant?.brandName}</strong> as cancelled. Their data is preserved.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTenant(null)} className="border-border">Keep Active</Button>
            <Button onClick={() => deleteTenant && deleteMutation.mutate(deleteTenant.id)}
              disabled={deleteMutation.isPending}
              className="bg-destructive hover:bg-destructive/90 text-white">
              Cancel Tenant
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
