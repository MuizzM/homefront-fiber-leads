import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Users, Search, Plus, Edit2, Trash2, Phone,
  DoorOpen, UserCheck, CalendarClock, Zap, Home, PhoneOff,
  BarChart2, Wifi, WifiOff, Building2, DollarSign, Map, Info,
  RefreshCw, ShieldCheck, ShieldX, User, Mail, ChevronLeft, ChevronRight,
  Target, Star, Calendar
} from "lucide-react";
import { KpiTile } from "@/components/KpiTile";
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
import { Skeleton } from "@/components/ui/skeleton";
import { useDebounce } from "@/hooks/use-debounce";
import type { Lead, InsertLead, TeamMember, Knock } from "@shared/schema";
import { OUTCOMES, makeClientId } from "@shared/knock";

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

// ONE status color language, matched to the map's PIN_COLORS (MapView.tsx) so a
// status looks identical on the list and on the map. (interested=purple,
// follow_up=amber — these were previously swapped between the two pages.)
const STATUS_COLOR: Record<string, string> = {
  prospect:      "bg-emerald-500/15 text-emerald-400",
  contacted:     "bg-blue-500/15 text-blue-400",
  interested:    "bg-violet-500/15 text-violet-400",
  sold:          "bg-green-500/15 text-green-400",
  not_interested:"bg-red-500/15 text-red-400",
  follow_up:     "bg-amber-500/15 text-amber-400",
};

// Solid accent (left bar / dot) so a rep reads status at a glance without text.
const STATUS_ACCENT: Record<string, string> = {
  prospect:      "#22c55e",
  contacted:     "#3b82f6",
  interested:    "#8b5cf6",
  sold:          "#10b981",
  not_interested:"#ef4444",
  follow_up:     "#f59e0b",
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
  interested:    "text-violet-400",
  callback:      "text-amber-400",
  sold:          "text-green-400",
};

