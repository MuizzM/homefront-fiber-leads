import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import {
  Users, Search, Plus, Edit2, Trash2, Phone,
  DoorOpen, UserCheck, CalendarClock, Zap, Home, PhoneOff,
  Wifi, WifiOff, Building2, DollarSign, Map as MapIcon, Info,
  RefreshCw, ShieldCheck, ShieldX, User, Mail, ChevronLeft, ChevronRight,
  X, AlertTriangle, CheckCircle2, MapPin,
  Clock3, ArrowUpRight, Navigation, SlidersHorizontal, CircleDot
} from "lucide-react";
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
import { FIELD_OUTCOMES, makeClientId, OUTCOME_META, pinDisplayState, STATE_LABELS } from "@shared/knock";
import { useCan } from "@/lib/capabilities";

// ── Constants ─────────────────────────────────────────────────────────────────
const LEAD_STATUSES = ["prospect", "contacted", "interested", "sold", "not_interested", "follow_up"];

// Display label for a lead row honoring the lastOutcome disambiguator —
// "already a customer" is STORED as not_interested + lastOutcome=already_customer,
// and raw STATUS_LABEL[leadStatus] rendered it as "Not Interested" (field report).
function leadStateLabel(lead: { leadStatus: string; lastOutcome?: string | null }): string {
  try { return STATE_LABELS[pinDisplayState({ leadStatus: lead.leadStatus, visited: true, lastOutcome: lead.lastOutcome ?? null })]; }
  catch { return STATUS_LABEL[lead.leadStatus] ?? lead.leadStatus; }
}

const STATUS_LABEL: Record<string, string> = {
  prospect: "Prospect",
  contacted: "Contacted",
  interested: "Interested",
  sold: "Sold",
  not_interested: "Not Interested",
  follow_up: "Follow Up",
};

// ONE status color language — the SALES RABBIT palette, matched to the map's
// STATE_COLORS / PIN_COLORS so a status looks identical on the list and the map:
// Prospect RED, Contacted slate, Interested purple, Sold green, Not Interested
// black/charcoal (dead), Follow-up orange. Each hue uses the LeadCard light/dark
// pairing (-600 on a /10 tint in light, -400 on /15 in dark) so chips clear AA
// in BOTH themes; the generic "good" green rides the semantic success token.
const STATUS_COLOR: Record<string, string> = {
  prospect:      "bg-red-500/10 text-red-600 dark:bg-red-500/15 dark:text-red-400",
  contacted:     "bg-slate-500/10 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300",
  interested:    "bg-violet-500/10 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400",
  sold:          "bg-success/10 text-success",
  not_interested:"bg-slate-600/15 text-slate-700 dark:bg-slate-700/40 dark:text-slate-300",
  follow_up:     "bg-orange-500/10 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400",
};

const OUTCOME_ICONS: Record<string, React.ElementType> = {
  not_home:       PhoneOff,
  // Audit fix: these two were inverted/generic — a hard "no" reads as an X,
  // while "already a customer" is the one that gets the person-check glyph.
  not_interested: X,
  already_customer: UserCheck,
  interested:     Zap,
  callback:       CalendarClock,
  sold:           Zap,
};

const OUTCOME_COLORS: Record<string, string> = {
  not_home:      "text-muted-foreground",
  not_interested:"text-red-600 dark:text-red-400",
  interested:    "text-violet-600 dark:text-violet-400",
  callback:      "text-amber-600 dark:text-amber-400",
  sold:          "text-success",
};

