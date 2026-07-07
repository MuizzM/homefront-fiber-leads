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
import { Wifi, Plus, ArrowUpRight, Trash2, Search, Filter } from "lucide-react";
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

const REASON_COLORS: Record<string, string> = {
  no_service: "bg-red-500/20 text-red-400 border-red-500/30",
  copper_only: "bg-amber-500/20 text-amber-400 border-amber-500/30",
  competitor_only: "bg-purple-500/20 text-purple-400 border-purple-500/30",
  coming_soon: "bg-blue-500/20 text-blue-400 border-blue-500/30",
};

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

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Coming Soon Pipeline</h1>
          <p className="text-sm text-[#7a9ab5]">Track addresses where fiber isn't available yet — future lead pipeline</p>
        </div>
        {isManager && (
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="bg-[#3EA394] hover:bg-[#35897d] text-white" data-testid="button-add-coming-soon">
                <Plus className="w-4 h-4 mr-2" /> Add Address
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-[#0a1e30] border-[#1a3a52] text-white">
              <DialogHeader><DialogTitle>Add to Pipeline</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <Input placeholder="Street address" value={form.address} onChange={e => setForm(f => ({...f, address: e.target.value}))} className="bg-[#0F2A44] border-[#1a3a52] text-white" data-testid="input-address" />
                <div className="grid grid-cols-2 gap-2">
                  <Input placeholder="City" value={form.city} onChange={e => setForm(f => ({...f, city: e.target.value}))} className="bg-[#0F2A44] border-[#1a3a52] text-white" data-testid="input-city" />
                  <Input placeholder="ZIP" value={form.zip} onChange={e => setForm(f => ({...f, zip: e.target.value}))} className="bg-[#0F2A44] border-[#1a3a52] text-white" data-testid="input-zip" />
                </div>
                <Select value={form.reason} onValueChange={v => setForm(f => ({...f, reason: v}))}>
                  <SelectTrigger className="bg-[#0F2A44] border-[#1a3a52] text-white" data-testid="select-reason"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-[#0a1e30] border-[#1a3a52]">
                    {Object.entries(REASON_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button onClick={() => addMutation.mutate(form)} disabled={addMutation.isPending || !form.address} className="w-full bg-[#3EA394] hover:bg-[#35897d] text-white" data-testid="button-submit-coming-soon">
                  Add to Pipeline
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Card className="bg-[#0a1e30] border-[#1a3a52] lg:col-span-1">
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold text-white">{addresses.filter(a => !a.fiberAvailable).length}</p>
            <p className="text-xs text-[#7a9ab5]">Monitoring</p>
          </CardContent>
        </Card>
        <Card className="bg-[#0a1e30] border-[#1a3a52]">
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold text-emerald-400">{converted.length}</p>
            <p className="text-xs text-[#7a9ab5]">Converted</p>
          </CardContent>
        </Card>
        {byReason.slice(0, 3).map(r => (
          <Card key={r.reason} className="bg-[#0a1e30] border-[#1a3a52]">
            <CardContent className="p-3 text-center">
              <p className="text-2xl font-bold text-white">{r.count}</p>
              <p className="text-xs text-[#7a9ab5]">{r.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#7a9ab5]" />
          <Input placeholder="Search addresses..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9 bg-[#0a1e30] border-[#1a3a52] text-white placeholder:text-[#4a6a82]" data-testid="input-search" />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-[#7a9ab5]" />
          <Select value={filterReason} onValueChange={setFilterReason}>
            <SelectTrigger className="w-36 bg-[#0a1e30] border-[#1a3a52] text-[#7a9ab5]" data-testid="select-filter-reason"><SelectValue /></SelectTrigger>
            <SelectContent className="bg-[#0a1e30] border-[#1a3a52]">
              <SelectItem value="all">All Reasons</SelectItem>
              {Object.entries(REASON_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Address table */}
      <Card className="bg-[#0a1e30] border-[#1a3a52]">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
            <Wifi className="w-4 h-4 text-[#3EA394]" /> Monitored Addresses
            <Badge className="bg-[#1a3a52] text-[#7a9ab5] border-[#2a4a62] ml-2">{filtered.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">{[1,2,3,4].map(i => <Skeleton key={i} className="h-14 bg-[#1a3a52]" />)}</div>
          ) : filtered.length === 0 ? (
            <div className="p-6 text-center">
              <Wifi className="w-8 h-8 text-[#2a4a62] mx-auto mb-2" />
              <p className="text-sm text-[#7a9ab5]">No addresses in pipeline{search ? " matching search" : ""}</p>
            </div>
          ) : (
            <div className="divide-y divide-[#1a3a52]">
              {filtered.map(a => (
                <div key={a.id} className="px-4 py-3 flex items-center justify-between gap-3" data-testid={`coming-soon-row-${a.id}`}>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-white font-medium truncate">{a.address}</p>
                    <p className="text-xs text-[#7a9ab5]">{a.city}, {a.state} {a.zip}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Badge className={`text-xs ${REASON_COLORS[a.reason] ?? "bg-[#1a3a52] text-[#7a9ab5]"}`}>
                      {REASON_LABELS[a.reason] ?? a.reason}
                    </Badge>
                    {isManager && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => promoteMutation.mutate(a.id)} disabled={promoteMutation.isPending} className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 text-xs h-7 px-2" data-testid={`button-promote-${a.id}`}>
                          <ArrowUpRight className="w-3 h-3 mr-1" /> Promote
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => deleteMutation.mutate(a.id)} disabled={deleteMutation.isPending} className="text-red-400 hover:bg-red-500/10 h-7 w-7 p-0" data-testid={`button-delete-${a.id}`}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Converted section */}
      {converted.length > 0 && (
        <Card className="bg-[#0a1e30] border-[#1a3a52]">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-white flex items-center gap-2">
              <ArrowUpRight className="w-4 h-4 text-emerald-400" /> Converted to Leads
              <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 ml-2">{converted.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-[#1a3a52]">
              {converted.map(a => (
                <div key={a.id} className="px-4 py-3 flex items-center justify-between" data-testid={`converted-row-${a.id}`}>
                  <div>
                    <p className="text-sm text-white">{a.address}</p>
                    <p className="text-xs text-[#7a9ab5]">{a.city}, {a.state} {a.zip}</p>
                  </div>
                  <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs">Fiber Available</Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
