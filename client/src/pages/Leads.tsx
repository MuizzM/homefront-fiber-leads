import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient, keepPreviousData, type QueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  LEADS_PAGE_SIZE, isLeadsListKey, leadMatchesListFilters, leadsListQueryOptions,
  upsertLeadIntoLists, type LeadListItem, type LeadsListResponse,
} from "@/lib/leadsListQuery";
import { WATCHLIST_QUERY, type WatchlistItem } from "@/components/fiber/ComingSoonWatchlist";
import { useIsDesktop } from "@/hooks/use-mobile";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { Phone, UserCheck, Zap, Home, Wifi, WifiOff, DollarSign, Info, RefreshCw, ShieldX, User, Mail, ChevronLeft, ChevronRight, X, ArrowUpRight, Navigation, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from "@/components/ui/alert-dialog";
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
import { FIELD_OUTCOMES, makeClientId, OUTCOME_META, pinDisplayState, STATE_LABELS, type PinDisplayState } from "@shared/knock";
import { useCan } from "@/lib/capabilities";
import { openLeadOnFieldMap } from "@/lib/leadMapNavigation";
import { consumeLeadsFilterHandoff } from "@/lib/leadsFilterHandoff";

// ── Constants ─────────────────────────────────────────────────────────────────
const LEAD_STATUSES = ["prospect", "contacted", "interested", "sold", "not_interested", "follow_up"];

// A lead changed IN WAYS THE CACHE CAN'T REPRODUCE (update/delete/knock —
// server-derived fields move): every cached PAGE of the list is suspect, so
// mark them stale and let the active one refetch. Creates deliberately do NOT
// come through here anymore — a new row is fully known from the POST response,
// so upsertLeadIntoLists writes it into matching views without a refetch (the
// refetch is what raced a stale in-flight GET and made new leads vanish).
// Deliberately NOT the bare ["/api/leads"] prefix: that also matched
// ["/api/leads", id, "knocks"] / "enrichment", so renaming a lead re-fetched
// the enrichment of whatever lead happened to be open.
function invalidateLeadLists(qc: QueryClient): void {
  void qc.invalidateQueries({ predicate: query => isLeadsListKey(query.queryKey) });
}

// Chip classes keyed by the SAME display state that supplies the label, so a
// door can never wear one status's name in another status's color (a knocked
// prospect labelled "Not Home" used to render in not-interested red because the
// color read raw leadStatus while the label read pinDisplayState). Hues follow
// shared/statusConfig.ts — the canonical map palette: prospect GREEN (the fresh
// pool), not-home yellow, not-interested red, already-a-customer blue — with
// each ink darkened per the ink-on-its-own-tint AA rule in
// docs/DESIGN_SYSTEM.md (-700 on a /10 wash in light, -400 on /15 in dark);
// follow-up/callback ride --warning (work owed) and sold rides --success.
const STATE_CHIP: Record<PinDisplayState, string> = {
  unworked:         "bg-green-600/10 text-green-700 dark:bg-green-500/15 dark:text-green-400",
  not_home:         "bg-yellow-500/10 text-yellow-800 dark:bg-yellow-500/15 dark:text-yellow-400",
  contacted:        "bg-slate-500/10 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300",
  interested:       "bg-violet-500/10 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400",
  follow_up:        "bg-warning/10 text-warning",
  callback:         "bg-warning/10 text-warning",
  sold:             "bg-success/10 text-success",
  not_interested:   "bg-red-500/10 text-red-700 dark:bg-red-500/15 dark:text-red-400",
  already_customer: "bg-blue-600/10 text-blue-700 dark:bg-blue-500/15 dark:text-blue-400",
  // Competition dispositions — same ink-on-its-own-tint recipe, hues per
  // shared/statusConfig.ts (competitor burnt orange, renter warm stone, moving
  // cyan, no-soliciting slate, go-back pink).
  competitor:       "bg-orange-700/10 text-orange-800 dark:bg-orange-600/15 dark:text-orange-400",
  renter:           "bg-stone-500/10 text-stone-600 dark:bg-stone-500/15 dark:text-stone-300",
  moving:           "bg-cyan-600/10 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-400",
  no_soliciting:    "bg-slate-600/10 text-slate-700 dark:bg-slate-500/15 dark:text-slate-300",
  go_back:          "bg-pink-500/10 text-pink-700 dark:bg-pink-500/15 dark:text-pink-400",
};

// Label + chip for a lead row honoring the lastOutcome disambiguator —
// "already a customer" is STORED as not_interested + lastOutcome=already_customer,
// and raw STATUS_LABEL[leadStatus] rendered it as "Not Interested" (field report).
// One derivation feeds both halves of the badge so they cannot disagree.
function leadStateChip(lead: { leadStatus: string; lastOutcome?: string | null }): { label: string; chip: string } {
  try {
    // visited from EVIDENCE (lib/leadDisplay's rule), never hard-coded true —
    // the hard-coded flag labelled every untouched prospect "Contacted".
    const ds = pinDisplayState({ leadStatus: lead.leadStatus, visited: Boolean(lead.lastOutcome), lastOutcome: lead.lastOutcome ?? null });
    return { label: STATE_LABELS[ds], chip: STATE_CHIP[ds] };
  } catch {
    return { label: STATUS_LABEL[lead.leadStatus] ?? lead.leadStatus, chip: STATUS_COLOR[lead.leadStatus] ?? "bg-secondary text-muted-foreground" };
  }
}

const STATUS_LABEL: Record<string, string> = {
  prospect: "Prospect",
  contacted: "Contacted",
  interested: "Interested",
  sold: "Sold",
  not_interested: "Not Interested",
  follow_up: "Follow Up",
};

// Fallback ramp keyed by RAW leadStatus — reached only when pinDisplayState
// throws on a status it doesn't know (see leadStateChip below). The live chip
// palette is STATE_CHIP, which follows shared/statusConfig.ts; this table's
// old claim of matching the map was wrong on its face (the map's prospect pin
// is GREEN #16A34A — red on the map means not interested).
const STATUS_COLOR: Record<string, string> = {
  prospect:      "bg-green-600/10 text-green-700 dark:bg-green-500/15 dark:text-green-400",
  contacted:     "bg-slate-500/10 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300",
  interested:    "bg-violet-500/10 text-violet-600 dark:bg-violet-500/15 dark:text-violet-400",
  sold:          "bg-success/10 text-success",
  not_interested:"bg-slate-600/15 text-slate-700 dark:bg-slate-700/40 dark:text-slate-300",
  // Measured on the running app at 3.56:1, not the AA the comment above claims:
  // `-600 on a /10 tint` was checked against WHITE, but the chip puts the ink on
  // a 10% wash of ITSELF, which is darker. Follow-up means work owed, which is
  // exactly what --warning is for, and that token is tuned to clear AA on white,
  // on /10 and on /15 (docs/DESIGN_SYSTEM.md).
  follow_up:     "bg-warning/10 text-warning",
};


const OUTCOME_COLORS: Record<string, string> = {
  not_home:      "text-muted-foreground",
  not_interested:"text-destructive",
  interested:    "text-violet-600 dark:text-violet-400",
  callback:      "text-warning",
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
    // NO fiberStatus: the form has no field for it, and sending one is fatal
    // on create — POST /api/leads hard-rejects any client-supplied "new_fiber"
    // as a forged fresh-fiber claim (the old `?? "new_fiber"` default made
    // EVERY manual add from this dialog 400 — witnessed live 2026-08-08).
    // PATCH ignores the field entirely (not in its allowlist), so omitting it
    // also preserves the existing status on edit, as the old comment intended.
    leadStatus: initial?.leadStatus ?? "prospect",
    contactName: initial?.contactName ?? "",
    contactEmail: initial?.contactEmail ?? "",
    notes: initial?.notes ?? "",
  });

  const set = (k: keyof InsertLead, v: string) => { setForm(f => ({ ...f, [k]: v })); setFormError(null); };
  const [formError, setFormError] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label htmlFor="form-address" className="text-xs text-muted-foreground">Street address *</Label>
          <Input id="form-address" value={form.address} onChange={e => set("address", e.target.value)}
            className="bg-secondary border-input mt-1" placeholder="123 Main St"
            data-testid="form-address" />
        </div>
        <div>
          <Label htmlFor="form-city" className="text-xs text-muted-foreground">City *</Label>
          <Input id="form-city" value={form.city} onChange={e => set("city", e.target.value)}
            className="bg-secondary border-input mt-1" placeholder="Rockwell"
            data-testid="form-city" />
        </div>
        <div>
          <Label htmlFor="form-zip" className="text-xs text-muted-foreground">ZIP *</Label>
          <Input id="form-zip" value={form.zip} onChange={e => set("zip", e.target.value)}
            className="bg-secondary border-input mt-1" placeholder="28138"
            data-testid="form-zip" />
        </div>
      </div>
      <div>
        <div>
          <Label htmlFor="form-contact-name" className="text-xs text-muted-foreground">Contact name</Label>
          <Input id="form-contact-name" value={form.contactName ?? ""} onChange={e => set("contactName", e.target.value)}
            className="bg-secondary border-input mt-1" placeholder="John Smith"
            data-testid="form-contact-name" />
        </div>
      </div>
      <div>
        <Label htmlFor="form-lead-status" className="text-xs text-muted-foreground">Lead status</Label>
        <Select value={form.leadStatus} onValueChange={v => set("leadStatus", v)}>
          <SelectTrigger id="form-lead-status" className="bg-secondary border-input mt-1" data-testid="form-lead-status">
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
        <Label htmlFor="form-notes" className="text-xs text-muted-foreground">Notes</Label>
        <Textarea id="form-notes" value={form.notes ?? ""} onChange={e => set("notes", e.target.value)}
          className="bg-secondary border-input mt-1 text-sm" rows={3}
          placeholder="Knocked 7/6, owner interested. Call back Friday."
          data-testid="form-notes" />
      </div>
      {/* Validate on tap instead of a silently-disabled button: a rep who missed
          a field gets a reason next to the action, not a dead button. */}
      {formError && <p className="text-2xs font-medium text-destructive" data-testid="form-error">{formError}</p>}
      <div className="flex gap-2 pt-1">
        <Button variant="outline" onClick={onCancel} className="border-border flex-1">Cancel</Button>
        {/* While the POST is in flight the button says so and stays disabled —
            the form (and everything typed into it) survives a failed save. */}
        <Button onClick={() => {
          if (!form.address?.trim() || !form.city?.trim() || !form.zip?.trim()) {
            setFormError("Street address, city and ZIP are required."); return;
          }
          setFormError(null); onSave(form);
        }} disabled={saving}
          className="bg-primary hover:bg-primary/90 text-primary-foreground flex-1" data-testid="btn-save-lead-form">
          {saving ? (<><RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />Saving lead…</>) : "Save lead"}
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
      invalidateLeadLists(qc);
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
          
          Door Knock - {lead.address}
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
          <Label className="text-xs text-muted-foreground">Outcome - tap to log</Label>
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
                const color = OUTCOME_COLORS[k.outcome] ?? "text-muted-foreground";
                const repName = team.find(m => m.id === k.repId)?.name ?? `Rep #${k.repId}`;
                return (
                  <div key={k.id} className="flex items-start gap-2 text-xs bg-secondary rounded px-2.5 py-1.5">
                    
                    <div className="flex-1 min-w-0">
                      <span className={`font-medium ${color}`}>{OUTCOME_META[k.outcome as keyof typeof OUTCOME_META]?.label ?? k.outcome.replace(/_/g, " ")}</span>
                      <span className="text-muted-foreground ml-1">· {repName}</span>
                      {k.callbackDate && <span className="text-warning ml-1">Callback {k.callbackDate}</span>}
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
      invalidateLeadLists(qc);
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
          className="bg-primary hover:bg-primary/90 text-primary-foreground" data-testid="btn-confirm-assign">
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

  const { data: enrich, isLoading, isError: isEnrichError, refetch, isFetching } = useQuery<EnrichmentData>({
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
      invalidateLeadLists(qc);
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

  const InfoRow = ({ label, value, highlight }: {
    icon: React.ElementType; label: string; value: React.ReactNode; highlight?: boolean;
  }) => (
    <div className="flex items-start gap-3 py-2.5">
      
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
            <Badge className={`text-2xs px-2 py-0.5 rounded-full border-0 font-semibold ${leadStateChip(current).chip}`}>
              {leadStateChip(current).label}
            </Badge>
            {(current.leadScore ?? 0) >= 80 && <Badge className="border-0 bg-warning/10 text-warning text-2xs">High priority</Badge>}
          </div>
          <SheetTitle className="text-lg font-semibold tracking-tight mt-2">{current.address}</SheetTitle>
          <p className="text-xs text-muted-foreground">{current.city}, {current.state} {current.zip}</p>
        </SheetHeader>

        <div className="px-5 py-4 border-b border-border grid grid-cols-2 sm:grid-cols-4 gap-2">
          {canOpenCalling && (
            <Link href={`/calling/lead/${current.id}`} onClick={onClose} className="h-9 rounded-md bg-primary text-primary-foreground text-xs font-semibold flex items-center justify-center gap-1.5">
               Calling
            </Link>
          )}
          <a href={directions} target="_blank" rel="noreferrer" className="h-9 rounded-md border border-border bg-background text-xs font-semibold flex items-center justify-center gap-1.5 hover:bg-muted">
             Navigate
          </a>
          {canAssign && <button onClick={onAssign} className="h-9 rounded-md border border-border bg-background text-xs font-semibold flex items-center justify-center gap-1.5 hover:bg-muted">{current.assignedRepId ? "Reassign" : "Assign"}</button>}
          {canEdit && current.leadStatus !== "interested" && current.leadStatus !== "sold" && <button onClick={onQualify} className="h-9 rounded-md border border-success/30 bg-success/10 text-success text-xs font-semibold flex items-center justify-center gap-1.5 hover:bg-success/15"> Qualify</button>}
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
            
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Competition at This Address</span>
          </div>
          {isLoading ? (
            <div className="bg-secondary/50 rounded-lg px-3 py-4 text-center text-xs text-muted-foreground">Loading...</div>
          ) : isEnrichError ? (
            /* The green "no competitor" panel used to be the FALLTHROUGH branch:
               on a failed enrichment fetch `enrich` is undefined, so
               `enrich?.inCompetitorArea` is falsy and the rep read a confident
               green statement that nobody serves this address - then pitched a
               switch against an incumbent they were never told about. Unknown
               is not "none". */
            <div className="rounded-lg border border-border bg-secondary/50 px-3 py-3" role="alert" data-testid="lead-competition-error">
              <p className="text-xs font-medium text-foreground">Competition is unknown</p>
              <p className="mt-1 text-xs text-muted-foreground">
                This did not load, so it is not a claim that nobody serves this address.
              </p>
              <button
                type="button"
                onClick={() => void refetch()}
                data-testid="lead-competition-retry"
                className="mt-2 min-h-tap text-xs font-semibold text-primary underline"
              >
                Retry
              </button>
            </div>
          ) : enrich?.inCompetitorArea ? (
            <div className="bg-secondary/50 rounded-lg px-3 py-1 divide-y divide-border/50">
              <InfoRow icon={ShieldX} label="Competitor ISP" value={enrich.competitorName ?? "Unknown"} />
              {enrich.competitorSpeedMbps && <InfoRow icon={Zap} label="Their Speed" value={`${enrich.competitorSpeedMbps} Mbps`} />}
              {enrich.competitorTech && <InfoRow icon={Info} label="Their Technology" value={enrich.competitorTech} />}
            </div>
          ) : (
            <div className="bg-success/10 border border-success/20 rounded-lg px-3 py-3 flex items-center gap-2">
              
              <span className="text-xs text-success font-medium">No competitor ISP detected at this address</span>
            </div>
          )}
        </div>

        <Separator className="my-3 bg-border/50" />

        {/* Neighborhood Income Section */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            
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
             Source: US Census ACS 5-Year Estimates (ZIP-level, free)
          </p>
        </div>

        <Separator className="my-3 bg-border/50" />

        {/* Owner / Contact Section */}
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            
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
                className="bg-primary hover:bg-primary/90 text-primary-foreground text-xs h-7 w-full">
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
             Owner name: public GIS records
          </p>
          {canOpenCalling && (
            <Link href={`/calling/lead/${lead.id}`} onClick={onClose} className="mt-2 flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-primary/30 bg-primary/10 text-xs font-semibold text-primary">
               Open licensed, compliance-gated Calling
            </Link>
          )}
        </div>

        <Separator className="my-4 bg-border/50" />

        <div className="mb-5">
          <div className="flex items-center gap-2 mb-3">
            
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
             Edit full lead record
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
  if (lead.leadStatus === "follow_up") return { label: "Follow up", tone: "text-warning" };
  if (lead.leadStatus === "interested") return { label: "Close sale", tone: "text-success" };
  if (lead.leadStatus === "sold") return { label: "Complete", tone: "text-muted-foreground" };
  // Closed doors ("not interested" and its "already a customer" disambiguation)
  // are non-actionable — labelling them "Review" invited pointless rework.
  try {
    const ds = pinDisplayState({ leadStatus: lead.leadStatus, visited: Boolean(lead.lastOutcome), lastOutcome: lead.lastOutcome ?? null });
    if (ds === "already_customer" || ds === "not_interested") return { label: "Closed", tone: "text-muted-foreground" };
  } catch { /* unknown status — fall through to Review */ }
  return { label: "Review", tone: "text-muted-foreground" };
};

// No `icon`/`tone`: same dead weight MetricStrip already shed — both props were
// accepted, threaded from every call site, and rendered by nothing.
function EnterpriseKpi({ label, value, helper, warning = false }: {
  label: string;
  /** null = the fetch failed — render an honest em-dash, never a fake 0. */
  value: number | null;
  helper: string;
  warning?: boolean;
}) {
  return (
    <div className={`min-w-0 rounded-lg border bg-card px-4 py-3.5 ${warning ? "border-amber-500/30" : "border-border"}`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</span>
        
      </div>
      <div className="text-2xl font-semibold tracking-tight tabular-nums mt-2" aria-label={value == null ? `${label} unavailable` : undefined}>{value == null ? " - " : value.toLocaleString()}</div>
      <div className="text-[11px] text-muted-foreground mt-1">{helper}</div>
    </div>
  );
}

// ── List rows ─────────────────────────────────────────────────────────────────
// Both rows are memoised on primitive props (never the Map/array they came
// from), so typing in the search box, opening a dialog or flipping a filter
// re-renders the page shell and leaves all 100 rows exactly as they are.

const LeadTableRow = memo(function LeadTableRow({
  lead, assignedName, onboardingStage, canAssign, canEdit, canDelete, canOpenCalling,
  onOpen, onMap, onAssign, onEdit, onDelete,
}: {
  lead: LeadListItem;
  assignedName: string;
  /** Onboarding stage of this row's assigned rep, if any — resolved by the page. */
  onboardingStage?: string;
  canAssign: boolean;
  canEdit: boolean;
  canDelete: boolean;
  canOpenCalling: boolean;
  onOpen: (lead: Lead) => void;
  onMap: (lead: Lead) => void;
  onAssign: (lead: Lead) => void;
  onEdit: (lead: Lead) => void;
  onDelete: (id: number) => void;
}) {
  const next = nextAction(lead);
  // Negative id = the optimistic row of a save still in flight: visibly
  // provisional, and its actions are held back until the server id exists
  // (opening/editing/deleting a lead the server hasn't confirmed would 404).
  const saving = lead.id < 0;
  const stale = Date.now() - Date.parse(lead.updatedAt || lead.createdAt) > 14 * 86_400_000 && !["sold", "not_interested"].includes(lead.leadStatus);
  return (
    <tr data-testid={`card-lead-${lead.id}`} className={`group hover:bg-muted/35 transition-colors${saving ? " opacity-70" : ""}`}>
      <td className="px-4 py-3"><button onClick={() => !saving && onMap(lead)} data-testid={`lead-map-${lead.id}`} aria-label={`Show ${lead.address} on field map`} className="text-left max-w-full"><div className="flex items-center gap-2"><span className="text-[13px] font-semibold text-foreground truncate" title={lead.address}>{lead.address}</span>{(lead.leadScore ?? 0) >= 80 && <span className="text-2xs font-bold px-1.5 py-0.5 rounded bg-warning/10 text-warning">HIGH</span>}</div><div className="text-[11px] text-muted-foreground mt-0.5">{lead.contactName || "No contact"} · {leadSource(lead)}</div></button></td>
      <td className="px-3 py-3">{(() => { const s = leadStateChip(lead); return <Badge className={`border-0 text-2xs font-semibold ${s.chip}`}>{s.label}</Badge>; })()}</td>
      <td className="px-3 py-3"><div className="text-xs font-medium">{lead.city}</div><div className="text-2xs text-muted-foreground">{lead.state} {lead.zip}</div></td>
      <td className="px-3 py-3"><button onClick={() => !saving && canAssign && onAssign(lead)} className={`text-xs font-medium ${lead.assignedRepId ? "text-foreground" : "text-warning"}`}>{assignedName}</button><div className="text-2xs text-muted-foreground mt-0.5">{onboardingStage ? `Onboarding · ${ONBOARDING_STAGE_LABEL[onboardingStage] ?? onboardingStage}` : lead.assignedAt ? formatActivity(lead.assignedAt) : lead.assignedRepId ? "Assigned" : "No assignment"}</div></td>
      <td className="px-3 py-3"><div className="flex items-center gap-1.5 text-xs font-medium">{lead.maxDownloadMbps ? `${lead.maxDownloadMbps.toLocaleString()} Mbps` : lead.fiberStatus.replace(/_/g, " ")}</div><div className="text-2xs text-muted-foreground mt-0.5">Score {lead.leadScore ?? 0}/100 · {lead.lastScannedAt ? `scanned ${formatActivity(lead.lastScannedAt).toLowerCase()}` : "no scan timestamp"}</div></td>
      <td className="px-3 py-3"><div className={`text-xs font-medium ${stale ? "text-destructive" : "text-foreground"}`}>{formatActivity(lead.updatedAt || lead.createdAt)}</div><div className="text-2xs text-muted-foreground mt-0.5">Record updated</div></td>
      <td className="px-3 py-3"><span className={`text-xs font-semibold ${next.tone}`}>{next.label}</span></td>
      <td className="px-3 py-3">
        {saving ? (
          <div className="flex items-center justify-end gap-1.5 text-2xs font-semibold text-muted-foreground" data-testid={`lead-row-saving-${lead.id}`}>
            <RefreshCw className="w-3 h-3 animate-spin" />Saving…
          </div>
        ) : (
        <div className="flex items-center justify-end gap-0.5">
          <button onClick={() => onMap(lead)} title="Show on Field Map" aria-label={`Show ${lead.address} on field map`} className="w-9 h-9 rounded-md inline-flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-primary"><MapPin className="w-3.5 h-3.5" aria-hidden="true" /></button>
          {canOpenCalling && <Link href={`/calling/lead/${lead.id}`} title="Open Calling" aria-label="Open Calling" className="w-9 h-9 rounded-md inline-flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-primary"><Phone className="w-3.5 h-3.5" /></Link>}
          {canAssign && <button onClick={() => onAssign(lead)} title="Assign" aria-label={`Assign ${lead.address}`} className="w-9 h-9 rounded-md inline-flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-primary"><UserCheck className="w-3.5 h-3.5" aria-hidden="true" /></button>}
          <button onClick={() => onOpen(lead)} title="Open details" aria-label={`Open details for ${lead.address}`} className="w-9 h-9 rounded-md inline-flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-primary"><ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" /></button>
          {/* `reveal-on-hover` rather than `opacity-0 group-hover:opacity-100`:
              this table starts at lg, which an iPad in landscape clears, and a
              hover-only control does not exist on a touch screen. See
              index.css - the fade is scoped to real pointers, and everywhere
              else these are simply always visible. */}
          {canEdit && <button onClick={() => onEdit(lead)} aria-label={`Edit ${lead.address}`} className="reveal-on-hover h-9 rounded-md inline-flex items-center px-2 text-xs font-semibold text-muted-foreground hover:bg-muted hover:text-foreground">Edit</button>}
          {canDelete && <button onClick={() => onDelete(lead.id)} aria-label={`Delete ${lead.address}`} className="reveal-on-hover h-9 rounded-md inline-flex items-center px-2 text-xs font-semibold text-muted-foreground hover:bg-destructive/10 hover:text-destructive">Delete</button>}
        </div>
        )}
      </td>
    </tr>
  );
});

const LeadMobileCard = memo(function LeadMobileCard({ lead, canOpenCalling, onOpen, onMap }: {
  lead: LeadListItem;
  canOpenCalling: boolean;
  onOpen: (lead: Lead) => void;
  onMap: (lead: Lead) => void;
}) {
  const directions = lead.lat != null && lead.lng != null
    ? `https://www.google.com/maps/dir/?api=1&destination=${lead.lat},${lead.lng}`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${lead.address}, ${lead.city}, ${lead.state} ${lead.zip}`)}`;
  const next = nextAction(lead);
  // Same provisional treatment as the desktop row: a save still in flight is
  // visible but not actionable until the server id exists.
  const saving = lead.id < 0;
  // Compact two-line row, not a card: the old layout spent ~200px per lead on a
  // Priority/Activity/Next table that read identically down the whole page plus
  // a three-button bar, so a rep scrolling 76k leads saw 2-3 at a time. The row
  // keeps every signal that varies per lead (status, next action, recency, the
  // HIGH marker) inline and moves the rest behind the tap; Calling and Route
  // stay as 44px trailing icon buttons so field use loses nothing.
  return (
    <article className={`render-lazy flex items-center gap-1 py-1.5 pl-4 pr-2 transition-colors active:bg-secondary/50${saving ? " opacity-70" : ""}`} data-testid={`mobile-lead-${lead.id}`}>
      <button onClick={() => !saving && onOpen(lead)} aria-label={`Open details for ${lead.address}`} className="min-h-tap min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <div className="flex items-center gap-2">
          <span className="truncate text-[14px] font-semibold leading-snug text-foreground">{lead.address}</span>
          {(lead.leadScore ?? 0) >= 80 && <span className="shrink-0 rounded bg-warning/10 px-1.5 py-0.5 text-2xs font-bold text-warning">HIGH</span>}
          {/* leadStateChip, NOT the raw lookup: "already a customer" is stored
              as not_interested + lastOutcome, and the raw label showed those
              doors as "Not Interested" — the exact field-reported bug the
              desktop grid and drawer already fixed. */}
          {(() => { const s = leadStateChip(lead); return <Badge className={`ml-auto shrink-0 border-0 text-2xs ${s.chip}`}>{s.label}</Badge>; })()}
        </div>
        <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-[12px] text-muted-foreground">
          <span className="truncate">{lead.city}, {lead.state} {lead.zip}</span>
          <span aria-hidden="true">·</span>
          <span className={`shrink-0 font-semibold ${next.tone}`}>{next.label}</span>
          <span className="ml-auto shrink-0 pl-2 text-[11px]">{formatActivity(lead.updatedAt || lead.createdAt)}</span>
        </div>
      </button>
      {saving ? (
        <div className="flex shrink-0 items-center gap-1.5 px-2 text-2xs font-semibold text-muted-foreground" data-testid={`lead-row-saving-${lead.id}`}>
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />Saving…
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-1.5">
          <button onClick={() => onMap(lead)} data-testid={`lead-map-${lead.id}`} title="Show on field map" aria-label={`Show ${lead.address} on field map`} className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><MapPin className="h-4 w-4" aria-hidden="true" /></button>
          {canOpenCalling && <Link href={`/calling/lead/${lead.id}`} title="Open Calling" aria-label={`Open Calling for ${lead.address}`} className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Phone className="h-4 w-4" aria-hidden="true" /></Link>}
          <a href={directions} target="_blank" rel="noreferrer" title="Route" aria-label={`Route to ${lead.address}`} className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Navigation className="h-4 w-4" aria-hidden="true" /></a>
        </div>
      )}
    </article>
  );
});

export default function Leads() {
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterCity, setFilterCity] = useState("all");
  const [filterState, setFilterState] = useState("all");
  const [filterRep, setFilterRep] = useState("all");
  const [filterFiber, setFilterFiber] = useState("all");
  const [scanWindow, setScanWindow] = useState<"all" | "24h" | "7d" | "30d">("all");
  const [sortMode, setSortMode] = useState<"created_desc" | "scanned_desc">("created_desc");
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
  const PAGE_SIZE = LEADS_PAGE_SIZE;

  // Debounce search so a query fires once typing pauses, not on every keystroke.
  const debouncedSearch = useDebounce(search, 300);

  // Key + fetcher come from the shared builder so the route warm (which fires
  // before this page mounts) lands on exactly this entry, and the mutation
  // invalidations recognise it.
  const { data: leadsResp, isLoading, isFetching, isError, refetch: refetchLeads } = useQuery<LeadsListResponse>({
    ...leadsListQueryOptions({
      search: debouncedSearch,
      status: filterStatus,
      city: filterCity,
      state: filterState,
      rep: filterRep,
      fiber: filterFiber,
      scanWindow,
      sort: sortMode,
      page,
    }),
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
  const canSeeScanOps = user?.role === "admin" || user?.role === "manager";
  const { data: comingSoonWatchlist } = useQuery<WatchlistItem[] | null>({
    ...WATCHLIST_QUERY,
    enabled: canSeeScanOps,
  });
  const activeComingSoon = (comingSoonWatchlist ?? []).filter(item => item.status === "active" || item.status == null);
  const hotComingSoon = activeComingSoon.filter(item => item.urgency === "hot").length;

  // Distinct states + cities for the dropdowns (cities scoped to the chosen
  // state). Memoised: this is a Set-dedup + sort over every facet row, and it
  // has no business re-running on each keystroke in the search box.
  const states = useMemo(
    () => Array.from(new Set(facets.map(f => f.state).filter(Boolean))).sort(),
    [facets],
  );
  const cities = useMemo(() => Array.from(new Set(
    facets.filter(f => filterState === "all" || f.state === filterState).map(f => f.city).filter(Boolean)
  )).sort(), [facets, filterState]);

  const { data: team = [] } = useQuery<TeamMember[]>({ queryKey: ["/api/team"] });
  const { data: onboardingPipeline } = useQuery<{
    records: Array<{ stage: string; account: null | { repId: number | null } }>;
  }>({
    queryKey: ["/api/onboarding/pipeline"],
    queryFn: async () => (await apiRequest("GET", "/api/onboarding/pipeline")).json(),
    enabled: canEdit,
    staleTime: 30_000,
  });
  const onboardingByRep = useMemo(() => {
    const byRep = new Map<number, string>();
    for (const record of onboardingPipeline?.records ?? []) {
      if (record.account?.repId != null) byRep.set(record.account.repId, record.stage);
    }
    return byRep;
  }, [onboardingPipeline]);

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

  // One in-flight create at a time: the ref flips synchronously on the first
  // click, so a double-tap in the same frame can't POST twice (isPending only
  // updates after a microtask). The server's canonical-address dedupe stays as
  // the backstop for anything that slips past.
  const createInFlight = useRef(false);
  // Dialog generation: Escape is allowed mid-save, and the user may re-open
  // the dialog and start typing a DIFFERENT lead while the first save is
  // still in flight. The delayed setAddOpen(false) may only close the dialog
  // session it belongs to — closing a newer one would wipe a form mid-entry.
  const dialogGen = useRef(0);
  const openAddDialog = () => { dialogGen.current++; setAddOpen(true); };
  const submitCreate = (data: Partial<InsertLead>) => {
    if (createInFlight.current) return;
    createInFlight.current = true;
    createMutation.mutate(data);
  };

  const createMutation = useMutation({
    mutationFn: async (data: Partial<InsertLead>) => {
      const res = await apiRequest("POST", "/api/leads", data);
      return res.json();
    },
    onMutate: async (data: Partial<InsertLead>) => {
      // Cancel LIST fetches only (per-lead subqueries are unrelated): an
      // in-flight page that resolved after this write would repaint pre-create
      // rows over the optimistic one.
      await qc.cancelQueries({ predicate: q => isLeadsListKey(q.queryKey) });
      const snapshots = qc.getQueriesData({ predicate: q => isLeadsListKey(q.queryKey) });
      // Negative temp id keys the optimistic row and can never collide with a
      // real (positive) server id. Timestamps make "Last activity" read Today
      // instead of Unknown. The row lands ONLY in cached views whose filters
      // it matches — painting it into every view was what made it appear in a
      // filtered list and then vanish on the next fetch.
      const now = new Date().toISOString();
      const tempId = -Date.now();
      upsertLeadIntoLists(qc, {
        // fiberStatus mirrors the column default — the form doesn't send one,
        // and the row renderer calls .replace() on it.
        id: tempId, assignedRepId: null, lastOutcome: null, leadScore: 0,
        fiberStatus: "unknown", createdAt: now, updatedAt: now, ...data,
      } as Lead);
      // The dialog stays open showing "Saving lead…" — it closes when the
      // server confirms, and a failure hands the intact form back.
      const view = {
        search: debouncedSearch, status: filterStatus, city: filterCity,
        state: filterState, rep: filterRep, fiber: filterFiber,
        scanWindow, sort: sortMode, page,
      };
      return { snapshots, tempId, view, gen: dialogGen.current };
    },
    onSuccess: async (lead: any, vars, ctx) => {
      if (lead?.existed === true) {
        // The address already had a lead — the server returned the existing
        // row instead of creating one (possibly ADOPTING it: an FCC ghost gets
        // retagged and assigned server-side). Withdraw the temp row and let
        // the lists refetch canonical state; leaving the temp would show the
        // same door twice until a refetch silently ate one ("duplicate then
        // it vanished").
        restoreLeadLists(ctx?.snapshots);
        if (ctx?.gen === dialogGen.current) setAddOpen(false);
        void qc.invalidateQueries({ predicate: q => isLeadsListKey(q.queryKey) });
        toast({
          title: "Already a lead",
          description: `${lead.address ?? vars.address ?? "This address"} is already in the pipeline - nothing was duplicated.`,
        });
        return;
      }
      // A list fetch still in flight left the server BEFORE this lead existed —
      // let its stale body land and it would paint the new row away again.
      await qc.cancelQueries({ predicate: q => isLeadsListKey(q.queryKey) });
      // Targeted reconcile: the confirmed server row replaces the temp row in
      // place (same index — no flash, no reorder) in every matching cached
      // view. No list refetch: newest-first means the top of page 0 already IS
      // this row's server position.
      upsertLeadIntoLists(qc, lead as Lead, { replaceTempId: ctx?.tempId });
      // A view whose FIRST load got cancelled above (saved while the page was
      // still loading) has no data to patch — refetch it so it can't strand
      // on an empty state.
      void qc.invalidateQueries({ predicate: q => isLeadsListKey(q.queryKey) && q.state.data === undefined });
      if (ctx?.gen === dialogGen.current) setAddOpen(false);
      const view = ctx?.view;
      if (view && !leadMatchesListFilters(lead as Lead, view)) {
        toast({
          title: "Lead saved - hidden by current filters",
          description: `${lead.address ?? vars.address ?? "The lead"} was saved, but this view's filters exclude it. Clear filters to see it.`,
        });
      } else if (view && view.page > 0) {
        toast({ title: "Lead added", description: "It's at the top of page 1 - newest first." });
      } else {
        toast({ title: "Lead added" });
      }
      // The KPI strip counts changed; that one small query refetches in
      // parallel. Facets refetch ONLY when this lead introduces a city/state
      // pair the dropdowns have never seen.
      void qc.invalidateQueries({ queryKey: ["/api/stats"] });
      const facetsCache = qc.getQueryData<{ facets: Array<{ city: string; state: string }> }>(["/api/leads/facets"]);
      const knownPlace = facetsCache?.facets?.some(f =>
        (f.city ?? "").toLowerCase() === String(lead.city ?? "").toLowerCase()
        && (f.state ?? "").toLowerCase() === String(lead.state ?? "").toLowerCase());
      if (facetsCache && !knownPlace) void qc.invalidateQueries({ queryKey: ["/api/leads/facets"] });
    },
    onError: (e: any, _vars, ctx) => {
      // The error is made visible BEFORE the temp row leaves the list —
      // silently removing it first is exactly the "my lead vanished" report.
      // The dialog stays open, so everything typed is still there to retry.
      toast({ title: `Couldn't add lead - ${String(e?.message ?? "request failed")}`, variant: "destructive" });
      restoreLeadLists(ctx?.snapshots);
      // Same first-load revival as the success path: a view whose initial
      // fetch was cancelled by onMutate must not strand on an empty state.
      void qc.invalidateQueries({ predicate: q => isLeadsListKey(q.queryKey) && q.state.data === undefined });
    },
    onSettled: () => {
      createInFlight.current = false;
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<InsertLead> }) => {
      const res = await apiRequest("PATCH", `/api/leads/${id}`, data);
      return res.json();
    },
    onMutate: async ({ id, data }: { id: number; data: Partial<InsertLead> }) => {
      // Silent optimistic success: the row updates and the editor closes
      // immediately (spec: update immediately and silently). Failures below
      // stay loud — the snapshot restores and an error toast shows (a long
      // ~6s beat, then auto-dismisses; the error center keeps the record).
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
      invalidateLeadLists(qc);
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
      toast({ title: "Couldn't delete lead - restored", variant: "destructive" });
    },
    onSettled: () => {
      invalidateLeadLists(qc);
      qc.invalidateQueries({ queryKey: ["/api/stats"] });
    },
  });

  // Filtering is now server-side; leads array is already filtered
  const filtered = leads;
  // Reset page when any filter/search changes
  // After a page swap the 100 new rows render in place but scroll stays pinned
  // at the old bottom, so the rep lands on row 100 of the next page. Bring the
  // pipeline top back into view. Keyed on page only (a filter change resets to
  // page 0 and already re-anchors), first render skipped.
  const pipelineRef = useRef<HTMLElement>(null);
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) { didMountRef.current = true; return; }
    pipelineRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [page]);

  const handleStatusChange = (s: string) => { setFilterStatus(s); setPage(0); };
  // Filter handoff from the Dashboard glance tiles (see lib/leadsFilterHandoff).
  // This page stays MOUNTED under the keep-alive stages, so a mount-only read
  // would miss a tile tapped while Leads is already alive - also re-read on
  // hashchange (a navigation event, not a per-frame scroll listener, so the
  // no-scroll-listener rule holds).
  useEffect(() => {
    const applyHandoff = () => {
      if (!window.location.hash.startsWith("#/leads")) return;
      const status = consumeLeadsFilterHandoff();
      if (status && (status === "all" || status in STATUS_LABEL)) { setFilterStatus(status); setPage(0); }
    };
    applyHandoff();
    window.addEventListener("hashchange", applyHandoff);
    return () => window.removeEventListener("hashchange", applyHandoff);
  }, []);
  const handleSearchChange = (v: string) => { setSearch(v); setPage(0); };
  const searching = search !== debouncedSearch; // typing, query not yet fired
  const handleStateChange = (s: string) => { setFilterState(s); setFilterCity("all"); setPage(0); };
  const handleCityChange = (c: string) => { setFilterCity(c); setPage(0); };
  const handleRepChange = (r: string) => { setFilterRep(r); setPage(0); };
  const handleFiberChange = (f: string) => { setFilterFiber(f); setPage(0); };
  const handleScanWindowChange = (window: "all" | "24h" | "7d" | "30d") => { setScanWindow(window); setPage(0); };
  const handleSortChange = (sort: "created_desc" | "scanned_desc") => { setSortMode(sort); setPage(0); };

  // Active-filter summary — surfaced as dismissible chips so a rep always sees
  // (and can one-tap clear) what's narrowing the list. Pure view over existing
  // filter state; every clear routes through the same setters as the controls.
  const activeFilters = search.trim() !== "" || filterStatus !== "all" || filterState !== "all" || filterCity !== "all" || filterRep !== "all" || filterFiber !== "all" || scanWindow !== "all";
  const clearAllFilters = () => {
    setSearch(""); setFilterStatus("all"); setFilterState("all"); setFilterCity("all"); setFilterRep("all"); setFilterFiber("all"); setScanWindow("all"); setSortMode("created_desc"); setPage(0);
    setMobileFiltersOpen(false);
  };

  // One pass over the team instead of a team.find PER ROW (O(rows x team) on a
  // 100-row page) — same lookup MapView uses for its pin labels.
  const nameByRepId = useMemo(
    () => new Map(team.map(member => [member.id, member.name] as const)),
    [team],
  );
  const assignmentName = useCallback(
    (lead: Lead) => (lead.assignedRepId != null ? nameByRepId.get(lead.assignedRepId) : undefined)
      ?? (lead.assignedRepId ? `Rep #${lead.assignedRepId}` : "Unassigned"),
    [nameByRepId],
  );
  const fiberStatuses = Array.from(new Set([
    "new_fiber", "coming_soon", ...Object.keys(leadStats?.byFiberStatus ?? {}),
  ])).sort();

  // Row callbacks are hoisted so the memoised rows below keep identical props
  // across a keystroke or a dialog toggle. setState functions are already
  // stable; these just give them a row-shaped signature.
  const openLead = useCallback((lead: Lead) => setIntelLead(lead), []);
  const openLeadOnMap = useCallback((lead: Lead) => {
    openLeadOnFieldMap({ leadId: lead.id, lat: lead.lat ?? undefined, lng: lead.lng ?? undefined }, navigate);
  }, [navigate]);
  const openAssign = useCallback((lead: Lead) => setAssignLead(lead), []);
  const openEdit = useCallback((lead: Lead) => setEditLead(lead), []);
  const openDelete = useCallback((id: number) => setDeleteId(id), []);

  // ONE tree, not two. The table and the card list used to both mount on every
  // device with CSS hiding one — React still built and reconciled ~200 rows for
  // a 100-row page, on every keystroke in the search box (the 300ms debounce
  // gates the query, not the render). The hook's breakpoint IS the `lg:` the
  // classes used, so what renders is unchanged.
  const isDesktop = useIsDesktop();

  return (
    <div className="min-h-full bg-background p-4 sm:p-6 lg:p-7 space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-balance text-xl font-bold tracking-tight text-foreground">{isRep ? "My leads" : "Leads command center"}</h1>
          <p className="text-pretty text-sm text-muted-foreground mt-1">{isRep ? "Work your assigned doors and keep every follow-up moving." : "Qualify, assign, and move every fiber opportunity forward."}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => navigate("/map")} className="h-9 border-border text-sm">Field map</Button>
          {canAddLead && <Button onClick={openAddDialog} className="bg-primary hover:bg-primary/90 text-primary-foreground text-sm h-9" data-testid="btn-add-lead-manual">Add lead</Button>}
        </div>
      </div>

      {isRep && (
        // Each cell filters the list: a rep whose day is "work my follow-ups"
        // taps the number and lands on exactly those doors, instead of reading a
        // dead stat and then hunting the chip rail. min-h-tap on every cell.
        <div className="grid grid-cols-3 divide-x divide-border rounded-xl border border-border bg-card md:hidden" data-testid="rep-leads-summary">
          <button type="button" onClick={() => handleStatusChange("all")} className={`min-h-tap px-3 py-3 text-left transition-colors active:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${filterStatus === "all" ? "bg-secondary/50" : ""}`}>
            <span className="block text-2xs font-medium text-muted-foreground">Assigned</span>
            <span className="mt-1 block text-xl font-semibold tabular-nums">{leadStats?.total ?? 0}</span>
          </button>
          <button type="button" onClick={() => handleStatusChange("follow_up")} className={`min-h-tap px-3 py-3 text-left transition-colors active:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${filterStatus === "follow_up" ? "bg-secondary/50" : ""}`}>
            <span className="block text-2xs font-medium text-muted-foreground">Follow-ups</span>
            <span className="mt-1 block text-xl font-semibold tabular-nums text-warning">{bs.follow_up ?? 0}</span>
          </button>
          <button type="button" onClick={() => handleStatusChange("interested")} className={`min-h-tap px-3 py-3 text-left transition-colors active:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${filterStatus === "interested" ? "bg-secondary/50" : ""}`}>
            <span className="block text-2xs font-medium text-muted-foreground">Interested</span>
            <span className="mt-1 block text-xl font-semibold tabular-nums text-violet-600 dark:text-violet-400">{bs.interested ?? 0}</span>
          </button>
        </div>
      )}
      {/* A grid, not a hidden-scrollbar rail: with the scrollbar suppressed
          there was no affordance that Unassigned and Stale — the two cards
          that carry the warnings — even existed off the right edge of a
          phone. Same glance-row rule as the Dashboard tiles: every number on
          screen at once. The last cell spans the leftover slot below sm. */}
      <div className={`${isRep ? "hidden md:grid" : "grid"} grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 [&>*:last-child]:col-span-2 lg:[&>*:last-child]:col-span-1`} data-testid="leads-kpi">
        <EnterpriseKpi label="Total leads" value={statsError ? null : leadStats?.total ?? 0} helper="All active records" />
        <EnterpriseKpi label="Qualified" value={statsError ? null : leadStats?.qualified ?? 0} helper="Interested or sold" />
        <EnterpriseKpi label="Assigned" value={statsError ? null : leadStats?.assigned ?? 0} helper="Owned by a field rep" />
        <EnterpriseKpi label="Unassigned" value={statsError ? null : leadStats?.unassigned ?? 0} helper="Requires an owner" warning={!statsError && (leadStats?.unassigned ?? 0) > 0} />
        <EnterpriseKpi label="Stale" value={statsError ? null : leadStats?.stale ?? 0} helper="No activity in 14 days" warning={!statsError && (leadStats?.stale ?? 0) > 0} />
      </div>

      {canSeeScanOps && (
        <section className="rounded-xl border border-border bg-card px-4 py-3" data-testid="lead-scan-intelligence">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-primary">Scan intelligence</div>
              <p className="mt-1 text-xs text-muted-foreground">Work the newest verified neighborhoods first; coming-soon doors stay on their recheck watch until they become orderable.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" className="h-9" data-testid="quick-recent-scans" onClick={() => { handleScanWindowChange("24h"); handleSortChange("scanned_desc"); }}>
                Scanned in 24h
              </Button>
              <Button variant="outline" size="sm" className="h-9" data-testid="quick-fresh-neighborhoods" onClick={() => { handleFiberChange("new_fiber"); handleScanWindowChange("7d"); handleSortChange("scanned_desc"); }}>
                Fresh neighborhoods
              </Button>
              <Button variant="outline" size="sm" className="h-9" onClick={() => navigate("/fiber")}>
                Coming soon {activeComingSoon.length}{hotComingSoon > 0 ? ` · ${hotComingSoon} hot` : ""}
              </Button>
            </div>
          </div>
        </section>
      )}

      <section ref={pipelineRef} className="rounded-xl border border-border bg-card overflow-hidden shadow-sm">
        <div className="px-4 py-3.5 border-b border-border flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Lead pipeline</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5 tabular-nums">{totalLeads.toLocaleString()} records in this view</p>
          </div>
          <div className="hidden sm:flex items-center gap-1 text-[11px] text-muted-foreground">Filters update the table instantly</div>
        </div>

        <div className="px-4 py-3 border-b border-border bg-background/40 space-y-3">
          <div className="flex flex-col lg:flex-row gap-2.5">
            <div className="relative flex-1 min-w-[240px]">
              
              <Input aria-label="Search leads" value={search} onChange={e => handleSearchChange(e.target.value)} placeholder="Search address, city, ZIP, or contact" className="pl-9 pr-9 bg-card border-input text-sm h-11 lg:h-9" data-testid="input-search-leads" />
              {(searching || (isFetching && !isLoading)) && <RefreshCw className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground animate-spin" />}
            </div>
            <button type="button" onClick={() => setMobileFiltersOpen(open => !open)} aria-expanded={mobileFiltersOpen} className="lg:hidden h-11 rounded-lg border border-border bg-card px-3 text-[12px] font-semibold text-foreground inline-flex items-center justify-center gap-2">Filters{activeFilters && <span className="grid min-w-5 h-5 place-items-center rounded-full bg-primary/15 px-1 text-2xs text-primary">On</span>}</button>
            <div className={`${mobileFiltersOpen ? "grid" : "hidden"} grid-cols-2 sm:grid-cols-3 lg:flex lg:flex-wrap gap-2`}>
              {!isRep && <Select value={filterRep} onValueChange={handleRepChange}><SelectTrigger className="h-10 bg-card lg:h-9 lg:w-[150px]"><SelectValue placeholder="Rep" /></SelectTrigger><SelectContent><SelectItem value="all">All reps</SelectItem><SelectItem value="unassigned">Unassigned</SelectItem>{team.filter(m => m.active).map(m => <SelectItem key={m.id} value={String(m.id)}>{m.name}</SelectItem>)}</SelectContent></Select>}
              <Select value={filterState} onValueChange={handleStateChange}><SelectTrigger className="h-10 bg-card lg:h-9 lg:w-[115px]" data-testid="filter-state"><SelectValue placeholder="State" /></SelectTrigger><SelectContent><SelectItem value="all">All states</SelectItem>{states.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select>
              <Select value={filterCity} onValueChange={handleCityChange}><SelectTrigger className="h-10 bg-card lg:h-9 lg:w-[145px]" data-testid="filter-city"><SelectValue placeholder="Territory" /></SelectTrigger><SelectContent className="max-h-64"><SelectItem value="all">All territories</SelectItem>{cities.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select>
              <Select value={filterFiber} onValueChange={handleFiberChange}><SelectTrigger className="h-10 bg-card lg:h-9 lg:w-[145px]"><SelectValue placeholder="Fiber status" /></SelectTrigger><SelectContent><SelectItem value="all">All fiber states</SelectItem>{fiberStatuses.map(status => <SelectItem key={status} value={status}>{status.replace(/_/g, " ")}</SelectItem>)}</SelectContent></Select>
              <Select value={scanWindow} onValueChange={value => handleScanWindowChange(value as typeof scanWindow)}><SelectTrigger className="h-10 bg-card lg:h-9 lg:w-[145px]" data-testid="filter-scan-window"><SelectValue placeholder="Scan age" /></SelectTrigger><SelectContent><SelectItem value="all">Any scan age</SelectItem><SelectItem value="24h">Scanned in 24h</SelectItem><SelectItem value="7d">Scanned in 7 days</SelectItem><SelectItem value="30d">Scanned in 30 days</SelectItem></SelectContent></Select>
              <Select value={sortMode} onValueChange={value => handleSortChange(value as typeof sortMode)}><SelectTrigger className="h-10 bg-card lg:h-9 lg:w-[150px]" data-testid="sort-leads"><SelectValue placeholder="Sort leads" /></SelectTrigger><SelectContent><SelectItem value="created_desc">Newest added</SelectItem><SelectItem value="scanned_desc">Newest scanned</SelectItem></SelectContent></Select>
            </div>
          </div>

          <div className="no-scrollbar -mx-4 flex snap-x snap-mandatory items-center gap-1 overflow-x-auto px-4 pb-0.5 lg:mx-0 lg:flex-wrap lg:px-0" data-testid="filter-lead-status">
            {["all", ...LEAD_STATUSES].map(status => {
              const active = filterStatus === status;
              const count = status === "all" ? (leadStats?.total ?? 0) : (bs[status] ?? 0);
              return <button key={status} onClick={() => handleStatusChange(status)} className={`h-11 shrink-0 snap-start px-3 text-[12px] lg:h-8 lg:px-2.5 lg:text-2xs rounded-md font-semibold whitespace-nowrap border transition-colors ${active ? "bg-primary/10 text-primary border-primary/25" : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"}`}>{status === "all" ? "All leads" : STATUS_LABEL[status]} <span className="ml-1 tabular-nums opacity-70">{count.toLocaleString("en-US")}</span></button>;
            })}
            {activeFilters && <button onClick={clearAllFilters} className="h-11 px-3 text-[12px] lg:h-7 lg:px-2 lg:text-2xs ml-auto font-semibold text-muted-foreground hover:text-foreground whitespace-nowrap">Clear filters</button>}
          </div>
        </div>

        {isLoading ? (
          isDesktop ? (
            /* Desktop: 8-column row skeletons mirroring the real table grid. */
            <div className="divide-y divide-border">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="grid grid-cols-[27%_1fr_1fr_1fr_1fr_1fr_1fr_1fr] items-center gap-3 px-4 py-3">
                  {Array.from({ length: 8 }).map((_, j) => <Skeleton key={j} className="h-8" />)}
                </div>
              ))}
            </div>
          ) : (
            /* Mobile: stacked card skeletons matching the card list. */
            <div className="space-y-3 px-4 py-4">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}
            </div>
          )
        ) : isError ? (
          <div className="py-16 px-6 text-center"><div className="text-sm font-semibold mt-3">Lead data could not be loaded</div><div className="text-xs text-muted-foreground mt-1">Your filters are preserved. Retry when the connection is restored.</div><Button variant="outline" size="sm" onClick={() => refetchLeads()} className="mt-4 h-8">Retry</Button></div>
        ) : filtered.length === 0 ? (
          <div className="py-16 px-6 text-center"><div className="text-sm font-semibold mt-3">{activeFilters ? "No leads match this operational view" : isRep ? "No leads assigned yet" : "No leads have been added"}</div><div className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">{activeFilters ? "Clear one or more filters to broaden the pipeline." : isRep ? "Ask your team lead for a territory. Assigned doors will appear here and on the Field Map." : "Add a lead or run a market scan to start building the pipeline."}</div>{activeFilters && <Button variant="outline" size="sm" onClick={clearAllFilters} className="mt-4 h-8">Clear filters</Button>}</div>
        ) : isDesktop ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1050px] border-collapse text-left">
              <thead><tr className="border-b border-border bg-muted/20 text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground"><th className="px-4 py-2.5 w-[27%]">Lead</th><th className="px-3 py-2.5">Stage</th><th className="px-3 py-2.5">Territory</th><th className="px-3 py-2.5">Assigned to</th><th className="px-3 py-2.5">Qualification</th><th className="px-3 py-2.5">Last activity</th><th className="px-3 py-2.5">Next action</th><th className="px-3 py-2.5 text-right">Actions</th></tr></thead>
              <tbody className="divide-y divide-border">
                {filtered.map(lead => (
                  <LeadTableRow
                    key={lead.id}
                    lead={lead}
                    assignedName={assignmentName(lead)}
                    onboardingStage={lead.assignedRepId ? onboardingByRep.get(lead.assignedRepId) : undefined}
                    canAssign={canAssign}
                    canEdit={canEdit}
                    canDelete={canDelete}
                    canOpenCalling={canOpenCalling}
                    onOpen={openLead}
                    onMap={openLeadOnMap}
                    onAssign={openAssign}
                    onEdit={openEdit}
                    onDelete={openDelete}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map(lead => (
              <LeadMobileCard key={lead.id} lead={lead} canOpenCalling={canOpenCalling} onOpen={openLead} onMap={openLeadOnMap} />
            ))}
          </div>
        )}

        {!isLoading && !isError && filtered.length > 0 && <div className="px-4 py-3 border-t border-border flex items-center justify-between gap-3"><span className="text-[11px] text-muted-foreground tabular-nums">Showing {page * PAGE_SIZE + 1}-{Math.min((page + 1) * PAGE_SIZE, totalLeads)} of {totalLeads.toLocaleString()}</span><div className="flex items-center gap-1"><Button size="sm" variant="outline" className="h-11 px-3 text-[12px] lg:h-7 lg:px-2 lg:text-xs" disabled={page === 0} onClick={() => setPage(p => p - 1)}><ChevronLeft className="w-3.5 h-3.5" />Prev</Button><span className="text-[11px] text-muted-foreground px-2">Page {page + 1} of {Math.max(totalPages, 1)}</span><Button size="sm" variant="outline" className="h-11 px-3 text-[12px] lg:h-7 lg:px-2 lg:text-xs" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next<ChevronRight className="w-3.5 h-3.5" /></Button></div></div>}
      </section>

      {/* Dialogs */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="bg-card border-border text-foreground max-w-lg">
          <DialogHeader><DialogTitle className="text-base">Add Lead</DialogTitle></DialogHeader>
          <LeadForm onSave={submitCreate} onCancel={() => setAddOpen(false)} saving={createMutation.isPending} />
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

      {/* AlertDialog, not Dialog: a permanent cascade-delete (lead + all knock
          history) needs role="alertdialog" and no scrim/Escape auto-dismiss
          onto the wrong control - the primitive built for irreversible actions. */}
      <AlertDialog open={deleteId !== null} onOpenChange={v => !v && setDeleteId(null)}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">Delete lead?</AlertDialogTitle>
            <AlertDialogDescription>This will permanently remove the lead and all knock history.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteId && deleteMutation.mutate(deleteId)}
              disabled={deleteMutation.isPending}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
              data-testid="btn-confirm-delete">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
