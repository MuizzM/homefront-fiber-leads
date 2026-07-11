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
import { Wifi, Plus, ArrowUpRight, Trash2, Search, Filter, Clock } from "lucide-react";
import { useState } from "react";

interface ComingSoonAddress {
  id: number; address: string; city: string; state: string; zip: string;
  lat: number | null; lng: number | null; reason: string; lastChecked: string | null;
  fiberAvailable: boolean; convertedToLeadId: number | null; addedBy: number | null; createdAt: string;
}

const REASON_LABELS: Record<string, string> = {
  no_service: "No Service",
  copper_only: "Copper Only",
  competitor_only: "Competitor Only",
  coming_soon: "Coming Soon",
};

const REASON_STYLES: Record<string, { pill: string; dot: string }> = {
  no_service: { pill: "bg-rose-500/15 text-rose-400", dot: "bg-rose-400" },
  copper_only: { pill: "bg-amber-500/15 text-amber-400", dot: "bg-amber-400" },
  competitor_only: { pill: "bg-violet-500/15 text-violet-400", dot: "bg-violet-400" },
  coming_soon: { pill: "bg-sky-500/15 text-sky-400", dot: "bg-sky-400" },
};

const fmtDate = (s: string | null) =>
  s ? new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—";

export default function ComingSoon() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isManager = user?.role === "admin" || user?.role === "manager";
  const [search, setSearch] = useState("");
  const [filterReason, setFilterReason] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ address: "", city: "Rockwell", state: "NC", zip: "28138", reason: "no_service" });

  const { data: addresses = [], isLoading } = useQuery<ComingSoonAddress[]>({
    queryKey: ["/api/coming-soon"],
    queryFn: () => apiRequest("GET", "/api/coming-soon").then(r => r.json()),
    refetchInterval: 60000,
  });

  const addMutation = useMutation({
    mutationFn: (data: any) => apiRequest("POST", "/api/coming-soon", data).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/coming-soon"] });
      toast({ title: "Address added to pipeline" });
      setAddOpen(false);
      setForm({ address: "", city: "Rockwell", state: "NC", zip: "28138", reason: "no_service" });
    },
    onError: (e: any) => toast({ title: e?.message?.includes("409") ? "Already in pipeline" : "Error", variant: "destructive" }),
  });

  const promoteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/coming-soon/${id}/promote`, {}).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/coming-soon"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
      toast({ title: "Promoted to active lead" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/coming-soon/${id}`).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/coming-soon"] });
      toast({ title: "Removed from pipeline" });
    },
  });

  const filtered = addresses.filter(a => {
    const matchSearch = !search || a.address.toLowerCase().includes(search.toLowerCase()) || a.city.toLowerCase().includes(search.toLowerCase());
    const matchReason = filterReason === "all" || a.reason === filterReason;
    return matchSearch && matchReason && !a.fiberAvailable;
  });

  const converted = addresses.filter(a => a.fiberAvailable);
  const byReason = Object.entries(REASON_LABELS).map(([k, v]) => ({
    reason: k, label: v, count: addresses.filter(a => a.reason === k && !a.fiberAvailable).length
  }));

  const metrics = [
    { key: "monitoring", label: "Monitoring", value: addresses.filter(a => !a.fiberAvailable).length, accent: "text-foreground" },
    { key: "converted", label: "Converted", value: converted.length, accent: "text-emerald-400" },
    ...byReason.map(r => ({ key: r.reason, label: r.label, value: r.count, accent: "text-foreground" })),
  ];

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-primary">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 animate-ping" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
            </span>
            Live watchlist
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Coming Soon Pipeline</h1>
          <p className="text-sm text-muted-foreground">Track addresses where fiber isn't available yet — your future lead pipeline.</p>
        </div>
        {isManager && (
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="bg-primary hover:bg-primary/90 text-primary-foreground" data-testid="button-add-coming-soon">
                <Plus className="w-4 h-4 mr-2" /> Add Address
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-card border-border text-foreground">
              <DialogHeader><DialogTitle className="font-semibold tracking-tight">Add to Pipeline</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <Input placeholder="Street address" value={form.address} onChange={e => setForm(f => ({...f, address: e.target.value}))} className="bg-secondary border-border text-foreground" data-testid="input-address" />
                <div className="grid grid-cols-2 gap-2">
                  <Input placeholder="City" value={form.city} onChange={e => setForm(f => ({...f, city: e.target.value}))} className="bg-secondary border-border text-foreground" data-testid="input-city" />
                  <Input placeholder="ZIP" value={form.zip} onChange={e => setForm(f => ({...f, zip: e.target.value}))} className="bg-secondary border-border text-foreground" data-testid="input-zip" />
                </div>
                <Select value={form.reason} onValueChange={v => setForm(f => ({...f, reason: v}))}>
                  <SelectTrigger className="bg-secondary border-border text-foreground" data-testid="select-reason"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-card border-border">
                    {Object.entries(REASON_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button onClick={() => addMutation.mutate(form)} disabled={addMutation.isPending || !form.address} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground" data-testid="button-submit-coming-soon">
                  Add to Pipeline
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {/* Metric strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 rounded-xl border border-border bg-card overflow-hidden">
        {metrics.map(m => (
          <div key={m.key} className="p-4 border-t border-l border-border">
            <p className={`text-2xl font-semibold tracking-tight tabular-nums ${m.accent}`}>{m.value}</p>
            <p className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">{m.label}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input placeholder="Search addresses..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 bg-card border-border text-foreground placeholder:text-muted-foreground" data-testid="input-search" />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <Select value={filterReason} onValueChange={setFilterReason}>
            <SelectTrigger className="w-36 bg-card border-border text-muted-foreground" data-testid="select-filter-reason"><SelectValue /></SelectTrigger>
            <SelectContent className="bg-card border-border">
              <SelectItem value="all">All Reasons</SelectItem>
              {Object.entries(REASON_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Watchlist */}
      <Card className="bg-card border-border rounded-xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
            <Wifi className="w-4 h-4 text-primary" /> Monitored Addresses
            <Badge className="bg-muted text-muted-foreground border-border ml-2 tabular-nums">{filtered.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">{[1,2,3,4].map(i => <Skeleton key={i} className="h-16 bg-muted" />)}</div>
          ) : filtered.length === 0 ? (
            <div className="p-10 text-center">
              <Wifi className="w-8 h-8 text-muted-foreground/50 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No addresses in pipeline{search ? " matching search" : ""}</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filtered.map(a => {
                const style = REASON_STYLES[a.reason] ?? { pill: "bg-muted text-muted-foreground", dot: "bg-muted-foreground" };
                return (
                  <div key={a.id} className="px-4 py-3.5 flex items-center justify-between gap-3 hover:bg-muted/40 transition-colors" data-testid={`coming-soon-row-${a.id}`}>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{a.address}</p>
                      <div className="mt-1 flex items-center gap-x-3 gap-y-1 flex-wrap text-xs text-muted-foreground">
                        <span className="tabular-nums">{a.city}, {a.state} {a.zip}</span>
                        <span className="inline-flex items-center gap-1 tabular-nums"><Clock className="w-3 h-3" /> First seen {fmtDate(a.createdAt)}</span>
                        <span className="tabular-nums">Last checked {fmtDate(a.lastChecked)}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${style.pill}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                        {REASON_LABELS[a.reason] ?? a.reason}
                      </span>
                      {isManager && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => promoteMutation.mutate(a.id)} disabled={promoteMutation.isPending} className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 text-xs h-7 px-2" data-testid={`button-promote-${a.id}`}>
                            <ArrowUpRight className="w-3 h-3 mr-1" /> Promote
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => deleteMutation.mutate(a.id)} disabled={deleteMutation.isPending} className="text-rose-400 hover:bg-rose-500/10 h-7 w-7 p-0" data-testid={`button-delete-${a.id}`}>
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Converted */}
      {converted.length > 0 && (
        <Card className="bg-card border-border rounded-xl">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
              <ArrowUpRight className="w-4 h-4 text-emerald-400" /> Converted to Leads
              <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 ml-2 tabular-nums">{converted.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {converted.map(a => (
                <div key={a.id} className="px-4 py-3.5 flex items-center justify-between gap-3" data-testid={`converted-row-${a.id}`}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{a.address}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">{a.city}, {a.state} {a.zip}</p>
                  </div>
                  <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium bg-emerald-500/15 text-emerald-400 flex-shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    Fiber Available
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
