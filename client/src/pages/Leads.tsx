import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Users, Search, Plus, Edit2, Trash2, Phone,
  DoorOpen, UserCheck, CalendarClock, Zap, Home, PhoneOff,
  BarChart2, Wifi, WifiOff, Building2, DollarSign, Map, Info,
  RefreshCw, ShieldCheck, ShieldX, User, Mail
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle
} from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import type { Lead, InsertLead, TeamMember, Knock, InsertKnock } from "@shared/schema";

// ── Constants ─────────────────────────────────────────────────────────────────
const LEAD_STATUSES = ["prospect", "contacted", "interested", "sold", "not_interested", "follow_up"];

const STATUS_LABEL: Record<string, string> = {
  prospect: "Prospect",
  contacted: "Contacted",
  interested: "Interested",
  sold: "Sold",
  not_interested: "Not Interested",
  follow_up: "Follow Up",
};

const STATUS_COLOR: Record<string, string> = {
  prospect:      "bg-slate-500/15 text-slate-400",
  contacted:     "bg-blue-500/15 text-blue-400",
  interested:    "bg-amber-500/15 text-amber-400",
  sold:          "bg-green-500/15 text-green-400",
  not_interested:"bg-red-500/15 text-red-400",
  follow_up:     "bg-purple-500/15 text-purple-400",
};

const OUTCOME_ICONS: Record<string, React.ElementType> = {
  not_home:      PhoneOff,
  not_interested: UserCheck,
  interested:    Zap,
  callback:      CalendarClock,
  sold:          Zap,
};

const OUTCOME_COLORS: Record<string, string> = {
  not_home:      "text-muted-foreground",
  not_interested:"text-red-400",
  interested:    "text-blue-400",
  callback:      "text-amber-400",
  sold:          "text-green-400",
};

