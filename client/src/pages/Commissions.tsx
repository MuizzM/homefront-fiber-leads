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
import { DollarSign, TrendingUp, Clock, CheckCircle, Plus, Filter, Download } from "lucide-react";
import { useState } from "react";

interface Commission {
  id: number; repId: number; leadId: number | null; knockId: number | null;
  amount: number; status: string; saleDate: string; paidDate: string | null;
  notes: string | null; approvedBy: number | null; createdAt: string;
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
  const [statusFilter, setStatusFilter] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [rateOpen, setRateOpen] = useState(false);
  const [form, setForm] = useState({ repId: "", amount: "", saleDate: new Date().toISOString().slice(0, 10), notes: "" });
  const [rateForm, setRateForm] = useState({ name: "", role: "rep", ratePerSale: "" });

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
  });

  const addRateMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/commission-rates", data).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/commission-rates"] });
      toast({ title: "Rate plan saved" });
      setRateOpen(false);
    },
  });

  const filtered = statusFilter === "all" ? commissions : commissions.filter(c => c.status === statusFilter);

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
          <p className="text-sm text-[#7a9ab5]">Rep earnings and payout management</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={exportCsv} className="border-[#1a3a52] text-[#7a9ab5] hover:bg-[#0a1e30]" data-testid="button-export-csv">
            <Download className="w-4 h-4 mr-2" /> Export CSV
          </Button>
          {user?.role === "admin" && (
            <Dialog open={rateOpen} onOpenChange={setRateOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="border-[#1a3a52] text-[#7a9ab5] hover:bg-[#0a1e30]" data-testid="button-add-rate">
                  Rate Plans
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-[#0a1e30] border-[#1a3a52] text-white">
                <DialogHeader><DialogTitle>Commission Rate Plans</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  {rates.map(r => (
                    <div key={r.id} className="flex items-center justify-between p-3 bg-[#0F2A44] rounded-lg">
                      <div>
                        <p className="text-sm text-white font-medium">{r.name}</p>
                        <p className="text-xs text-[#7a9ab5]">{r.role ?? "Custom"}</p>
                      </div>
                      <Badge className="bg-[#3EA394]/20 text-[#3EA394] border-[#3EA394]/30">${r.ratePerSale}/sale</Badge>
                    </div>
                  ))}
                  <div className="pt-3 border-t border-[#1a3a52] space-y-2">
                    <p className="text-xs text-[#7a9ab5] font-medium uppercase tracking-wider">Add Rate Plan</p>
                    <Input placeholder="Name" value={rateForm.name} onChange={e => setRateForm(f => ({...f, name: e.target.value}))} className="bg-[#0F2A44] border-[#1a3a52] text-white" data-testid="input-rate-name" />
                    <Select value={rateForm.role} onValueChange={v => setRateForm(f => ({...f, role: v}))}>
                      <SelectTrigger className="bg-[#0F2A44] border-[#1a3a52] text-white"><SelectValue /></SelectTrigger>
                      <SelectContent className="bg-[#0a1e30] border-[#1a3a52]">
                        <SelectItem value="rep">Rep</SelectItem>
                        <SelectItem value="team_lead">Team Lead</SelectItem>
                        <SelectItem value="manager">Manager</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input placeholder="$ per sale" type="number" value={rateForm.ratePerSale} onChange={e => setRateForm(f => ({...f, ratePerSale: e.target.value}))} className="bg-[#0F2A44] border-[#1a3a52] text-white" data-testid="input-rate-amount" />
                    <Button onClick={() => addRateMutation.mutate({ name: rateForm.name, role: rateForm.role, ratePerSale: Number(rateForm.ratePerSale), isActive: true })} className="w-full bg-[#3EA394] hover:bg-[#35897d] text-white" disabled={addRateMutation.isPending} data-testid="button-save-rate">
                      Save Rate Plan
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          )}
          {isManager && (
            <Dialog open={addOpen} onOpenChange={setAddOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="bg-[#3EA394] hover:bg-[#35897d] text-white" data-testid="button-add-commission">
                  <Plus className="w-4 h-4 mr-2" /> Log Sale
                </Button>
              </DialogTrigger>
              <DialogContent className="bg-[#0a1e30] border-[#1a3a52] text-white">
                <DialogHeader><DialogTitle>Log Commission</DialogTitle></DialogHeader>
                <div className="space-y-3">
                  <Select value={form.repId} onValueChange={v => setForm(f => ({...f, repId: v}))}>
                    <SelectTrigger className="bg-[#0F2A44] border-[#1a3a52] text-white" data-testid="select-rep"><SelectValue placeholder="Select Rep" /></SelectTrigger>
                    <SelectContent className="bg-[#0a1e30] border-[#1a3a52]">
                      {members.filter(m => m.active).map(m => <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input type="number" placeholder="Amount ($)" value={form.amount} onChange={e => setForm(f => ({...f, amount: e.target.value}))} className="bg-[#0F2A44] border-[#1a3a52] text-white" data-testid="input-amount" />
                  <Input type="date" value={form.saleDate} onChange={e => setForm(f => ({...f, saleDate: e.target.value}))} className="bg-[#0F2A44] border-[#1a3a52] text-white" data-testid="input-sale-date" />
                  <Input placeholder="Notes (optional)" value={form.notes} onChange={e => setForm(f => ({...f, notes: e.target.value}))} className="bg-[#0F2A44] border-[#1a3a52] text-white" data-testid="input-notes" />
                  {rates.length > 0 && (
                    <p className="text-xs text-[#7a9ab5]">Rate plans: {rates.map(r => `${r.name}: $${r.ratePerSale}`).join(", ")}</p>
                  )}
                  <Button onClick={() => addMutation.mutate({ repId: Number(form.repId), amount: Number(form.amount), saleDate: form.saleDate, notes: form.notes || null })} disabled={addMutation.isPending || !form.repId || !form.amount} className="w-full bg-[#3EA394] hover:bg-[#35897d] text-white" data-testid="button-submit-commission">
                    Log Commission
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="bg-[#0a1e30] border-[#1a3a52]">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-amber-600/20 flex items-center justify-center">
              <Clock className="w-4 h-4 text-amber-400" />
            </div>
            <div>
              <p className="text-xs text-[#7a9ab5]">Pending</p>
              <p className="text-lg font-bold text-white" data-testid="stat-pending">${totalPending.toFixed(0)}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-[#0a1e30] border-[#1a3a52]">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-600/20 flex items-center justify-center">
              <CheckCircle className="w-4 h-4 text-blue-400" />
            </div>
            <div>
              <p className="text-xs text-[#7a9ab5]">Approved</p>
              <p className="text-lg font-bold text-white" data-testid="stat-approved">${totalApproved.toFixed(0)}</p>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-[#0a1e30] border-[#1a3a52]">
          <CardContent className="p-4 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-600/20 flex items-center justify-center">
              <DollarSign className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <p className="text-xs text-[#7a9ab5]">Total Paid</p>
              <p className="text-lg font-bold text-white" data-testid="stat-paid">${totalPaid.toFixed(0)}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Per-rep summary (manager only) */}
      {isManager && summary.filter(s => s.sales > 0).length > 0 && (
        <Card className="bg-[#0a1e30] border-[#1a3a52]">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-[#3EA394]" /> Rep Earnings Summary
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-[#1a3a52]">
              {summary.filter(s => s.sales > 0).sort((a, b) => b.total - a.total).map(s => (
                <div key={s.repId} className="px-4 py-3 flex items-center justify-between" data-testid={`summary-rep-${s.repId}`}>
                  <div>
                    <p className="text-sm text-white font-medium">{s.repName}</p>
                    <p className="text-xs text-[#7a9ab5]">{s.sales} sales · ${s.paid.toFixed(0)} paid</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold text-[#3EA394]">${s.total.toFixed(0)}</p>
                    {s.pending > 0 && <p className="text-xs text-amber-400">${s.pending.toFixed(0)} pending</p>}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Commission Table */}
      <Card className="bg-[#0a1e30] border-[#1a3a52]">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-[#3EA394]" /> Commission Records
            </CardTitle>
            <div className="flex items-center gap-2">
              <Filter className="w-3 h-3 text-[#7a9ab5]" />
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-7 w-28 bg-[#0F2A44] border-[#1a3a52] text-[#7a9ab5] text-xs" data-testid="select-filter"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-[#0a1e30] border-[#1a3a52]">
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
            <div className="p-4 space-y-2">{[1,2,3].map(i => <Skeleton key={i} className="h-12 bg-[#1a3a52]" />)}</div>
          ) : filtered.length === 0 ? (
            <p className="text-sm text-[#7a9ab5] p-4">No commissions yet</p>
          ) : (
            <div className="divide-y divide-[#1a3a52]">
              {filtered.map(c => (
                <div key={c.id} className="px-4 py-3 flex items-center justify-between gap-3" data-testid={`commission-row-${c.id}`}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm text-white font-medium">${c.amount.toFixed(2)}</p>
                      <Badge className={`text-xs ${STATUS_COLORS[c.status] ?? "bg-[#1a3a52] text-[#7a9ab5]"}`}>{c.status}</Badge>
                    </div>
                    <p className="text-xs text-[#7a9ab5]">Rep #{c.repId} · {c.saleDate}{c.notes ? ` · ${c.notes}` : ""}</p>
                  </div>
                  {isManager && c.status === "pending" && (
                    <Button size="sm" variant="outline" className="border-blue-500/30 text-blue-400 hover:bg-blue-500/10 text-xs h-7" onClick={() => updateMutation.mutate({ id: c.id, status: "approved" })} data-testid={`button-approve-${c.id}`}>
                      Approve
                    </Button>
                  )}
                  {isManager && c.status === "approved" && (
                    <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs h-7" onClick={() => updateMutation.mutate({ id: c.id, status: "paid" })} data-testid={`button-mark-paid-${c.id}`}>
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
