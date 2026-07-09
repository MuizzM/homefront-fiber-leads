import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { useCan } from "@/lib/capabilities";
import { DollarSign, TrendingUp, Clock, CheckCircle, Plus, Filter, Download, User } from "lucide-react";
import { useState } from "react";

interface Commission {
  id: number; repId: number; leadId: number | null; knockId: number | null;
  amount: number; status: string; saleDate: string; paidDate: string | null;
  notes: string | null; approvedBy: number | null; createdAt: string;
  // Server-enriched for the mobile entry line ("sold date · rep · address, city")
  repName: string | null; address: string | null; city: string | null;
  calcType?: string | null; structureVersion?: number | null; // locked-plan provenance
}
interface CommissionSummary {
  repId: number; repName: string; total: number; paid: number; pending: number; sales: number;
}
interface TeamMember { id: number; name: string; role: string; active: boolean; }
interface CommissionRate { id: number; name: string; role: string | null; repId: number | null; ratePerSale: number; isActive: boolean; }

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  approved: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  paid: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30",
  disputed: "bg-red-500/20 text-red-400 border-red-500/30",
};

export default function Commissions() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isManager = user?.role === "admin" || user?.role === "manager";
  const canManageStructures = useCan("commission.structure.manage"); // team_lead+ (UI parity with server)
  const [statusFilter, setStatusFilter] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [rateOpen, setRateOpen] = useState(false);
  const [form, setForm] = useState({ repId: "", amount: "", saleDate: new Date().toISOString().slice(0, 10), notes: "" });
  // target: "role:<role>" for a whole role, or "rep:<id>" for one specific rep.
  const [rateForm, setRateForm] = useState({ name: "", target: "role:rep", ratePerSale: "" });

  const { data: commissions = [], isLoading } = useQuery<Commission[]>({
    queryKey: ["/api/commissions"],
    queryFn: () => apiRequest("GET", "/api/commissions").then(r => r.json()),
    refetchInterval: 30000,
  });

  const { data: summary = [] } = useQuery<CommissionSummary[]>({
    queryKey: ["/api/commissions/summary"],
    queryFn: () => apiRequest("GET", "/api/commissions/summary").then(r => r.json()),
    enabled: isManager,
  });

  const { data: members = [] } = useQuery<TeamMember[]>({
    queryKey: ["/api/team-members"],
    queryFn: () => apiRequest("GET", "/api/team-members").then(r => r.json()),
    enabled: isManager,
  });

  const { data: rates = [] } = useQuery<CommissionRate[]>({
    queryKey: ["/api/commission-rates"],
    queryFn: () => apiRequest("GET", "/api/commission-rates").then(r => r.json()),
    enabled: canManageStructures, // reps/others 403 here — don't fire it (or retry it)
  });

  const addMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/commissions", data).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/commissions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/commissions/summary"] });
      toast({ title: "Commission logged" });
      setAddOpen(false);
      setForm({ repId: "", amount: "", saleDate: new Date().toISOString().slice(0, 10), notes: "" });
    },
    onError: () => toast({ title: "Error", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      apiRequest("PATCH", `/api/commissions/${id}`, { status, paidDate: status === "paid" ? new Date().toISOString().slice(0, 10) : undefined }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/commissions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/commissions/summary"] });
      toast({ title: "Commission updated" });
    },
    onError: (e: any) => toast({ title: e?.message ?? "Couldn't update commission", variant: "destructive" }),
  });

  const addRateMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/commission-rates", data).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/commission-rates"] });
      toast({ title: "Commission updated" });
      setRateForm({ name: "", target: "role:rep", ratePerSale: "" });
      setRateOpen(false);
    },
    onError: (e: any) => toast({ title: e?.message ?? "Couldn't save the rate", variant: "destructive" }),
  });

  // Resolve a rate's target for display: a specific rep's name, or a whole role.
  const memberName = (id: number) => members.find(m => m.id === id)?.name ?? `Rep #${id}`;
  const rateTargetLabel = (r: CommissionRate) =>
    r.repId ? memberName(r.repId) : r.role ? `All ${r.role.replace(/_/g, " ")}s` : "Custom";
  // Split the "role:x" / "rep:id" target into the API payload the server expects.
  const rateTargetPayload = (t: string) =>
    t.startsWith("rep:") ? { repId: Number(t.slice(4)), role: null } : { role: t.slice(5), repId: null };
  const saveRate = () => {
    const t = rateTargetPayload(rateForm.target);
    const name = rateForm.name.trim() || (t.repId ? memberName(t.repId) : `All ${t.role}s`);
    addRateMutation.mutate({ name, ...t, ratePerSale: Number(rateForm.ratePerSale), calcType: "flat", isActive: true });
  };

  // Newest sale first — createdAt desc breaks same-day ties (id desc equivalent).
  const ordered = [...commissions].sort((a, b) =>
    b.saleDate < a.saleDate ? -1 : b.saleDate > a.saleDate ? 1 : b.id - a.id);
  const filtered = statusFilter === "all" ? ordered : ordered.filter(c => c.status === statusFilter);

  const runningTotal = commissions.reduce((s, c) => s + c.amount, 0);
  const totalPending = commissions.filter(c => c.status === "pending").reduce((s, c) => s + c.amount, 0);
  const totalApproved = commissions.filter(c => c.status === "approved").reduce((s, c) => s + c.amount, 0);
  const totalPaid = commissions.filter(c => c.status === "paid").reduce((s, c) => s + c.amount, 0);

  function exportCsv() {
    const rows = [["ID","Rep ID","Amount","Status","Sale Date","Paid Date","Notes"]];
    filtered.forEach(c => rows.push([String(c.id), String(c.repId), String(c.amount), c.status, c.saleDate, c.paidDate ?? "", c.notes ?? ""]));
    const csv = rows.map(r => r.join(",")).join("\n");
    const a = document.createElement("a"); a.href = "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
    a.download = "commissions.csv"; a.click();
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Commissions</h1>
          <p className="text-sm text-muted-foreground" data-testid="commission-running-total">
            {commissions.length} sale{commissions.length === 1 ? "" : "s"} · <span className="text-primary font-semibold">${runningTotal.toFixed(0)}</span> total
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={exportCsv} className="border-border text-muted-foreground hover:bg-card" data-testid="button-export-csv">
            <Download className="w-4 h-4 mr-2" /> Export CSV
          </Button>
          {canManageStructures && (
            <Dialog open={rateOpen} onOpenChange={setRateOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="border-border text-muted-foreground hover:bg-card" data-testid="button-add-rate">
                  Rate Plans
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-card border-border text-white">
                <DialogHeader><DialogTitle>Commission Rate Plans</DialogTitle></DialogHeader>
                <p className="text-xs text-muted-foreground -mt-1">
                  Set a rate for a whole role, or override it for one rep. A rep-specific
                  rate always wins over their role rate — use it to change one rep’s pay.
                </p>
                <div className="space-y-3">
                  {rates.length === 0 && (
                    <p className="text-sm text-muted-foreground py-2">No rate plans yet — add one below.</p>
                  )}
                  {rates.map(r => (
                    <div key={r.id} className="flex items-center justify-between p-3 bg-secondary rounded-lg">
                      <div className="min-w-0">
                        <p className="text-sm text-foreground font-medium truncate">{r.name}</p>
                        <p className="text-xs text-muted-foreground flex items-center gap-1">
                          {r.repId
                            ? <span className="inline-flex items-center gap-1 text-primary"><User className="w-3 h-3" />{rateTargetLabel(r)}</span>
                            : rateTargetLabel(r)}
                        </p>
                      </div>
                      <Badge className="bg-primary/20 text-primary border-primary/30 flex-shrink-0">${r.ratePerSale}/sale</Badge>
                    </div>
                  ))}
                  <div className="pt-3 border-t border-border space-y-2">
                    <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Add / change a rate</p>
                    <Input placeholder="Plan name (e.g. “Zargham — 2026”)" value={rateForm.name} onChange={e => setRateForm(f => ({...f, name: e.target.value}))} className="bg-secondary border-border text-foreground" data-testid="input-rate-name" />
                    <label className="block text-[11px] text-muted-foreground">Applies to</label>
                    <Select value={rateForm.target} onValueChange={v => setRateForm(f => ({...f, target: v}))}>
                      <SelectTrigger className="bg-secondary border-border text-foreground" data-testid="select-rate-target"><SelectValue /></SelectTrigger>
                      <SelectContent className="bg-card border-border">
                        <SelectItem value="role:rep">All Reps</SelectItem>
                        <SelectItem value="role:team_lead">All Team Leads</SelectItem>
                        <SelectItem value="role:manager">All Managers</SelectItem>
                        {members.filter(m => m.active && m.role === "rep").map(m => (
                          <SelectItem key={m.id} value={`rep:${m.id}`}>Just {m.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input placeholder="$ per sale" type="number" inputMode="decimal" value={rateForm.ratePerSale} onChange={e => setRateForm(f => ({...f, ratePerSale: e.target.value}))} className="bg-secondary border-border text-foreground" data-testid="input-rate-amount" />
                    <Button
                      onClick={saveRate}
                      className="w-full bg-primary hover:bg-primary/90 text-white" disabled={addRateMutation.isPending || !(Number(rateForm.ratePerSale) > 0)} data-testid="button-save-rate">
                      {addRateMutation.isPending ? "Saving…" : "Save rate"}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          )}
          {isManager && (
            <Dialog open={addOpen} onOpenChange={setAddOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="bg-primary hover:bg-primary/90 text-white" data-testid="button-add-commission">
                  <Plus className="w-4 h-4 mr-2" /> Log Sale
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-card border-border text-white">
                <DialogHeader><DialogTitle>Log Commission</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <Select value={form.repId} onValueChange={v => setForm(f => ({...f, repId: v}))}>
                    <SelectTrigger className="bg-secondary border-border text-white" data-testid="select-rep"><SelectValue placeholder="Select Rep" /></SelectTrigger>
                    <SelectContent className="bg-card border-border">
                      {members.filter(m => m.active).map(m => <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input type="number" placeholder="Amount ($)" value={form.amount} onChange={e => setForm(f => ({...f, amount: e.target.value}))} className="bg-secondary border-border text-white" data-testid="input-amount" />
                  <Input type="date" value={form.saleDate} onChange={e => setForm(f => ({...f, saleDate: e.target.value}))} className="bg-secondary border-border text-white" data-testid="input-sale-date" />
                  <Input placeholder="Notes (optional)" value={form.notes} onChange={e => setForm(f => ({...f, notes: e.target.value}))} className="bg-secondary border-border text-white" data-testid="input-notes" />
                  {rates.length > 0 && (
                    <p className="text-xs text-muted-foreground">Rate plans: {rates.map(r => `${r.name}: $${r.ratePerSale}`).join(", ")}</p>
                  )}
                  <Button onClick={() => addMutation.mutate({ repId: Number(form.repId), amount: Number(form.amount), saleDate: form.saleDate, notes: form.notes || null })} disabled={addMutation.isPending || !form.repId || !form.amount} className="w-full bg-primary hover:bg-primary/90 text-white" data-testid="button-submit-commission">
                    Log Commission
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      {/* Summary Cards — 3-up everywhere, but the icon stacks over the value on
          the narrowest phones so nothing overflows at 320px. */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <Card className="bg-card border-border">
          <CardContent className="p-3 sm:p-4 flex flex-col sm:flex-row items-start sm:items-center gap-1.5 sm:gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-600/20 flex items-center justify-center">
              <Clock className="w-4 h-4 text-amber-400" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Pending</p>
              <p className="text-lg font-bold text-white" data-testid="stat-pending">${totalPending.toFixed(0)}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-3 sm:p-4 flex flex-col sm:flex-row items-start sm:items-center gap-1.5 sm:gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-600/20 flex items-center justify-center">
              <CheckCircle className="w-4 h-4 text-blue-400" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Approved</p>
              <p className="text-lg font-bold text-white" data-testid="stat-approved">${totalApproved.toFixed(0)}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-3 sm:p-4 flex flex-col sm:flex-row items-start sm:items-center gap-1.5 sm:gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-600/20 flex items-center justify-center">
              <DollarSign className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total Paid</p>
              <p className="text-lg font-bold text-white" data-testid="stat-paid">${totalPaid.toFixed(0)}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Per-rep summary (manager only) */}
      {isManager && summary.filter(s => s.sales > 0).length > 0 && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" /> Rep Earnings Summary
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {summary.filter(s => s.sales > 0).sort((a, b) => b.total - a.total).map(s => (
                <div key={s.repId} className="px-4 py-3 flex items-center justify-between" data-testid={`summary-rep-${s.repId}`}>
                  <div>
                    <p className="text-sm text-white font-medium">{s.repName}</p>
                    <p className="text-xs text-muted-foreground">{s.sales} sales · ${s.paid.toFixed(0)} paid</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-primary">${s.total.toFixed(0)}</p>
                    {s.pending > 0 && <p className="text-xs text-amber-400">${s.pending.toFixed(0)} pending</p>}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Commission Table */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-primary" /> Commission Records
            </CardTitle>
            <div className="flex items-center gap-2">
              <Filter className="w-3 h-3 text-muted-foreground" />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-7 w-28 bg-secondary border-border text-muted-foreground text-xs" data-testid="select-filter"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="approved">Approved</SelectItem>
                  <SelectItem value="paid">Paid</SelectItem>
                  <SelectItem value="disputed">Disputed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-12 bg-secondary" />)}</div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground p-4">No commissions yet</p>
          ) : (
            <div className="divide-y divide-border">
              {filtered.map(c => (
                <div key={c.id} className="px-4 py-3 flex items-center justify-between gap-3" data-testid={`commission-row-${c.id}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-[15px] text-white font-semibold tabular-nums">${c.amount.toFixed(2)}</p>
                      <Badge className={`text-xs capitalize ${STATUS_COLORS[c.status] ?? "bg-secondary text-muted-foreground"}`}>{c.status}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {new Date(c.saleDate + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      {" · "}{c.repName ?? `Rep #${c.repId}`}
                    </p>
                    {c.address && (
                      <p className="text-[11px] text-muted-foreground/70 truncate">{c.address}{c.city ? `, ${c.city}` : ""}</p>
                    )}
                  </div>
                  {isManager && c.status === "pending" && (
                    <Button size="sm" variant="outline" disabled={updateMutation.isPending} className="border-blue-500/30 text-blue-400 hover:bg-blue-500/10 text-xs h-7 disabled:opacity-50" onClick={() => updateMutation.mutate({ id: c.id, status: "approved" })} data-testid={`button-approve-${c.id}`}>
                      Approve
                    </Button>
                  )}
                  {isManager && c.status === "approved" && (
                    <Button size="sm" disabled={updateMutation.isPending} className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs h-7 disabled:opacity-50" onClick={() => updateMutation.mutate({ id: c.id, status: "paid" })} data-testid={`button-mark-paid-${c.id}`}>
                      Mark Paid
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