// The manager's quick-log uses the SAME one-tap outcome model as the rep's
// OutcomeSheet (needs_verification excluded — it's a system verdict, not a tap).
const KNOCK_GRID = OUTCOMES.filter(o => o.key !== "needs_verification");

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
    // Preserve the existing fiber status on edit (this form has no field for it);
    // hardcoding new_fiber here silently reset tenured/no_service leads on save.
    fiberStatus: initial?.fiberStatus ?? "new_fiber",
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
function KnockLogger({ lead, team }: {
  lead: Lead; team: TeamMember[]; onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  // Smart default: credit the lead's assigned rep — for the common case the
  // manager opens the dialog and logs in ONE tap. (Was: empty picker + wasHome
  // toggle + outcome + submit = 4 interactions.)
  const [repId, setRepId] = useState(lead.assignedRepId ? String(lead.assignedRepId) : "");
  const [cbOpen, setCbOpen] = useState(false);
  const [callbackDate, setCallbackDate] = useState("");
  const [callbackTime, setCallbackTime] = useState("");
  const [notes, setNotes] = useState("");
  // One idempotency key per dialog-open: a double-tap or retry after a lost
  // response replays as the SAME knock server-side, never a duplicate.
  const [clientId, setClientId] = useState(() => makeClientId());

  const { data: knocks = [] } = useQuery<Knock[]>({
    queryKey: ["/api/leads", lead.id, "knocks"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/leads/${lead.id}/knocks`);
      return res.json();
    },
  });

  const knockMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await apiRequest("POST", `/api/leads/${lead.id}/knock`, data);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Knock logged" });
      qc.invalidateQueries({ queryKey: ["/api/leads", lead.id, "knocks"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      qc.invalidateQueries({ queryKey: ["/api/followups"] });
      // Reset for the next log; fresh idempotency key for a genuinely new knock.
      setNotes(""); setCallbackDate(""); setCallbackTime(""); setCbOpen(false);
      setClientId(makeClientId());
    },
    // On error every field is preserved (only onSuccess clears) — the manager
    // fixes the problem and re-taps without retyping the note.
    onError: (e: any) => toast({ title: "Couldn't log the knock", description: String(e?.message ?? e), variant: "destructive" }),
  });

  // One-tap log — the server derives wasHome from the outcome, same as the rep
  // flow, so no separate Home/Not-home toggle is needed.
  const fire = (o: (typeof KNOCK_GRID)[number]) => {
    if (!repId) { toast({ title: "Pick who gets credit first", variant: "destructive" }); return; }
    if (o.key === "callback" && !cbOpen) { setCbOpen(true); return; } // reveal the schedule first
    knockMutation.mutate({
      clientId,
      repId: Number(repId),
      outcome: o.key,
      callbackDate: o.key === "callback" && callbackDate ? callbackDate : undefined,
      callbackTime: o.key === "callback" && callbackTime ? callbackTime : undefined,
      notes: notes || undefined,
    });
  };

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
          <Label className="text-xs text-muted-foreground">Credit rep *</Label>
          <Select value={repId} onValueChange={setRepId}>
            <SelectTrigger className="bg-secondary border-input mt-1" data-testid="knock-rep-select">
              <SelectValue placeholder="Select rep..." />
            </SelectTrigger>
            <SelectContent className="bg-card border-border">
              {team.filter(m => m.active).map(m => (
                <SelectItem key={m.id} value={String(m.id)}>
                  {m.name}{lead.assignedRepId === m.id ? " · assigned" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* One-tap outcomes — the SAME 7-outcome model + colors as the rep's
            OutcomeSheet, so logging reads identically everywhere. Tapping logs
            immediately (callback first reveals its schedule). */}
        <div>
          <Label className="text-xs text-muted-foreground">Outcome — tap to log</Label>
          <div className="grid grid-cols-2 gap-2 mt-1">
            {KNOCK_GRID.map(o => {
              const win = o.key === "sold";
              const armed = o.key === "callback" && cbOpen;
              return (
                <button
                  key={o.key} onClick={() => fire(o)} disabled={knockMutation.isPending}
                  data-testid={`knock-outcome-${o.key}`}
                  className="h-11 rounded-lg font-semibold text-[13px] flex items-center justify-center gap-2 active:scale-95 transition-transform border-2 disabled:opacity-60"
                  style={win
                    ? { background: o.color, color: "#04120d", borderColor: o.color }
                    : { background: `${o.color}${armed ? "33" : "1f"}`, color: "hsl(var(--card-foreground))", borderColor: `${o.color}${armed ? "dd" : "99"}` }}
                >
                  {!win && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: o.color }} />}
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>

        {cbOpen && (
          <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/[0.06] p-3" data-testid="knock-callback-schedule">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-cyan-400 mb-2">Schedule the callback, then tap Callback again</div>
            <div className="grid grid-cols-2 gap-3">
              <Input type="date" aria-label="Callback date" value={callbackDate} onChange={e => setCallbackDate(e.target.value)}
                className="bg-secondary border-input text-sm" data-testid="knock-callback-date" />
              <Input type="time" aria-label="Callback time" value={callbackTime} onChange={e => setCallbackTime(e.target.value)}
                className="bg-secondary border-input text-sm" data-testid="knock-callback-time" />
            </div>
          </div>
        )}

        <div>
          <Label className="text-xs text-muted-foreground">Notes</Label>
          <Textarea value={notes} onChange={e => setNotes(e.target.value)}
            className="bg-secondary border-input mt-1 text-sm" rows={2}
            placeholder="Optional notes..." data-testid="knock-notes" />
        </div>

        {knockMutation.isPending && (
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground"><RefreshCw className="w-3.5 h-3.5 animate-spin" />Logging…</div>
        )}

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
                      {k.callbackDate && <span className="text-amber-400 ml-1">Callback {k.callbackDate}</span>}
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
        className="text-xs text-primary hover:underline">Get API key</a>
    </div>
  );

  return (
    <div className="mt-2">
      {result ? (
        <div className={`rounded-lg px-3 py-2 text-xs ${result.hit ? "bg-green-500/10 border border-green-500/20 text-green-400" : "bg-secondary/50 text-muted-foreground"}`}>
          {result.hit ? `Owner enriched · ${result.cost}` : `No match · $0.00 charged`}
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
  const [filterCity, setFilterCity] = useState("all");
  const [filterState, setFilterState] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const [editLead, setEditLead] = useState<Lead | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [knockLead, setKnockLead] = useState<Lead | null>(null);
  const [assignLead, setAssignLead] = useState<Lead | null>(null);
  const [intelLead, setIntelLead] = useState<Lead | null>(null);

  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  // Permission flags
  const canAssign   = ["admin", "manager", "team_lead"].includes(user?.role ?? "");
  const canEdit     = ["admin", "manager"].includes(user?.role ?? "");
  const canDelete   = ["admin", "manager"].includes(user?.role ?? "");
  const canAddLead  = ["admin", "manager", "team_lead"].includes(user?.role ?? "");

  const [page, setPage] = useState(0);
  const PAGE_SIZE = 100;

  // Debounce search so a query fires once typing pauses, not on every keystroke.
  const debouncedSearch = useDebounce(search, 300);

  const { data: leadsResp, isLoading, isFetching } = useQuery<{ leads: Lead[]; total: number; limit: number; offset: number }>({
    queryKey: ["/api/leads", debouncedSearch, filterStatus, filterCity, filterState, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (filterStatus !== "all") params.set("status", filterStatus);
      if (filterCity !== "all") params.set("city", filterCity);
      if (filterState !== "all") params.set("state", filterState);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));
      const res = await apiRequest("GET", `/api/leads?${params}`);
      return res.json();
    },
    staleTime: 30000,
    placeholderData: keepPreviousData, // keep the current page visible while the next loads — no skeleton flash
  });
  const leads = leadsResp?.leads ?? [];
  const totalLeads = leadsResp?.total ?? 0;
  const totalPages = Math.ceil(totalLeads / PAGE_SIZE);

  // Distinct city/state pairs for the filter dropdowns — a tiny facets payload
  // instead of downloading the ENTIRE map pin set (every lead) just to build
  // two selects.
  const { data: facetsData } = useQuery<{ facets: Array<{ city: string; state: string }> }>({
    queryKey: ["/api/leads/facets"],
    queryFn: async () => (await apiRequest("GET", "/api/leads/facets")).json(),
    staleTime: 5 * 60_000,
  });
  const facets = facetsData?.facets ?? [];

  // Pipeline breakdown for the KPI strip (tenant/role-scoped server-side).
  const { data: leadStats } = useQuery<{ total: number; byStatus: Record<string, number> }>({
    queryKey: ["/api/stats"],
    queryFn: async () => (await apiRequest("GET", "/api/stats")).json(),
    staleTime: 30_000,
  });
  const bs = leadStats?.byStatus ?? {};

  // Distinct states + cities for the dropdowns (cities scoped to the chosen state)
  const states = Array.from(new Set(facets.map(f => f.state).filter(Boolean))).sort();
  const cities = Array.from(new Set(
    facets.filter(f => filterState === "all" || f.state === filterState).map(f => f.city).filter(Boolean)
  )).sort();

  const { data: team = [] } = useQuery<TeamMember[]>({ queryKey: ["/api/team"] });

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
    onError: (e: any) => toast({ title: e?.message ?? "Couldn't add lead", variant: "destructive" }),
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
    onError: (e: any) => toast({ title: e?.message ?? "Couldn't update lead", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => { await apiRequest("DELETE", `/api/leads/${id}`); },
    onSuccess: () => {
      toast({ title: "Lead deleted" });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/stats"] });
      setDeleteId(null);
    },
    onError: (e: any) => toast({ title: e?.message ?? "Couldn't delete lead", variant: "destructive" }),
  });

  // Filtering is now server-side; leads array is already filtered
  const filtered = leads;
  // Reset page when any filter/search changes
  const handleStatusChange = (s: string) => { setFilterStatus(s); setPage(0); };
  const handleSearchChange = (v: string) => { setSearch(v); setPage(0); };
  const searching = search !== debouncedSearch; // typing, query not yet fired
  const handleStateChange = (s: string) => { setFilterState(s); setFilterCity("all"); setPage(0); };
  const handleCityChange = (c: string) => { setFilterCity(c); setPage(0); };

  return (
    <div className="p-4 sm:p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Lead Management</h1>
          <p className="text-sm text-muted-foreground mt-0.5 tabular-nums">{totalLeads.toLocaleString()} lead{totalLeads !== 1 ? "s" : ""}</p>
        </div>
        {canAddLead && (
          <Button onClick={() => setAddOpen(true)} className="bg-primary hover:bg-primary/90 text-white text-sm h-9"
            data-testid="btn-add-lead-manual">
            <Plus className="w-4 h-4 mr-1" /> Add Lead
          </Button>
        )}
      </div>

      {/* Pipeline KPI strip — the funnel at a glance (matches the Dashboard cards) */}
      <div className="-mx-4 sm:mx-0 px-4 sm:px-0 flex gap-2.5 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" data-testid="leads-kpi">
        <KpiTile className="w-[124px]" label="Prospect" value={bs.prospect ?? 0} tone="text-foreground" icon={Target} chip="bg-secondary" accent="bg-muted-foreground/40" />
        <KpiTile className="w-[124px]" label="Interested" value={bs.interested ?? 0} tone="text-sky-400" icon={Star} chip="bg-sky-500/15" accent="bg-sky-500" />
        <KpiTile className="w-[124px]" label="Follow-up" value={bs.follow_up ?? 0} tone="text-yellow-400" icon={Calendar} chip="bg-yellow-500/15" accent="bg-yellow-500" />
        <KpiTile className="w-[124px]" label="Sold" value={bs.sold ?? 0} tone="text-emerald-400" icon={DollarSign} chip="bg-emerald-500/15" accent="bg-emerald-500" />
      </div>

      <div className="flex flex-col lg:flex-row gap-5">
        {/* Filter rail — saved views (status) + location */}
        <aside className="lg:w-52 lg:flex-shrink-0 space-y-5">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2 px-1">Views</div>
            <div className="flex flex-wrap lg:flex-col gap-1" data-testid="filter-lead-status">
              {["all", ...LEAD_STATUSES].map(s => {
                const active = filterStatus === s;
                const accent = STATUS_ACCENT[s];
                return (
                  <button key={s} onClick={() => handleStatusChange(s)}
                    className={`flex items-center gap-2 lg:w-full text-left px-2.5 py-1.5 rounded-lg text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                      active
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    }`}>
                    <span className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ background: s === "all" ? (active ? "currentColor" : "#64748b") : accent }} />
                    <span className="truncate">{s === "all" ? "All leads" : STATUS_LABEL[s]}</span>
                    {s === "all" && totalLeads > 0 && (
                      <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{totalLeads.toLocaleString()}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2 px-1">Location</div>
            <div className="grid grid-cols-2 lg:grid-cols-1 gap-2">
              <Select value={filterState} onValueChange={handleStateChange}>
                <SelectTrigger className="bg-secondary border-input text-sm h-9" data-testid="filter-state">
                  <SelectValue placeholder="State" />
                </SelectTrigger>
                <SelectContent className="bg-card border-border">
                  <SelectItem value="all">All states</SelectItem>
                  {states.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={filterCity} onValueChange={handleCityChange}>
                <SelectTrigger className="bg-secondary border-input text-sm h-9" data-testid="filter-city">
                  <SelectValue placeholder="City" />
                </SelectTrigger>
                <SelectContent className="bg-card border-border max-h-64">
                  <SelectItem value="all">All cities</SelectItem>
                  {cities.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </aside>

        {/* Content column */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input value={search} onChange={e => handleSearchChange(e.target.value)}
              placeholder="Search address, city, contact…"
              className="pl-9 pr-9 bg-secondary border-input text-sm h-9 focus-visible:ring-primary/40"
              data-testid="input-search-leads" />
            {(searching || (isFetching && !isLoading)) && (
              <RefreshCw className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground animate-spin" />
            )}
          </div>

      {/* Lead list */}
      {isLoading ? (
        <div className="rounded-xl border border-border bg-card overflow-hidden divide-y divide-border">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="w-9 h-9 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3.5 w-1/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
              <Skeleton className="h-7 w-24 rounded-md" />
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center animate-in fade-in duration-300">
          <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
            <Users className="w-7 h-7 text-primary/70" />
          </div>
          <div className="text-sm font-semibold text-foreground mb-1">
            {totalLeads === 0 ? "No leads yet" : "No leads match this filter"}
          </div>
          <div className="text-xs text-muted-foreground max-w-xs">
            {totalLeads === 0
              ? "Run a City Scan or draw a Scan Area on the Field Map to discover new fiber leads."
              : "Try clearing the search or switching status filters."}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card overflow-hidden divide-y divide-border animate-in fade-in duration-200">
          {filtered.map((lead) => {
            const statusCls = STATUS_COLOR[lead.leadStatus] ?? "bg-secondary text-muted-foreground";
            const accent = STATUS_ACCENT[lead.leadStatus] ?? "#64748b";
            const hot = (lead.leadScore ?? 0) >= 80;
            const speed = lead.maxDownloadMbps ? (lead.maxDownloadMbps >= 1000 ? `${lead.maxDownloadMbps / 1000}G` : `${lead.maxDownloadMbps}M`) : null;
            const initial = ((lead.contactName?.trim()?.[0]) ?? (lead.address?.trim()?.[0]) ?? "?").toUpperCase();

            return (
              <div
                key={lead.id}
                data-testid={`card-lead-${lead.id}`}
                className="group flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 hover:bg-muted/50 transition-colors"
              >
                {/* Identity — first-letter avatar tinted by status + address.
                    Tapping opens the property record (Attio/Mailchimp row→detail
                    pattern) so the list is never a dead end for a rep. */}
                <button
                  onClick={() => navigate(`/lead/${lead.id}`)}
                  data-testid={`open-lead-${lead.id}`}
                  aria-label={`Open ${lead.address}`}
                  className="flex items-center gap-3 flex-1 min-w-0 text-left rounded-lg -m-1 p-1 hover:bg-transparent active:scale-[.99] transition-transform"
                >
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center text-[13px] font-bold flex-shrink-0"
                    style={{ background: `${accent}22`, color: accent }} aria-hidden="true">
                    {initial}
                  </div>
                  <div className="flex-1 min-w-0">
                    {/* Address + badges (fiber status omitted — every lead is new
                        fiber, so the badge was noise on every row). */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-[13px] text-foreground truncate">{lead.address}</span>
                      {speed && <span className="px-1.5 py-[1px] rounded-full text-[10px] font-semibold bg-sky-500/15 text-sky-400 tabular-nums">{speed}</span>}
                      {hot && <span className="px-1.5 py-[1px] rounded-full text-[10px] font-bold bg-orange-500/15 text-orange-400">HOT</span>}
                    </div>
                    {/* Meta row — address/phone only; assignment removed for a
                        cleaner list (managers still assign via the row action). */}
                    <div className="flex items-center gap-2.5 mt-0.5 flex-wrap text-[11px] text-muted-foreground">
                      <span className="tabular-nums">{lead.city}, {lead.state} {lead.zip}</span>
                      {lead.contactPhone && (
                        <span className="flex items-center gap-1 tabular-nums"><Phone className="w-2.5 h-2.5" /> {lead.contactPhone}</span>
                      )}
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 sm:hidden" aria-hidden="true" />
                </button>

                {/* Status + actions — own row on mobile (justify-between), inline on desktop */}
                <div className="flex items-center justify-between sm:justify-end gap-1 flex-shrink-0 pl-12 sm:pl-0">
                  {/* Status pill (always visible) */}
                  <Badge className={`text-[10px] px-2 py-0.5 rounded-full border-0 font-semibold flex-shrink-0 ${statusCls}`}>
                    {STATUS_LABEL[lead.leadStatus]}
                  </Badge>

                  {/* Actions — always tappable on touch; edit/delete reveal on hover on desktop.
                      Reps get a clean read-only list here (they knock via the Field
                      Map, which credits them automatically); logging a knock for a
                      chosen rep is a lead/manager tool. */}
                  <div className="flex items-center gap-0.5 flex-shrink-0">
                    {canAssign && (
                      <Button variant="ghost" size="sm"
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-amber-400 hover:bg-amber-400/10"
                        onClick={() => setKnockLead(lead)} title="Log a door knock"
                        data-testid={`btn-knock-${lead.id}`}>
                        <DoorOpen className="w-4 h-4" />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm"
                      className="h-8 w-8 p-0 text-muted-foreground hover:text-primary hover:bg-primary/10"
                      onClick={() => setIntelLead(lead)} title="Lead intelligence"
                      data-testid={`btn-intel-${lead.id}`}>
                      <BarChart2 className="w-4 h-4" />
                    </Button>
                    {canAssign && (
                      <Button variant="ghost" size="sm"
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-primary hover:bg-primary/10"
                        onClick={() => setAssignLead(lead)} title="Assign rep"
                        data-testid={`btn-assign-${lead.id}`}>
                        <UserCheck className="w-4 h-4" />
                      </Button>
                    )}
                    {canEdit && (
                      <Button variant="ghost" size="sm"
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground md:opacity-0 md:group-hover:opacity-100 transition-opacity"
                        onClick={() => setEditLead(lead)} title="Edit"
                        data-testid={`btn-edit-${lead.id}`}>
                        <Edit2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                    {canDelete && (
                      <Button variant="ghost" size="sm"
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-red-400 hover:bg-red-400/10 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
                        onClick={() => setDeleteId(lead.id)} title="Delete"
                        data-testid={`btn-delete-${lead.id}`}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
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
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs gap-0.5" disabled={page === 0} onClick={() => setPage(p => p - 1)}><ChevronLeft className="w-3.5 h-3.5" /> Prev</Button>
            <span className="text-xs text-muted-foreground px-2">{page + 1} / {totalPages}</span>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs gap-0.5" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next <ChevronRight className="w-3.5 h-3.5" /></Button>
          </div>
        </div>
      )}
        </div>
      </div>

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