// ── Lead Form ─────────────────────────────────────────────────────────────────
function LeadForm({ initial, onSave, onCancel, saving }: {
  initial?: Partial<Lead>;
  onSave: (data: Partial<InsertLead>) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<Partial<InsertLead>>({
    address: initial?.address ?? "",
    city: initial?.city ?? "",
    state: initial?.state ?? "NC",
    zip: initial?.zip ?? "",
    fiberStatus: "new_fiber",
    leadStatus: initial?.leadStatus ?? "prospect",
    contactName: initial?.contactName ?? "",
    contactPhone: initial?.contactPhone ?? "",
    contactEmail: initial?.contactEmail ?? "",
    notes: initial?.notes ?? "",
  });

  const set = (k: keyof InsertLead, v: string) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label className="text-xs text-muted-foreground">Street Address *</Label>
          <Input value={form.address} onChange={e => set("address", e.target.value)}
            className="bg-secondary border-input mt-1" placeholder="123 Main St"
            data-testid="form-address" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">City *</Label>
          <Input value={form.city} onChange={e => set("city", e.target.value)}
            className="bg-secondary border-input mt-1" placeholder="Rockwell"
            data-testid="form-city" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">ZIP *</Label>
          <Input value={form.zip} onChange={e => set("zip", e.target.value)}
            className="bg-secondary border-input mt-1" placeholder="28138"
            data-testid="form-zip" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs text-muted-foreground">Contact Name</Label>
          <Input value={form.contactName ?? ""} onChange={e => set("contactName", e.target.value)}
            className="bg-secondary border-input mt-1" placeholder="John Smith"
            data-testid="form-contact-name" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Phone</Label>
          <Input value={form.contactPhone ?? ""} onChange={e => set("contactPhone", e.target.value)}
            className="bg-secondary border-input mt-1" placeholder="(704) 555-0100"
            data-testid="form-contact-phone" />
        </div>
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Lead Status</Label>
        <Select value={form.leadStatus} onValueChange={v => set("leadStatus", v)}>
          <SelectTrigger className="bg-secondary border-input mt-1" data-testid="form-lead-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-card border-border">
            {LEAD_STATUSES.map(s => (
              <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Notes</Label>
        <Textarea value={form.notes ?? ""} onChange={e => set("notes", e.target.value)}
          className="bg-secondary border-input mt-1 text-sm" rows={3}
          placeholder="Knocked 7/6, owner interested. Call back Friday."
          data-testid="form-notes" />
      </div>
      <div className="flex gap-2 pt-1">
        <Button variant="outline" onClick={onCancel} className="border-border flex-1">Cancel</Button>
        <Button onClick={() => onSave(form)} disabled={saving || !form.address || !form.city || !form.zip}
          className="bg-primary hover:bg-primary/90 text-white flex-1" data-testid="btn-save-lead-form">
          {saving ? "Saving..." : "Save Lead"}
        </Button>
      </div>
    </div>
  );
}

// ── Knock Logger ──────────────────────────────────────────────────────────────
function KnockLogger({ lead, team, onClose }: {
  lead: Lead; team: TeamMember[]; onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [repId, setRepId] = useState("");
  const [wasHome, setWasHome] = useState("true");
  const [outcome, setOutcome] = useState("not_home");
  const [callbackDate, setCallbackDate] = useState("");
  const [callbackTime, setCallbackTime] = useState("");
  const [notes, setNotes] = useState("");

  const { data: knocks = [] } = useQuery<Knock[]>({
    queryKey: ["/api/leads", lead.id, "knocks"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/leads/${lead.id}/knocks`);
      return res.json();
    },
  });

  const knockMutation = useMutation({
    mutationFn: async (data: Omit<InsertKnock, "leadId">) => {
      const res = await apiRequest("POST", `/api/leads/${lead.id}/knock`, data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Knock logged" });
      qc.invalidateQueries({ queryKey: ["/api/leads", lead.id, "knocks"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      setNotes(""); setCallbackDate(""); setCallbackTime("");
    },
  });

  const homeTrue = wasHome === "true";

  return (
    <DialogContent className="bg-card border-border text-foreground max-w-lg">
      <DialogHeader>
        <DialogTitle className="text-base flex items-center gap-2">
          <DoorOpen className="w-4 h-4 text-primary" />
          Door Knock — {lead.address}
        </DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div>
          <Label className="text-xs text-muted-foreground">Rep *</Label>
          <Select value={repId} onValueChange={setRepId}>
            <SelectTrigger className="bg-secondary border-input mt-1" data-testid="knock-rep-select">
              <SelectValue placeholder="Select rep..." />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              {team.filter(m => m.active).map(m => (
                <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className="text-xs text-muted-foreground">Was anyone home?</Label>
          <div className="grid grid-cols-2 gap-2 mt-1">
            {[
              { val: "true",  label: "Home",     Icon: Home,    cls: homeTrue  ? "border-green-500/60 bg-green-500/10 text-green-400" : "border-border bg-secondary text-muted-foreground" },
              { val: "false", label: "Not Home", Icon: PhoneOff, cls: !homeTrue ? "border-red-500/60 bg-red-500/10 text-red-400"     : "border-border bg-secondary text-muted-foreground" },
            ].map(({ val, label, Icon, cls }) => (
              <button key={val} onClick={() => { setWasHome(val); if (val === "false") setOutcome("not_home"); }}
                className={`flex items-center gap-2 px-3 py-2 rounded-md border text-sm font-medium transition-colors ${cls}`}
                data-testid={`knock-home-${val}`}>
                <Icon className="w-4 h-4" /> {label}
              </button>
            ))}
          </div>
        </div>

        {homeTrue && (
          <div>
            <Label className="text-xs text-muted-foreground">Outcome</Label>
            <div className="grid grid-cols-2 gap-2 mt-1">
              {[
                { val: "not_interested", label: "Not Interested", color: "text-red-400" },
                { val: "interested",     label: "Interested",     color: "text-blue-400" },
                { val: "callback",       label: "Needs Callback", color: "text-amber-400" },
                { val: "sold",           label: "Sold 🎉",        color: "text-green-400" },
              ].map(({ val, label, color }) => (
                <button key={val} onClick={() => setOutcome(val)}
                  className={`px-3 py-2 rounded-md border text-sm font-medium transition-colors ${
                    outcome === val ? `${color} border-current bg-current/10` : "bg-secondary border-border text-muted-foreground"
                  }`}
                  data-testid={`knock-outcome-${val}`}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {homeTrue && outcome === "callback" && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">Callback Date</Label>
              <Input type="date" value={callbackDate} onChange={e => setCallbackDate(e.target.value)}
                className="bg-secondary border-input mt-1 text-sm" data-testid="knock-callback-date" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Callback Time</Label>
              <Input type="time" value={callbackTime} onChange={e => setCallbackTime(e.target.value)}
                className="bg-secondary border-input mt-1 text-sm" data-testid="knock-callback-time" />
            </div>
          </div>
        )}

        <div>
          <Label className="text-xs text-muted-foreground">Notes</Label>
          <Textarea value={notes} onChange={e => setNotes(e.target.value)}
            className="bg-secondary border-input mt-1 text-sm" rows={2}
            placeholder="Optional notes..." data-testid="knock-notes" />
        </div>

        <Button onClick={() => {
          if (!repId) { toast({ title: "Select a rep first", variant: "destructive" }); return; }
          knockMutation.mutate({
            repId: Number(repId), wasHome: homeTrue,
            outcome: homeTrue ? outcome : "not_home",
            callbackDate: outcome === "callback" ? callbackDate : undefined,
            callbackTime: outcome === "callback" ? callbackTime : undefined,
            notes: notes || undefined,
          });
        }}
          disabled={knockMutation.isPending || !repId}
          className="w-full bg-primary hover:bg-primary/90 text-white"
          data-testid="btn-log-knock">
          {knockMutation.isPending ? "Logging..." : "Log Knock"}
        </Button>

        {knocks.length > 0 && (
          <div className="border-t border-border pt-3">
            <div className="text-xs font-medium text-muted-foreground mb-2">History ({knocks.length})</div>
            <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1">
              {knocks.map(k => {
                const Icon = OUTCOME_ICONS[k.outcome] ?? DoorOpen;
                const color = OUTCOME_COLORS[k.outcome] ?? "text-muted-foreground";
                const repName = team.find(m => m.id === k.repId)?.name ?? `Rep #${k.repId}`;
                return (
                  <div key={k.id} className="flex items-start gap-2 text-xs bg-secondary rounded px-2.5 py-1.5">
                    <Icon className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${color}`} />
                    <div className="flex-1 min-w-0">
                      <span className={`font-medium ${color}`}>{k.outcome.replace("_", " ")}</span>
                      <span className="text-muted-foreground ml-1">· {repName}</span>
                      {k.callbackDate && <span className="text-amber-400 ml-1">→ {k.callbackDate}</span>}
                      {k.notes && <div className="text-muted-foreground italic truncate">{k.notes}</div>}
                    </div>
                    <span className="text-muted-foreground flex-shrink-0">
                      {new Date(k.knockedAt).toLocaleDateString()}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </DialogContent>
  );
}

// ── Assign Rep Modal ──────────────────────────────────────────────────────────
function AssignRepModal({ lead, team, onClose }: {
  lead: Lead; team: TeamMember[]; onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [repId, setRepId] = useState(lead.assignedRepId ? String(lead.assignedRepId) : "");

  const assignMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/leads/${lead.id}/assign`, {
        repId: repId && repId !== "0" ? Number(repId) : null
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Lead assigned" });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      onClose();
    },
  });

  return (
    <DialogContent className="bg-card border-border text-foreground max-w-sm">
      <DialogHeader>
        <DialogTitle className="text-base">Assign Rep</DialogTitle>
      </DialogHeader>
      <p className="text-xs text-muted-foreground">{lead.address}, {lead.city}</p>
      <Select value={repId} onValueChange={setRepId}>
        <SelectTrigger className="bg-secondary border-input" data-testid="assign-rep-select">
          <SelectValue placeholder="Select rep..." />
        </SelectTrigger>
        <SelectContent className="bg-card border-border">
          <SelectItem value="0">Unassigned</SelectItem>
          {team.filter(m => m.active).map(m => (
            <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <DialogFooter className="mt-2">
        <Button variant="outline" onClick={onClose} className="border-border">Cancel</Button>
        <Button onClick={() => assignMutation.mutate()} disabled={assignMutation.isPending}
          className="bg-primary hover:bg-primary/90 text-white" data-testid="btn-confirm-assign">
          {assignMutation.isPending ? "Assigning..." : "Assign"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}


// ── Owner Lookup Button (Tracerfy pay-per-hit) ───────────────────────────────
function OwnerLookupButton({ leadId, onDone }: { leadId: number; onDone: () => void }) {
  const { toast } = useToast();
  const [result, setResult] = useState<{ hit: boolean; ownerName?: string; cost: string } | null>(null);
  const [noKey, setNoKey] = useState(false);

  const lookup = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/leads/${leadId}/owner-lookup`, {});
      const data = await res.json();
      if (res.status === 402) { setNoKey(true); return null; }
      if (!res.ok) throw new Error(data.error || "Lookup failed");
      return data;
    },
    onSuccess: (data) => {
      if (!data) return;
      setResult(data);
      if (data.hit) { toast({ title: `Owner found · Cost: ${data.cost}` }); onDone(); }
      else toast({ title: "No owner data found · $0.00 charged" });
    },
    onError: (e: any) => toast({ title: e.message, variant: "destructive" }),
  });

  if (noKey) return (
    <div className="mt-2 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
      <p className="text-xs text-amber-400 font-medium">Owner Lookup (Tracerfy)</p>
      <p className="text-xs text-muted-foreground mt-0.5">Add a Tracerfy API key in SaaS Tenant settings to enable deep owner lookup at $0.20/hit.</p>
      <a href="https://www.tracerfy.com" target="_blank" rel="noreferrer"
        className="text-xs text-primary hover:underline">Get API key →</a>
    </div>
  );

  return (
    <div className="mt-2">
      {result ? (
        <div className={`rounded-lg px-3 py-2 text-xs ${result.hit ? "bg-green-500/10 border border-green-500/20 text-green-400" : "bg-secondary/50 text-muted-foreground"}`}>
          {result.hit ? `✓ Owner enriched · ${result.cost}` : `No match · $0.00 charged`}
        </div>
      ) : (
        <Button size="sm" variant="outline"
          onClick={() => lookup.mutate()}
          disabled={lookup.isPending}
          className="w-full border-primary/30 text-primary hover:bg-primary/10 text-xs h-7">
          {lookup.isPending ? "Looking up owner..." : "Deep Owner Lookup · $0.20/hit via Tracerfy"}
        </Button>
      )}
    </div>
  );
}

// ── Intelligence Panel (Side Sheet) ──────────────────────────────────────────
type EnrichmentData = {
  ownerName: string | null;
  ownerPhone: string | null;
  ownerEmail: string | null;
  incomeRange: string | null;
  homeValue: string | null;
  yearsAtAddress: number | null;
  isHomeowner: boolean | null;
  enrichedAt: string | null;
  competitorName: string | null;
  competitorSpeedMbps: number | null;
  competitorTech: string | null;
  inCompetitorArea: boolean;
  fiberStatus: string;
  isNewFiber: boolean | null;
  speedTier: string | null;
  maxDownloadMbps: number | null;
  techType: string | null;
};

function IntelligencePanel({ lead, open, onClose, canEdit }: {
  lead: Lead;
  open: boolean;
  onClose: () => void;
  canEdit: boolean;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editContact, setEditContact] = useState(false);
  const [ownerPhone, setOwnerPhone] = useState(lead.ownerPhone ?? "");
  const [ownerEmail, setOwnerEmail] = useState(lead.ownerEmail ?? "");

  const { data: enrich, isLoading, refetch, isFetching } = useQuery<EnrichmentData>({
    queryKey: ["/api/leads", lead.id, "enrichment"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/leads/${lead.id}/enrichment`);
      return res.json();
    },
    enabled: open,
    staleTime: 1000 * 60 * 5,
  });

  const saveContact = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/leads/${lead.id}/enrichment`, { ownerPhone, ownerEmail });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Contact saved" });
      qc.invalidateQueries({ queryKey: ["/api/leads", lead.id, "enrichment"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      setEditContact(false);
    },
  });

  const fiberStatusLabel: Record<string, string> = {
    new_fiber: "New Fiber Available",
    tenured: "Tenured (Existing Customer)",
    no_service: "No Fiber Service",
    copper_only: "Copper DSL Only",
    competitor_only: "Competitor Only",
    coming_soon: "Coming Soon",
    unknown: "Unknown",
  };

  const InfoRow = ({ icon: Icon, label, value, highlight }: {
    icon: React.ElementType; label: string; value: React.ReactNode; highlight?: boolean;
  }) => (
    <div className="flex items-start gap-3 py-2.5">
      <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${highlight ? "text-primary" : "text-muted-foreground"}`} />
      <div className="flex-1 min-w-0">
        <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
        <div className={`text-sm font-medium ${highlight ? "text-primary" : "text-foreground"}`}>{value}</div>
      </div>
    </div>
  );

  return (
    <Sheet open={open} onOpenChange={v => !v && onClose()}>
      <SheetContent className="bg-card border-border text-foreground w-full sm:max-w-md overflow-y-auto">
        <SheetHeader className="mb-4">
          <SheetTitle className="text-base flex items-center gap-2">
            <BarChart2 className="w-4 h-4 text-primary" />
            Lead Intelligence
          </SheetTitle>
          <p className="text-xs text-muted-foreground">{lead.address}, {lead.city} {lead.zip}</p>
        </SheetHeader>

        {/* Fiber Status Section */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <Wifi className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Fiber Status</span>
          </div>
          <div className="bg-secondary/50 rounded-lg px-3 py-1 divide-y divide-border/50">
            <InfoRow icon={lead.isNewFiber ? Wifi : WifiOff}
              label="Service Availability"
              value={fiberStatusLabel[lead.fiberStatus] ?? lead.fiberStatus}
              highlight={!!lead.isNewFiber} />
            {enrich?.speedTier && <InfoRow icon={Zap} label="Speed Tier" value={enrich.speedTier} />}
            {enrich?.maxDownloadMbps && <InfoRow icon={Zap} label="Max Download" value={`${enrich.maxDownloadMbps} Mbps`} />}
            {enrich?.techType && <InfoRow icon={Info} label="Technology" value={enrich.techType} />}
          </div>
        </div>

        <Separator className="my-3 bg-border/50" />

        {/* Competition Section */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <Building2 className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Competition at This Address</span>
          </div>
          {isLoading ? (
            <div className="bg-secondary/50 rounded-lg px-3 py-4 text-center text-xs text-muted-foreground">Loading...</div>
          ) : enrich?.inCompetitorArea ? (
            <div className="bg-secondary/50 rounded-lg px-3 py-1 divide-y divide-border/50">
              <InfoRow icon={ShieldX} label="Competitor ISP" value={enrich.competitorName ?? "Unknown"} />
              {enrich.competitorSpeedMbps && <InfoRow icon={Zap} label="Their Speed" value={`${enrich.competitorSpeedMbps} Mbps`} />}
              {enrich.competitorTech && <InfoRow icon={Info} label="Their Technology" value={enrich.competitorTech} />}
            </div>
          ) : (
            <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-3 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-green-400" />
              <span className="text-xs text-green-400 font-medium">No competitor ISP detected at this address</span>
            </div>
          )}
        </div>

        <Separator className="my-3 bg-border/50" />

        {/* Neighborhood Income Section */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="w-3.5 h-3.5 text-green-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Neighborhood Data (ZIP {lead.zip})</span>
            <button onClick={() => refetch()} disabled={isFetching}
              className="ml-auto text-muted-foreground hover:text-foreground transition-colors"
              title="Refresh from Census">
              <RefreshCw className={`w-3 h-3 ${isFetching ? "animate-spin" : ""}`} />
            </button>
          </div>
          {isLoading ? (
            <div className="bg-secondary/50 rounded-lg px-3 py-4 text-center text-xs text-muted-foreground">Fetching Census data...</div>
          ) : (
            <div className="bg-secondary/50 rounded-lg px-3 py-1 divide-y divide-border/50">
              <InfoRow icon={DollarSign} label="Median Household Income"
                value={enrich?.incomeRange ?? <span className="text-muted-foreground italic text-xs">Not available</span>} />
              <InfoRow icon={Home} label="Median Home Value"
                value={enrich?.homeValue ?? <span className="text-muted-foreground italic text-xs">Not available</span>} />
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1">
            <Map className="w-3 h-3" /> Source: US Census ACS 5-Year Estimates (ZIP-level, free)
          </p>
        </div>

        <Separator className="my-3 bg-border/50" />

        {/* Owner / Contact Section */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <User className="w-3.5 h-3.5 text-blue-400" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Owner / Contact</span>
            {canEdit && (
              <button onClick={() => setEditContact(v => !v)}
                className="ml-auto text-xs text-primary hover:underline">
                {editContact ? "Cancel" : "Edit"}
              </button>
            )}
          </div>

          {editContact ? (
            <div className="space-y-2">
              <div>
                <Label className="text-xs text-muted-foreground">Phone</Label>
                <Input value={ownerPhone} onChange={e => setOwnerPhone(e.target.value)}
                  placeholder="(704) 555-0100" className="bg-secondary border-input text-sm h-8 mt-1" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Email</Label>
                <Input value={ownerEmail} onChange={e => setOwnerEmail(e.target.value)}
                  placeholder="owner@example.com" className="bg-secondary border-input text-sm h-8 mt-1" />
              </div>
              <Button size="sm" onClick={() => saveContact.mutate()} disabled={saveContact.isPending}
                className="bg-primary hover:bg-primary/90 text-white text-xs h-7 w-full">
                Save Contact Info
              </Button>
            </div>
          ) : (
            <div className="bg-secondary/50 rounded-lg px-3 py-1 divide-y divide-border/50">
              <InfoRow icon={User} label="Owner Name"
                value={isLoading ? "Loading..." : (enrich?.ownerName ?? lead.ownerName ?? <span className="text-muted-foreground italic text-xs">Not in GIS records</span>)} />
              <InfoRow icon={Phone} label="Phone"
                value={lead.ownerPhone ?? <span className="text-muted-foreground italic text-xs">Not on file — click Edit to add</span>} />
              <InfoRow icon={Mail} label="Email"
                value={lead.ownerEmail ?? <span className="text-muted-foreground italic text-xs">Not on file</span>} />
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1">
            <Map className="w-3 h-3" /> Owner name: public GIS records
          </p>
          {/* Tracerfy deep lookup — pay per hit */}
          <OwnerLookupButton leadId={lead.id} onDone={() => refetch()} />
        </div>

        <Separator className="my-3 bg-border/50" />
        <div className="flex items-center gap-2">
          <Badge className={`text-xs px-2 py-0.5 rounded-full border-0 ${STATUS_COLOR[lead.leadStatus] ?? "bg-secondary text-muted-foreground"}`}>
            {STATUS_LABEL[lead.leadStatus]}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {lead.assignedRepId ? `Assigned to Rep #${lead.assignedRepId}` : "Unassigned"}
          </span>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function Leads() {
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [editLead, setEditLead] = useState<Lead | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [knockLead, setKnockLead] = useState<Lead | null>(null);
  const [assignLead, setAssignLead] = useState<Lead | null>(null);
  const [intelLead, setIntelLead] = useState<Lead | null>(null);

  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  // Permission flags
  const canAssign   = ["admin", "manager", "team_lead"].includes(user?.role ?? "");
  const canEdit     = ["admin", "manager"].includes(user?.role ?? "");
  const canDelete   = ["admin", "manager"].includes(user?.role ?? "");
  const canAddLead  = ["admin", "manager", "team_lead"].includes(user?.role ?? "");

  const [page, setPage] = useState(0);
  const PAGE_SIZE = 100;

  const { data: leadsResp, isLoading } = useQuery<{ leads: Lead[]; total: number; limit: number; offset: number }>({
    queryKey: ["/api/leads", search, filterStatus, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (filterStatus !== "all") params.set("status", filterStatus);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      const res = await apiRequest("GET", `/api/leads?${params}`);
      return res.json();
    },
    staleTime: 30000,
  });
  const leads = leadsResp?.leads ?? [];
  const totalLeads = leadsResp?.total ?? 0;
  const totalPages = Math.ceil(totalLeads / PAGE_SIZE);

  const { data: team = [] } = useQuery<TeamMember[]>({ queryKey: ["/api/team"] });
  const repMap = Object.fromEntries(team.map(m => [m.id, m]));

  const createMutation = useMutation({
    mutationFn: async (data: Partial<InsertLead>) => {
      const res = await apiRequest("POST", "/api/leads", data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Lead added" });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/stats"] });
      setAddOpen(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<InsertLead> }) => {
      const res = await apiRequest("PATCH", `/api/leads/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Lead updated" });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/stats"] });
      setEditLead(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => { await apiRequest("DELETE", `/api/leads/${id}`); },
    onSuccess: () => {
      toast({ title: "Lead deleted" });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/stats"] });
      setDeleteId(null);
    },
  });

  const quickStatus = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const res = await apiRequest("PATCH", `/api/leads/${id}`, { leadStatus: status });
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/leads"] }),
  });

  // Filtering is now server-side; leads array is already filtered
  const filtered = leads;
  // Reset page when filter/search changes
  const handleStatusChange = (s: string) => { setFilterStatus(s); setPage(0); };
  const handleSearchChange = (v: string) => { setSearch(v); setPage(0); };

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">Lead Management</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{totalLeads.toLocaleString()} lead{totalLeads !== 1 ? "s" : ""}</p>
        </div>
        {canAddLead && (
          <Button onClick={() => setAddOpen(true)} className="bg-primary hover:bg-primary/90 text-white text-sm"
            data-testid="btn-add-lead-manual">
            <Plus className="w-4 h-4 mr-1" /> Add Lead
          </Button>
        )}
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={e => handleSearchChange(e.target.value)}
            placeholder="Search address, city, contact..."
            className="pl-9 bg-secondary border-input text-sm h-9"
            data-testid="input-search-leads" />
        </div>
        <Select value={filterStatus} onValueChange={handleStatusChange}>
          <SelectTrigger className="bg-secondary border-input w-36 text-sm h-9" data-testid="filter-lead-status">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent className="bg-card border-border">
            <SelectItem value="all">All statuses</SelectItem>
            {LEAD_STATUSES.map(s => (
              <SelectItem key={s} value={s}>{STATUS_LABEL[s]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Status tabs — server-side filtered, show active filter only */}
      <div className="flex gap-2 flex-wrap">
        {["all", ...LEAD_STATUSES].map(s => {
          const active = filterStatus === s;
          return (
            <button key={s} onClick={() => handleStatusChange(s)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                active ? "bg-primary text-white" : "bg-secondary text-muted-foreground hover:text-foreground"
              }`}>
              {s === "all" ? `All ${totalLeads > 0 ? totalLeads.toLocaleString() : ""}` : STATUS_LABEL[s]}
            </button>
          );
        })}
      </div>

      {/* Lead list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground text-sm">
          <RefreshCw className="w-4 h-4 animate-spin" /> Loading leads…
        </div>
      ) : filtered.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="py-12 text-center">
            <Users className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-30" />
            <div className="text-sm text-muted-foreground">
              {totalLeads === 0 ? "No leads yet — run a City Scan to discover new fiber leads." : "No leads match this filter."}
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(lead => {
            const assignedRep = lead.assignedRepId ? repMap[lead.assignedRepId] : null;
            const statusCls = STATUS_COLOR[lead.leadStatus] ?? "bg-secondary text-muted-foreground";

            return (
              <Card key={lead.id} className="bg-card border-border hover:border-primary/20 transition-colors"
                data-testid={`card-lead-${lead.id}`}>
                <CardContent className="py-3 px-4">
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm text-foreground">{lead.address}</span>
                        <span className="text-xs text-muted-foreground">{lead.city}, {lead.state} {lead.zip}</span>
                        <Badge className={`text-xs px-2 py-0 rounded-full border-0 ${statusCls}`}>
                          {STATUS_LABEL[lead.leadStatus]}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-3 mt-1 flex-wrap">
                        {lead.contactName && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Users className="w-3 h-3" /> {lead.contactName}
                          </span>
                        )}
                        {lead.contactPhone && (
                          <span className="text-xs text-muted-foreground flex items-center gap-1">
                            <Phone className="w-3 h-3" /> {lead.contactPhone}
                          </span>
                        )}
                        {assignedRep ? (
                          <span className="text-xs text-primary flex items-center gap-1">
                            <UserCheck className="w-3 h-3" /> {assignedRep.name}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground italic">Unassigned</span>
                        )}
                        {lead.notes && (
                          <span className="text-xs text-muted-foreground italic truncate max-w-[200px]">
                            "{lead.notes}"
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {/* Status dropdown — manager+ only */}
                      {canEdit && (
                        <Select value={lead.leadStatus} onValueChange={v => quickStatus.mutate({ id: lead.id, status: v })}>
                          <SelectTrigger className="bg-secondary border-input h-7 text-xs w-28"
                            data-testid={`select-status-${lead.id}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-card border-border">
                            {LEAD_STATUSES.map(s => (
                              <SelectItem key={s} value={s} className="text-xs">{STATUS_LABEL[s]}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                      {/* Assign — team lead+ */}
                      {canAssign && (
                        <Button variant="ghost" size="sm"
                          className="h-7 px-2 text-xs text-muted-foreground hover:text-primary"
                          onClick={() => setAssignLead(lead)}
                          data-testid={`btn-assign-${lead.id}`}>
                          <UserCheck className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      {/* Intelligence — everyone */}
                      <Button variant="ghost" size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-primary"
                        onClick={() => setIntelLead(lead)}
                        title="Lead Intelligence"
                        data-testid={`btn-intel-${lead.id}`}>
                        <BarChart2 className="w-3.5 h-3.5" />
                      </Button>
                      {/* Knock — everyone */}
                      <Button variant="ghost" size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-amber-400"
                        onClick={() => setKnockLead(lead)}
                        data-testid={`btn-knock-${lead.id}`}>
                        <DoorOpen className="w-3.5 h-3.5" />
                      </Button>
                      {/* Edit — manager+ */}
                      {canEdit && (
                        <Button variant="ghost" size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                          onClick={() => setEditLead(lead)}
                          data-testid={`btn-edit-${lead.id}`}>
                          <Edit2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                      {/* Delete — manager+ */}
                      {canDelete && (
                        <Button variant="ghost" size="sm"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-red-400"
                          onClick={() => setDeleteId(lead.id)}
                          data-testid={`btn-delete-${lead.id}`}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <span className="text-xs text-muted-foreground">
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalLeads)} of {totalLeads.toLocaleString()}
          </span>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={page === 0} onClick={() => setPage(p => p - 1)}>← Prev</Button>
            <span className="text-xs text-muted-foreground px-2">{page + 1} / {totalPages}</span>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next →</Button>
          </div>
        </div>
      )}

      {/* Dialogs */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="bg-card border-border text-foreground max-w-lg">
          <DialogHeader><DialogTitle className="text-base">Add Lead</DialogTitle></DialogHeader>
          <LeadForm onSave={d => createMutation.mutate(d)} onCancel={() => setAddOpen(false)} saving={createMutation.isPending} />
        </DialogContent>
      </Dialog>

      <Dialog open={!!editLead} onOpenChange={v => !v && setEditLead(null)}>
        <DialogContent className="bg-card border-border text-foreground max-w-lg">
          <DialogHeader><DialogTitle className="text-base">Edit Lead</DialogTitle></DialogHeader>
          {editLead && (
            <LeadForm initial={editLead}
              onSave={d => updateMutation.mutate({ id: editLead.id, data: d })}
              onCancel={() => setEditLead(null)} saving={updateMutation.isPending} />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={deleteId !== null} onOpenChange={v => !v && setDeleteId(null)}>
        <DialogContent className="bg-card border-border text-foreground max-w-sm">
          <DialogHeader><DialogTitle className="text-base">Delete Lead?</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">This will permanently remove the lead and all knock history.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteId(null)} className="border-border">Cancel</Button>
            <Button onClick={() => deleteId && deleteMutation.mutate(deleteId)}
              disabled={deleteMutation.isPending}
              className="bg-destructive hover:bg-destructive/90 text-white"
              data-testid="btn-confirm-delete">
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!knockLead} onOpenChange={v => !v && setKnockLead(null)}>
        {knockLead && <KnockLogger lead={knockLead} team={team} onClose={() => setKnockLead(null)} />}
      </Dialog>

      <Dialog open={!!assignLead} onOpenChange={v => !v && setAssignLead(null)}>
        {assignLead && <AssignRepModal lead={assignLead} team={team} onClose={() => setAssignLead(null)} />}
      </Dialog>

      {/* Intelligence Panel */}
      {intelLead && (
        <IntelligencePanel
          lead={intelLead}
          open={!!intelLead}
          onClose={() => setIntelLead(null)}
          canEdit={canEdit}
        />
      )}
    </div>
  );
}