// The manager's quick-log uses the SAME one-tap outcome model as the rep's
// OutcomeSheet (needs_verification excluded — it's a system verdict, not a tap).
const KNOCK_GRID = FIELD_OUTCOMES;

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
      <div>
        <div>
          <Label className="text-xs text-muted-foreground">Contact Name</Label>
          <Input value={form.contactName ?? ""} onChange={e => set("contactName", e.target.value)}
            className="bg-secondary border-input mt-1" placeholder="John Smith"
            data-testid="form-contact-name" />
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
      setNotes("");
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
    knockMutation.mutate({
      clientId,
      repId: Number(repId),
      outcome: o.key,
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

        {/* One-tap outcomes use the same shared model as the rep sheet. */}
        <div>
          <Label className="text-xs text-muted-foreground">Outcome — tap to log</Label>
          <div className="grid grid-cols-2 gap-2 mt-1">
            {KNOCK_GRID.map(o => {
              const win = o.key === "sold";
              return (
                <button
                  key={o.key} onClick={() => fire(o)} disabled={knockMutation.isPending}
                  data-testid={`knock-outcome-${o.key}`}
                  className="h-11 rounded-lg font-semibold text-[13px] flex items-center justify-center gap-2 active:scale-95 transition-transform border-2 disabled:opacity-60"
                  style={win
                    ? { background: o.color, color: "#04120d", borderColor: o.color }
                    : { background: `${o.color}1f`, color: "hsl(var(--card-foreground))", borderColor: `${o.color}99` }}
                >
                  {!win && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: o.color }} />}
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>

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
                      <span className={`font-medium ${color}`}>{OUTCOME_META[k.outcome as keyof typeof OUTCOME_META]?.label ?? k.outcome.replace(/_/g, " ")}</span>
                      <span className="text-muted-foreground ml-1">· {repName}</span>
                      {k.callbackDate && <span className="text-amber-600 dark:text-amber-400 ml-1">Callback {k.callbackDate}</span>}
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
    // HONESTY FIX: silent failure — a server rejection used to say nothing.
    onError: (e: any) => toast({ title: "Assign failed", description: String(e?.message ?? "Request failed"), variant: "destructive" }),
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


// ── Intelligence Panel (Side Sheet) ──────────────────────────────────────────
type EnrichmentData = {
  ownerName: string | null;
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

type LeadHistoryItem = {
  id: string;
  type: "status_change" | "assignment" | "note";
  actor: string | null;
  changedAt: string;
  status?: string;
  assignedTo?: string;
  assignedBy?: string;
  notePreview?: string;
};

const ONBOARDING_STAGE_LABEL: Record<string, string> = {
  invited: "Invited",
  under_review: "Needs review",
  approved: "Approved",
  login_code_sent: "Login sent",
  agreements_issued: "Awaiting signatures",
  partially_signed: "Partially signed",
  fully_signed: "Fully signed",
  active: "Active",
  rejected: "Rejected",
  failed: "Delivery failed",
};

function IntelligencePanel({ lead, open, onClose, canEdit, team = [], canAssign = false, onboardingStage, onAssign, onEdit, onQualify }: {
  lead: Lead;
  open: boolean;
  onClose: () => void;
  canEdit: boolean;
  team?: TeamMember[];
  canAssign?: boolean;
  onboardingStage?: string | null;
  onAssign?: () => void;
  onEdit?: () => void;
  onQualify?: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editContact, setEditContact] = useState(false);
  const [ownerEmail, setOwnerEmail] = useState(lead.ownerEmail ?? "");
  const canOpenCalling = useCan("calling.lead.read");

  const { data: detail } = useQuery<Lead>({
    queryKey: [`/api/leads/${lead.id}`],
    queryFn: async () => (await apiRequest("GET", `/api/leads/${lead.id}`)).json(),
    enabled: open,
    staleTime: 30_000,
  });

  const { data: history = [], isLoading: historyLoading } = useQuery<LeadHistoryItem[]>({
    queryKey: [`/api/leads/${lead.id}/history`],
    queryFn: async () => (await apiRequest("GET", `/api/leads/${lead.id}/history`)).json(),
    enabled: open,
    staleTime: 15_000,
  });
  const current = detail ?? lead;
  const assignedRep = team.find(member => member.id === current.assignedRepId);
  const directions = current.lat != null && current.lng != null
    ? `https://www.google.com/maps/dir/?api=1&destination=${current.lat},${current.lng}`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${current.address}, ${current.city}, ${current.state} ${current.zip}`)}`;

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
      const res = await apiRequest("PATCH", `/api/leads/${lead.id}/enrichment`, { ownerEmail });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Contact saved" });
      qc.invalidateQueries({ queryKey: ["/api/leads", lead.id, "enrichment"] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      setEditContact(false);
    },
    // HONESTY FIX: silent failure — now surfaces the rejection.
    onError: (e: any) => toast({ title: "Contact not saved", description: String(e?.message ?? "Request failed"), variant: "destructive" }),
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
      <SheetContent className="bg-card border-border text-foreground w-full sm:max-w-xl overflow-y-auto p-0">
        <SheetHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur border-b border-border px-5 py-4 text-left">
          <button type="button" onClick={onClose} aria-label="Close lead details" className="absolute right-4 top-4 z-20 w-8 h-8 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
            <X className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2 pr-8">
            <Badge className={`text-2xs px-2 py-0.5 rounded-full border-0 font-semibold ${STATUS_COLOR[current.leadStatus] ?? "bg-secondary text-muted-foreground"}`}>
              {leadStateLabel(current)}
            </Badge>
            {(current.leadScore ?? 0) >= 80 && <Badge className="border-0 bg-orange-500/10 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400 text-2xs">High priority</Badge>}
          </div>
          <SheetTitle className="text-lg font-semibold tracking-tight mt-2">{current.address}</SheetTitle>
          <p className="text-xs text-muted-foreground">{current.city}, {current.state} {current.zip}</p>
        </SheetHeader>

        <div className="px-5 py-4 border-b border-border grid grid-cols-2 sm:grid-cols-4 gap-2">
          {canOpenCalling && (
            <Link href={`/calling/lead/${current.id}`} onClick={onClose} className="h-9 rounded-md bg-primary text-primary-foreground text-xs font-semibold flex items-center justify-center gap-1.5">
              <Phone className="w-3.5 h-3.5" /> Calling
            </Link>
          )}
          <a href={directions} target="_blank" rel="noreferrer" className="h-9 rounded-md border border-border bg-background text-xs font-semibold flex items-center justify-center gap-1.5 hover:bg-muted">
            <Navigation className="w-3.5 h-3.5" /> Navigate
          </a>
          {canAssign && <button onClick={onAssign} className="h-9 rounded-md border border-border bg-background text-xs font-semibold flex items-center justify-center gap-1.5 hover:bg-muted"><UserCheck className="w-3.5 h-3.5" />{current.assignedRepId ? "Reassign" : "Assign"}</button>}
          {canEdit && current.leadStatus !== "interested" && current.leadStatus !== "sold" && <button onClick={onQualify} className="h-9 rounded-md border border-success/30 bg-success/10 text-success text-xs font-semibold flex items-center justify-center gap-1.5 hover:bg-success/15"><CheckCircle2 className="w-3.5 h-3.5" /> Qualify</button>}
        </div>

        <div className="px-5 py-5">
          <div className="grid grid-cols-2 gap-3 mb-5">
            <div className="rounded-lg border border-border bg-background px-3 py-2.5">
              <div className="text-2xs uppercase tracking-wider text-muted-foreground font-semibold">Assigned rep</div>
              <div className="text-sm font-medium mt-1">{assignedRep?.name ?? (current.assignedRepId ? `Rep #${current.assignedRepId}` : "Unassigned")}</div>
              {onboardingStage && <div className="text-2xs text-primary mt-1">Onboarding · {ONBOARDING_STAGE_LABEL[onboardingStage] ?? onboardingStage.replace(/_/g, " ")}</div>}
            </div>
            <div className="rounded-lg border border-border bg-background px-3 py-2.5">
              <div className="text-2xs uppercase tracking-wider text-muted-foreground font-semibold">Territory</div>
              <div className="text-sm font-medium mt-1">{current.city}, {current.state}</div>
            </div>
          </div>

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
            <Building2 className="w-3.5 h-3.5 text-warning" />
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
            <div className="bg-success/10 border border-success/20 rounded-lg px-3 py-3 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-success" />
              <span className="text-xs text-success font-medium">No competitor ISP detected at this address</span>
            </div>
          )}
        </div>

        <Separator className="my-3 bg-border/50" />

        {/* Neighborhood Income Section */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="w-3.5 h-3.5 text-success" />
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
            <MapIcon className="w-3 h-3" /> Source: US Census ACS 5-Year Estimates (ZIP-level, free)
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
              <InfoRow icon={Mail} label="Email"
                value={lead.ownerEmail ?? <span className="text-muted-foreground italic text-xs">Not on file</span>} />
            </div>
          )}
          <p className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1">
            <MapIcon className="w-3 h-3" /> Owner name: public GIS records
          </p>
          {canOpenCalling && (
            <Link href={`/calling/lead/${lead.id}`} onClick={onClose} className="mt-2 flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-primary/30 bg-primary/10 text-xs font-semibold text-primary">
              <Phone className="h-3.5 w-3.5" /> Open licensed, compliance-gated Calling
            </Link>
          )}
        </div>

        <Separator className="my-4 bg-border/50" />

        <div className="mb-5">
          <div className="flex items-center gap-2 mb-3">
            <Clock3 className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Activity history</span>
          </div>
          {historyLoading ? (
            <div className="space-y-3"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
          ) : history.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-xs text-muted-foreground">No operational activity has been logged yet.</div>
          ) : (
            <div className="relative ml-1 space-y-0 before:absolute before:left-[6px] before:top-2 before:bottom-2 before:w-px before:bg-border">
              {history.slice(0, 12).map(item => (
                <div key={item.id} className="relative pl-6 py-2.5">
                  <span className="absolute left-0 top-[15px] w-[13px] h-[13px] rounded-full border-2 border-card bg-primary" />
                  <div className="text-xs font-medium text-foreground">
                    {item.type === "status_change" ? `Status changed to ${(item.status ?? "updated").replace(/_/g, " ")}` : item.type === "assignment" ? `Assigned to ${item.assignedTo ?? "team"}` : "Note added"}
                  </div>
                  {item.notePreview && <div className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{item.notePreview}</div>}
                  <div className="text-2xs text-muted-foreground mt-1">{item.actor ?? item.assignedBy ?? "System"} · {new Date(item.changedAt).toLocaleString()}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {canEdit && (
          <button onClick={onEdit} className="w-full h-9 rounded-md border border-border bg-background text-xs font-semibold flex items-center justify-center gap-1.5 hover:bg-muted">
            <Edit2 className="w-3.5 h-3.5" /> Edit full lead record
          </button>
        )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
const formatActivity = (value: string | null | undefined) => {
  if (!value) return "No activity";
  const ms = Date.now() - Date.parse(value);
  if (!Number.isFinite(ms)) return "Unknown";
  const days = Math.floor(ms / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

const leadSource = (lead: Lead) => lead.dfAddressId ? "Fiber scan" : lead.assignmentSource === "territory-sync" ? "Territory sync" : "Direct intake";

const nextAction = (lead: Lead) => {
  if (!lead.assignedRepId) return { label: "Assign owner", tone: "text-warning" };
  if (lead.leadStatus === "prospect") return { label: "First contact", tone: "text-primary" };
  if (lead.leadStatus === "follow_up") return { label: "Follow up", tone: "text-orange-600 dark:text-orange-400" };
  if (lead.leadStatus === "interested") return { label: "Close sale", tone: "text-success" };
  if (lead.leadStatus === "sold") return { label: "Complete", tone: "text-muted-foreground" };
  // Closed doors ("not interested" and its "already a customer" disambiguation)
  // are non-actionable — labelling them "Review" invited pointless rework.
  try {
    const ds = pinDisplayState({ leadStatus: lead.leadStatus, visited: true, lastOutcome: lead.lastOutcome ?? null });
    if (ds === "already_customer" || ds === "not_interested") return { label: "Closed", tone: "text-muted-foreground" };
  } catch { /* unknown status — fall through to Review */ }
  return { label: "Review", tone: "text-muted-foreground" };
};

function EnterpriseKpi({ label, value, helper, icon: Icon, tone = "text-primary", warning = false }: {
  label: string;
  /** null = the fetch failed — render an honest em-dash, never a fake 0. */
  value: number | null;
  helper: string;
  icon: React.ElementType;
  tone?: string;
  warning?: boolean;
}) {
  return (
    <div className={`min-w-[160px] flex-1 rounded-lg border bg-card px-4 py-3.5 ${warning ? "border-amber-500/30" : "border-border"}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</span>
        <Icon className={`w-4 h-4 ${tone}`} />
      </div>
      <div className="text-2xl font-semibold tracking-tight tabular-nums mt-2" aria-label={value == null ? `${label} unavailable` : undefined}>{value == null ? "—" : value.toLocaleString()}</div>
      <div className="text-[11px] text-muted-foreground mt-1">{helper}</div>
    </div>
  );
}

export default function Leads() {
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterCity, setFilterCity] = useState("all");
  const [filterState, setFilterState] = useState("all");
  const [filterRep, setFilterRep] = useState("all");
  const [filterFiber, setFilterFiber] = useState("all");
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
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
  const canOpenCalling = useCan("calling.lead.read");
  const isRep = user?.role === "rep";

  const [page, setPage] = useState(0);
  const PAGE_SIZE = 100;

  // Debounce search so a query fires once typing pauses, not on every keystroke.
  const debouncedSearch = useDebounce(search, 300);

  const { data: leadsResp, isLoading, isFetching, isError, refetch: refetchLeads } = useQuery<{ leads: Lead[]; total: number; limit: number; offset: number }>({
    queryKey: ["/api/leads", debouncedSearch, filterStatus, filterCity, filterState, filterRep, filterFiber, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (filterStatus !== "all") params.set("status", filterStatus);
      if (filterCity !== "all") params.set("city", filterCity);
      if (filterState !== "all") params.set("state", filterState);
      if (filterRep !== "all") params.set("assignedRepId", filterRep);
      if (filterFiber !== "all") params.set("fiberStatus", filterFiber);
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
  const { data: leadStats, isError: statsError } = useQuery<{
    total: number;
    assigned: number;
    unassigned: number;
    qualified: number;
    stale: number;
    byStatus: Record<string, number>;
    byFiberStatus: Record<string, number>;
    byRep: Record<string, number>;
    byTerritory: Record<string, number>;
  }>({
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
  const { data: onboardingPipeline } = useQuery<{
    records: Array<{ stage: string; account: null | { repId: number | null } }>;
  }>({
    queryKey: ["/api/onboarding/pipeline"],
    queryFn: async () => (await apiRequest("GET", "/api/onboarding/pipeline")).json(),
    enabled: canEdit,
    staleTime: 30_000,
  });
  const onboardingByRep = new Map<number, string>();
  for (const record of onboardingPipeline?.records ?? []) {
    if (record.account?.repId != null) onboardingByRep.set(record.account.repId, record.stage);
  }

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

  // Optimistic-write helper for the paged list cache. The ["/api/leads", ...]
  // prefix also matches per-lead subqueries (["/api/leads", id, "knocks"] etc.),
  // so only entries shaped like the list payload ({ leads, total }) are touched.
  const patchLeadLists = (
    write: (cached: { leads: Lead[]; total: number }) => { leads: Lead[]; total: number },
  ) => {
    const snapshots = qc.getQueriesData({ queryKey: ["/api/leads"] });
    for (const [key, data] of snapshots) {
      const cached = data as { leads?: Lead[]; total?: number } | undefined;
      if (!cached || !Array.isArray(cached.leads)) continue;
      qc.setQueryData(key, { ...cached, ...write({ leads: cached.leads, total: cached.total ?? cached.leads.length }) });
    }
    return snapshots;
  };
  const restoreLeadLists = (snapshots: Array<[readonly unknown[], unknown]> | undefined) => {
    for (const [key, data] of snapshots ?? []) qc.setQueryData(key, data);
  };

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<InsertLead> }) => {
      const res = await apiRequest("PATCH", `/api/leads/${id}`, data);
      return res.json();
    },
    onMutate: async ({ id, data }: { id: number; data: Partial<InsertLead> }) => {
      // Silent optimistic success: the row updates and the editor closes
      // immediately (spec: update immediately and silently). Failures below
      // stay loud — the snapshot restores and an error toast persists.
      await qc.cancelQueries({ queryKey: ["/api/leads"] });
      const snapshots = patchLeadLists(cached => ({
        ...cached,
        leads: cached.leads.map(l => (l.id === id ? { ...l, ...data } as Lead : l)),
      }));
      setEditLead(null);
      return { snapshots };
    },
    onError: (e: any, _vars, ctx) => {
      restoreLeadLists(ctx?.snapshots);
      toast({ title: e?.message ?? "Couldn't update lead", severity: "error" });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/stats"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => { await apiRequest("DELETE", `/api/leads/${id}`); },
    onMutate: async (id: number) => {
      await qc.cancelQueries({ queryKey: ["/api/leads"] });
      const snapshots = patchLeadLists(cached => ({
        leads: cached.leads.filter(l => l.id !== id),
        total: cached.leads.some(l => l.id === id) ? Math.max(0, cached.total - 1) : cached.total,
      }));
      setDeleteId(null);
      toast({ title: "Lead deleted" });
      return { snapshots };
    },
    onError: (_e: any, _id, ctx) => {
      restoreLeadLists(ctx?.snapshots);
      toast({ title: "Couldn't delete lead — restored", variant: "destructive" });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/stats"] });
    },
  });

  // Filtering is now server-side; leads array is already filtered
  const filtered = leads;
  // Reset page when any filter/search changes
  const handleStatusChange = (s: string) => { setFilterStatus(s); setPage(0); };
  const handleSearchChange = (v: string) => { setSearch(v); setPage(0); };
  const searching = search !== debouncedSearch; // typing, query not yet fired
  const handleStateChange = (s: string) => { setFilterState(s); setFilterCity("all"); setPage(0); };
  const handleCityChange = (c: string) => { setFilterCity(c); setPage(0); };
  const handleRepChange = (r: string) => { setFilterRep(r); setPage(0); };
  const handleFiberChange = (f: string) => { setFilterFiber(f); setPage(0); };

  // Active-filter summary — surfaced as dismissible chips so a rep always sees
  // (and can one-tap clear) what's narrowing the list. Pure view over existing
  // filter state; every clear routes through the same setters as the controls.
  const activeFilters = search.trim() !== "" || filterStatus !== "all" || filterState !== "all" || filterCity !== "all" || filterRep !== "all" || filterFiber !== "all";
  const clearAllFilters = () => {
    setSearch(""); setFilterStatus("all"); setFilterState("all"); setFilterCity("all"); setFilterRep("all"); setFilterFiber("all"); setPage(0);
    setMobileFiltersOpen(false);
  };

  const assignmentName = (lead: Lead) => team.find(member => member.id === lead.assignedRepId)?.name ?? (lead.assignedRepId ? `Rep #${lead.assignedRepId}` : "Unassigned");
  const fiberStatuses = Object.keys(leadStats?.byFiberStatus ?? {}).sort();

  return (
    <div className="min-h-full bg-background p-4 sm:p-6 lg:p-7 space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-primary mb-1.5">{isRep ? "Field pipeline" : "Sales operations"}</div>
          <h1 className="text-2xl font-semibold tracking-tight">{isRep ? "My leads" : "Leads command center"}</h1>
          <p className="text-sm text-muted-foreground mt-1">{isRep ? "Work your assigned doors and keep every follow-up moving." : "Qualify, assign, and move every fiber opportunity forward."}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => navigate("/map")} className="h-9 border-border text-sm"><MapIcon className="w-4 h-4 mr-1.5" />Field map</Button>
          {canAddLead && <Button onClick={() => setAddOpen(true)} className="bg-primary hover:bg-primary/90 text-primary-foreground text-sm h-9" data-testid="btn-add-lead-manual"><Plus className="w-4 h-4 mr-1.5" />Add lead</Button>}
        </div>
      </div>

      {isRep && (
        <div className="grid grid-cols-3 gap-2 md:hidden" data-testid="rep-leads-summary">
          <div className="rounded-xl border border-border bg-card p-3"><div className="text-xl font-semibold tabular-nums">{leadStats?.total ?? 0}</div><div className="mt-0.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Assigned</div></div>
          <div className="rounded-xl border border-orange-500/20 bg-card p-3"><div className="text-xl font-semibold tabular-nums text-orange-600 dark:text-orange-400">{bs.follow_up ?? 0}</div><div className="mt-0.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Follow-ups</div></div>
          <div className="rounded-xl border border-violet-500/20 bg-card p-3"><div className="text-xl font-semibold tabular-nums text-violet-600 dark:text-violet-400">{bs.interested ?? 0}</div><div className="mt-0.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Interested</div></div>
        </div>
      )}
      <div className={`${isRep ? "hidden md:flex" : "flex"} gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`} data-testid="leads-kpi">
        <EnterpriseKpi label="Total leads" value={statsError ? null : leadStats?.total ?? 0} helper="All active records" icon={Users} />
        <EnterpriseKpi label="Qualified" value={statsError ? null : leadStats?.qualified ?? 0} helper="Interested or sold" icon={CheckCircle2} tone="text-success" />
        <EnterpriseKpi label="Assigned" value={statsError ? null : leadStats?.assigned ?? 0} helper="Owned by a field rep" icon={UserCheck} tone="text-violet-600 dark:text-violet-400" />
        <EnterpriseKpi label="Unassigned" value={statsError ? null : leadStats?.unassigned ?? 0} helper="Requires an owner" icon={CircleDot} tone="text-warning" warning={!statsError && (leadStats?.unassigned ?? 0) > 0} />
        <EnterpriseKpi label="Stale" value={statsError ? null : leadStats?.stale ?? 0} helper="No activity in 14 days" icon={AlertTriangle} tone="text-rose-600 dark:text-rose-400" warning={!statsError && (leadStats?.stale ?? 0) > 0} />
      </div>

      <section className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
        <div className="px-4 py-3.5 border-b border-border flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Lead pipeline</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5 tabular-nums">{totalLeads.toLocaleString()} records in this view</p>
          </div>
          <div className="hidden sm:flex items-center gap-1 text-[11px] text-muted-foreground"><SlidersHorizontal className="w-3.5 h-3.5" />Filters update the table instantly</div>
        </div>

        <div className="px-4 py-3 border-b border-border bg-background/40 space-y-3">
          <div className="flex flex-col lg:flex-row gap-2.5">
            <div className="relative flex-1 min-w-[240px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input value={search} onChange={e => handleSearchChange(e.target.value)} placeholder="Search address, city, ZIP, or contact" className="pl-9 pr-9 bg-card border-input text-sm h-9" data-testid="input-search-leads" />
              {(searching || (isFetching && !isLoading)) && <RefreshCw className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground animate-spin" />}
            </div>
            <button type="button" onClick={() => setMobileFiltersOpen(open => !open)} aria-expanded={mobileFiltersOpen} className="lg:hidden h-10 rounded-lg border border-border bg-card px-3 text-[12px] font-semibold text-foreground inline-flex items-center justify-center gap-2"><SlidersHorizontal className="w-4 h-4 text-primary" />Filters{activeFilters && <span className="grid min-w-5 h-5 place-items-center rounded-full bg-primary/15 px-1 text-2xs text-primary">On</span>}</button>
            <div className={`${mobileFiltersOpen ? "grid" : "hidden"} grid-cols-2 sm:grid-cols-3 lg:flex gap-2`}>
              {!isRep && <Select value={filterRep} onValueChange={handleRepChange}><SelectTrigger className="h-10 bg-card lg:h-9 lg:w-[150px]"><SelectValue placeholder="Rep" /></SelectTrigger><SelectContent><SelectItem value="all">All reps</SelectItem><SelectItem value="unassigned">Unassigned</SelectItem>{team.filter(m => m.active).map(m => <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>)}</SelectContent></Select>}
              <Select value={filterState} onValueChange={handleStateChange}><SelectTrigger className="h-10 bg-card lg:h-9 lg:w-[115px]" data-testid="filter-state"><SelectValue placeholder="State" /></SelectTrigger><SelectContent><SelectItem value="all">All states</SelectItem>{states.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select>
              <Select value={filterCity} onValueChange={handleCityChange}><SelectTrigger className="h-10 bg-card lg:h-9 lg:w-[145px]" data-testid="filter-city"><SelectValue placeholder="Territory" /></SelectTrigger><SelectContent className="max-h-64"><SelectItem value="all">All territories</SelectItem>{cities.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select>
              <Select value={filterFiber} onValueChange={handleFiberChange}><SelectTrigger className="h-10 bg-card lg:h-9 lg:w-[145px]"><SelectValue placeholder="Fiber status" /></SelectTrigger><SelectContent><SelectItem value="all">All fiber states</SelectItem>{fiberStatuses.map(status => <SelectItem key={status} value={status}>{status.replace(/_/g, " ")}</SelectItem>)}</SelectContent></Select>
            </div>
          </div>

          <div className="flex items-center gap-1 overflow-x-auto pb-0.5" data-testid="filter-lead-status">
            {["all", ...LEAD_STATUSES].map(status => {
              const active = filterStatus === status;
              const count = status === "all" ? (leadStats?.total ?? 0) : (bs[status] ?? 0);
              return <button key={status} onClick={() => handleStatusChange(status)} className={`h-9 px-3 text-[12px] lg:h-7 lg:px-2.5 lg:text-2xs rounded-md font-semibold whitespace-nowrap border transition-colors ${active ? "bg-primary/10 text-primary border-primary/25" : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"}`}>{status === "all" ? "All leads" : STATUS_LABEL[status]} <span className="ml-1 tabular-nums opacity-70">{count}</span></button>;
            })}
            {activeFilters && <button onClick={clearAllFilters} className="h-9 px-3 text-[12px] lg:h-7 lg:px-2 lg:text-2xs ml-auto font-semibold text-muted-foreground hover:text-foreground whitespace-nowrap">Clear filters</button>}
          </div>
        </div>

        {isLoading ? (
          <>
            {/* Desktop: 8-column row skeletons mirroring the real table grid. */}
            <div className="hidden lg:block divide-y divide-border">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="grid grid-cols-[27%_1fr_1fr_1fr_1fr_1fr_1fr_1fr] items-center gap-3 px-4 py-3">
                  {Array.from({ length: 8 }).map((_, j) => <Skeleton key={j} className="h-8" />)}
                </div>
              ))}
            </div>
            {/* Mobile: stacked card skeletons matching the card list. */}
            <div className="lg:hidden space-y-3 px-4 py-4">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
            </div>
          </>
        ) : isError ? (
          <div className="py-16 px-6 text-center"><AlertTriangle className="w-7 h-7 text-rose-600 dark:text-rose-400 mx-auto" /><div className="text-sm font-semibold mt-3">Lead data could not be loaded</div><div className="text-xs text-muted-foreground mt-1">Your filters are preserved. Retry when the connection is restored.</div><Button variant="outline" size="sm" onClick={() => refetchLeads()} className="mt-4 h-8"><RefreshCw className="w-3.5 h-3.5 mr-1.5" />Retry</Button></div>
        ) : filtered.length === 0 ? (
          <div className="py-16 px-6 text-center"><div className="w-11 h-11 rounded-lg bg-primary/10 flex items-center justify-center mx-auto"><Users className="w-5 h-5 text-primary" /></div><div className="text-sm font-semibold mt-3">{activeFilters ? "No leads match this operational view" : "No leads have been added"}</div><div className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">{activeFilters ? "Clear one or more filters to broaden the pipeline." : "Add a lead or run a market scan to start building the pipeline."}</div>{activeFilters && <Button variant="outline" size="sm" onClick={clearAllFilters} className="mt-4 h-8"><X className="w-3.5 h-3.5 mr-1" />Clear filters</Button>}</div>
        ) : (
          <>
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full min-w-[1050px] border-collapse text-left">
                <thead><tr className="border-b border-border bg-muted/20 text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"><th className="px-4 py-2.5 w-[27%]">Lead</th><th className="px-3 py-2.5">Stage</th><th className="px-3 py-2.5">Territory</th><th className="px-3 py-2.5">Assigned to</th><th className="px-3 py-2.5">Qualification</th><th className="px-3 py-2.5">Last activity</th><th className="px-3 py-2.5">Next action</th><th className="px-3 py-2.5 text-right">Actions</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {filtered.map(lead => {
                    const next = nextAction(lead);
                    const stale = Date.now() - Date.parse(lead.updatedAt || lead.createdAt) > 14 * 86_400_000 && !["sold", "not_interested"].includes(lead.leadStatus);
                    return (
                      <tr key={lead.id} data-testid={`card-lead-${lead.id}`} className="group hover:bg-muted/35 transition-colors">
                        <td className="px-4 py-3"><button onClick={() => setIntelLead(lead)} data-testid={`open-lead-${lead.id}`} className="text-left max-w-full"><div className="flex items-center gap-2"><span className="text-[13px] font-semibold text-foreground truncate">{lead.address}</span>{(lead.leadScore ?? 0) >= 80 && <span className="text-2xs font-bold px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400">HIGH</span>}</div><div className="text-[11px] text-muted-foreground mt-0.5">{lead.contactName || "No contact"} · {leadSource(lead)}</div></button></td>
                        <td className="px-3 py-3"><Badge className={`border-0 text-2xs font-semibold ${STATUS_COLOR[lead.leadStatus] ?? "bg-secondary text-muted-foreground"}`}>{leadStateLabel(lead)}</Badge></td>
                        <td className="px-3 py-3"><div className="text-xs font-medium">{lead.city}</div><div className="text-2xs text-muted-foreground">{lead.state} {lead.zip}</div></td>
                        <td className="px-3 py-3"><button onClick={() => canAssign && setAssignLead(lead)} className={`text-xs font-medium ${lead.assignedRepId ? "text-foreground" : "text-warning"}`}>{assignmentName(lead)}</button><div className="text-2xs text-muted-foreground mt-0.5">{lead.assignedRepId && onboardingByRep.get(lead.assignedRepId) ? `Onboarding · ${ONBOARDING_STAGE_LABEL[onboardingByRep.get(lead.assignedRepId)!] ?? onboardingByRep.get(lead.assignedRepId)}` : lead.assignedAt ? formatActivity(lead.assignedAt) : lead.assignedRepId ? "Assigned" : "No assignment"}</div></td>
                        <td className="px-3 py-3"><div className="flex items-center gap-1.5 text-xs font-medium"><Wifi className={`w-3.5 h-3.5 ${lead.isNewFiber ? "text-success" : "text-muted-foreground"}`} />{lead.maxDownloadMbps ? `${lead.maxDownloadMbps.toLocaleString()} Mbps` : lead.fiberStatus.replace(/_/g, " ")}</div><div className="text-2xs text-muted-foreground mt-0.5">Score {lead.leadScore ?? 0}/100</div></td>
                        <td className="px-3 py-3"><div className={`text-xs font-medium ${stale ? "text-rose-600 dark:text-rose-400" : "text-foreground"}`}>{formatActivity(lead.updatedAt || lead.createdAt)}</div><div className="text-2xs text-muted-foreground mt-0.5">Record updated</div></td>
                        <td className="px-3 py-3"><span className={`text-xs font-semibold ${next.tone}`}>{next.label}</span></td>
                        <td className="px-3 py-3">
                          <div className="flex items-center justify-end gap-0.5">
                            {canOpenCalling && <Link href={`/calling/lead/${lead.id}`} title="Open Calling" aria-label="Open Calling" className="w-8 h-8 rounded-md inline-flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-primary"><Phone className="w-3.5 h-3.5" /></Link>}
                            {canAssign && <button onClick={() => setAssignLead(lead)} title="Assign" className="w-8 h-8 rounded-md inline-flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-primary"><UserCheck className="w-3.5 h-3.5" /></button>}
                            <button onClick={() => setIntelLead(lead)} title="Open details" className="w-8 h-8 rounded-md inline-flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-primary"><ArrowUpRight className="w-3.5 h-3.5" /></button>
                            {canEdit && <button onClick={() => setEditLead(lead)} title="Edit" className="w-8 h-8 rounded-md inline-flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground opacity-0 group-hover:opacity-100 focus:opacity-100"><Edit2 className="w-3.5 h-3.5" /></button>}
                            {canDelete && <button onClick={() => setDeleteId(lead.id)} title="Delete" className="w-8 h-8 rounded-md inline-flex items-center justify-center text-muted-foreground hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400 opacity-0 group-hover:opacity-100 focus:opacity-100"><Trash2 className="w-3.5 h-3.5" /></button>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="lg:hidden divide-y divide-border">
              {filtered.map(lead => {
                const directions = lead.lat != null && lead.lng != null
                  ? `https://www.google.com/maps/dir/?api=1&destination=${lead.lat},${lead.lng}`
                  : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${lead.address}, ${lead.city}, ${lead.state} ${lead.zip}`)}`;
                const next = nextAction(lead);
                return (
                  <article key={lead.id} className="render-lazy px-4 py-4" data-testid={`mobile-lead-${lead.id}`}>
                    <button onClick={() => setIntelLead(lead)} className="w-full text-left">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-[15px] font-semibold leading-snug text-foreground">{lead.address}</div>
                          <div className="mt-1 flex items-center gap-1.5 text-[12px] text-muted-foreground"><MapPin className="h-3.5 w-3.5 shrink-0" />{lead.city}, {lead.state} {lead.zip}</div>
                        </div>
                        <Badge className={`shrink-0 border-0 text-2xs ${STATUS_COLOR[lead.leadStatus]}`}>{STATUS_LABEL[lead.leadStatus]}</Badge>
                      </div>
                      <div className="mt-3 grid grid-cols-3 rounded-lg border border-border bg-background/45">
                        <div className="px-2.5 py-2"><div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Priority</div><div className="mt-0.5 text-[12px] font-semibold">{lead.leadScore ?? 0}/100</div></div>
                        <div className="border-x border-border px-2.5 py-2"><div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Activity</div><div className="mt-0.5 truncate text-[12px] font-semibold">{formatActivity(lead.updatedAt || lead.createdAt)}</div></div>
                        <div className="px-2.5 py-2"><div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Next</div><div className={`mt-0.5 truncate text-[12px] font-semibold ${next.tone}`}>{next.label}</div></div>
                      </div>
                    </button>
                    <div className="mt-3 grid grid-cols-3 gap-2">
                      <button onClick={() => setIntelLead(lead)} className="h-11 rounded-lg bg-primary text-[12px] font-semibold text-primary-foreground inline-flex items-center justify-center gap-1.5"><ArrowUpRight className="h-4 w-4" />Open</button>
                      {canOpenCalling ? <Link href={`/calling/lead/${lead.id}`} className="h-11 rounded-lg border border-border bg-background text-[12px] font-semibold inline-flex items-center justify-center gap-1.5"><Phone className="h-4 w-4 text-primary" />Calling</Link> : <span className="h-11 rounded-lg border border-border bg-muted/40 text-[12px] font-semibold text-muted-foreground inline-flex items-center justify-center gap-1.5"><Phone className="h-4 w-4" />Protected</span>}
                      <a href={directions} target="_blank" rel="noreferrer" className="h-11 rounded-lg border border-border bg-background text-[12px] font-semibold inline-flex items-center justify-center gap-1.5"><Navigation className="h-4 w-4 text-primary" />Route</a>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}

        {!isLoading && !isError && filtered.length > 0 && <div className="px-4 py-3 border-t border-border flex items-center justify-between gap-3"><span className="text-[11px] text-muted-foreground tabular-nums">Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, totalLeads)} of {totalLeads.toLocaleString()}</span><div className="flex items-center gap-1"><Button size="sm" variant="outline" className="h-9 px-3 text-[12px] lg:h-7 lg:px-2 lg:text-xs" disabled={page === 0} onClick={() => setPage(p => p - 1)}><ChevronLeft className="w-3.5 h-3.5" />Prev</Button><span className="text-[11px] text-muted-foreground px-2">Page {page + 1} of {Math.max(totalPages, 1)}</span><Button size="sm" variant="outline" className="h-9 px-3 text-[12px] lg:h-7 lg:px-2 lg:text-xs" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next<ChevronRight className="w-3.5 h-3.5" /></Button></div></div>}
      </section>

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
          canAssign={canAssign}
          team={team}
          onboardingStage={intelLead.assignedRepId ? onboardingByRep.get(intelLead.assignedRepId) ?? null : null}
          onAssign={() => { setAssignLead(intelLead); setIntelLead(null); }}
          onEdit={() => { setEditLead(intelLead); setIntelLead(null); }}
          onQualify={() => updateMutation.mutate({ id: intelLead.id, data: { leadStatus: "interested" } })}
        />
      )}
    </div>
  );
}
