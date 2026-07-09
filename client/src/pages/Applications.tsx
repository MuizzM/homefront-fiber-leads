import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import {
  CheckCircle2, XCircle, Clock, User, Mail, Phone, MapPin,
  Briefcase, FileText, Image, ExternalLink, ChevronDown, ChevronUp,
  AlertTriangle, RefreshCw, Layers, DollarSign, TrendingUp
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Application {
  id: number;
  fullName: string;
  email: string;
  phone: string;
  city: string;
  zip: string;
  state: string;
  hasSalesExperience: boolean;
  salesExperienceDetails: string | null;
  preferredCarriers: string;
  referralSource: string | null;
  headshotPath: string | null;
  licensePath: string | null;
  status: "pending" | "approved" | "rejected";
  reviewNotes: string | null;
  userId: number | null;
  createdAt: string;
  updatedAt: string;
}

const STATUS_TABS = ["pending", "approved", "rejected", "all"] as const;
type StatusTab = typeof STATUS_TABS[number];

const CARRIER_COLORS: Record<string, string> = {
  "Kinetic":     "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  "Brightspeed": "bg-blue-500/15 text-blue-300 border-blue-500/30",
  "Frontier":    "bg-purple-500/15 text-purple-300 border-purple-500/30",
  "T-Fiber":     "bg-pink-500/15 text-pink-300 border-pink-500/30",
};

// Mirrors shared/commissionTiers.ts DEFAULT_RETRO_TIERS — a read-only preview of
// the standard retroactive weekly ladder shown when "Tiered" is picked. The
// server is authoritative; this is illustrative only.
const DEFAULT_TIER_LADDER: Array<{ range: string; rate: string }> = [
  { range: "1–7 sales",  rate: "$150" },
  { range: "8–12 sales", rate: "$200" },
  { range: "13–16 sales", rate: "$250" },
  { range: "17+ sales",  rate: "$300" },
];

type Structure = "TIERED" | "FLAT";

const API_BASE = ("__PORT_5000__" as string).startsWith("__")
  ? ""
  : "__PORT_5000__";

export default function Applications() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<StatusTab>("pending");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [reviewNotes, setReviewNotes] = useState<Record<number, string>>({});
  // Per-application commission structure chosen at approval time.
  const [structure, setStructure] = useState<Record<number, Structure>>({});
  const [flatRate, setFlatRate] = useState<Record<number, string>>({});

  const canReview = user?.role === "admin" || user?.role === "manager";

  const { data: applications = [], isLoading, refetch } = useQuery<Application[]>({
    queryKey: ["/api/onboarding/applications", activeTab],
    queryFn: () => {
      const qs = activeTab !== "all" ? `?status=${activeTab}` : "";
      return apiRequest("GET", `/api/onboarding/applications${qs}`).then(r => r.json());
    },
    enabled: canReview,
  });

  const reviewMutation = useMutation({
    mutationFn: ({ id, status, notes, commission }: { id: number; status: string; notes?: string; commission?: any }) =>
      apiRequest("PATCH", `/api/onboarding/applications/${id}`, { status, reviewNotes: notes || null, commission }).then(r => r.json()),
    onSuccess: (data: any, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/applications"] });
      if (vars.status !== "approved") {
        toast({ title: "Application rejected", description: "Applicant has been notified." });
        return;
      }
      // Approved — reflect the commission structure that was assigned (or warn).
      if (data?.commissionWarning) {
        toast({
          title: "Rep account created — plan needs attention",
          description: data.commissionWarning,
          variant: "destructive",
        });
      } else {
        const struct = data?.commission?.structure;
        const structLabel = struct === "FLAT" ? "flat per-sale" : struct === "TIERED" ? "retroactive weekly tiers" : null;
        toast({
          title: "Application approved",
          description: structLabel
            ? `Rep account created on the ${structLabel} plan. They'll receive login credentials by email.`
            : "Rep account created. They'll receive login credentials by email.",
        });
      }
    },
    onError: (e: any) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  // Build the commission payload for an application from the picker state.
  function commissionPayloadFor(appId: number) {
    const s = structure[appId] ?? "TIERED";
    if (s === "FLAT") {
      const dollars = parseFloat(flatRate[appId] ?? "150");
      return { structure: "FLAT", flatRateCents: Math.round((isNaN(dollars) ? 0 : dollars) * 100) };
    }
    return { structure: "TIERED" };
  }

  if (!canReview) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center text-muted-foreground">
          <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-orange-400" />
          <p>Manager or Admin access required</p>
        </div>
      </div>
    );
  }

  const counts: Record<string, number> = {};
  // We can only show count from current query — show "?" for other tabs
  if (activeTab !== "all") {
    counts[activeTab] = applications.length;
  }

  return (
    <div className="max-w-3xl mx-auto p-5 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold text-foreground">Rep Applications</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Review and approve incoming rep onboarding submissions for HomeFront Fiber
          </p>
        </div>
        <button
          onClick={() => refetch()}
          className="p-2 rounded-lg hover:bg-secondary transition-colors text-muted-foreground hover:text-foreground"
          data-testid="button-refresh-applications"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-secondary/50 rounded-xl p-1">
        {STATUS_TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-2 px-3 rounded-lg text-xs font-semibold capitalize transition-colors ${
              activeTab === tab
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            data-testid={`tab-${tab}`}
          >
            {tab}
            {tab === activeTab && applications.length > 0 && (
              <span className="ml-1.5 bg-primary/20 text-primary px-1.5 py-0.5 rounded-full text-[10px]">
                {applications.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Empty */}
      {!isLoading && applications.length === 0 && (
        <div className="text-center py-16 text-muted-foreground">
          <User className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No {activeTab === "all" ? "" : activeTab} applications</p>
          <p className="text-xs mt-1">
            {activeTab === "pending"
              ? "Share your /join link to start getting applications"
              : "Applications reviewed here will appear in their respective tabs"}
          </p>
        </div>
      )}

      {/* Application cards */}
      <div className="space-y-3">
        {applications.map(app => {
          const isExpanded = expandedId === app.id;
          const carriers = app.preferredCarriers.split(",").map(c => c.trim()).filter(Boolean);
          const submittedDate = new Date(app.createdAt).toLocaleDateString("en-US", {
            month: "short", day: "numeric", year: "numeric"
          });

          return (
            <div
              key={app.id}
              className={`rounded-2xl bg-card border transition-all ${
                app.status === "pending"
                  ? "border-primary/30"
                  : app.status === "approved"
                  ? "border-green-500/30"
                  : "border-red-500/20"
              }`}
              data-testid={`card-application-${app.id}`}
            >
              {/* Card header */}
              <div className="p-4">
                <div className="flex items-start gap-3">
                  {/* Avatar / headshot */}
                  <div className="w-10 h-10 rounded-xl overflow-hidden bg-secondary flex-shrink-0 flex items-center justify-center">
                    {app.headshotPath ? (
                      <img
                        src={`${API_BASE}${app.headshotPath}`}
                        alt={app.fullName}
                        className="w-full h-full object-cover"
                        onError={e => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    ) : (
                      <User className="w-5 h-5 text-muted-foreground" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-foreground text-sm" data-testid={`text-name-${app.id}`}>
                        {app.fullName}
                      </span>
                      {/* Status badge */}
                      {app.status === "pending" && (
                        <span className="flex items-center gap-1 text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full">
                          <Clock className="w-2.5 h-2.5" /> Pending
                        </span>
                      )}
                      {app.status === "approved" && (
                        <span className="flex items-center gap-1 text-[10px] font-bold bg-green-500/15 text-green-300 border border-green-500/30 px-2 py-0.5 rounded-full">
                          <CheckCircle2 className="w-2.5 h-2.5" /> Approved
                        </span>
                      )}
                      {app.status === "rejected" && (
                        <span className="flex items-center gap-1 text-[10px] font-bold bg-red-500/15 text-red-300 border border-red-500/30 px-2 py-0.5 rounded-full">
                          <XCircle className="w-2.5 h-2.5" /> Rejected
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1 flex-wrap">
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Mail className="w-3 h-3" />{app.email}
                      </span>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Phone className="w-3 h-3" />{app.phone}
                      </span>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <MapPin className="w-3 h-3" />{app.city}, {app.state}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                      {carriers.map(c => (
                        <span key={c} className={`text-[10px] font-semibold border px-2 py-0.5 rounded-full ${CARRIER_COLORS[c] || "bg-secondary text-muted-foreground border-border"}`}>
                          {c}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Expand toggle */}
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : app.id)}
                    className="text-muted-foreground hover:text-foreground p-1"
                    data-testid={`button-expand-${app.id}`}
                  >
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                </div>

                {/* Commission structure picker + actions (pending only) */}
                {app.status === "pending" && (() => {
                  const sel = structure[app.id] ?? "TIERED";
                  const setSel = (s: Structure) => setStructure(prev => ({ ...prev, [app.id]: s }));
                  return (
                    <div className="mt-3 space-y-3">
                      {/* Structure chooser */}
                      <div>
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1">
                          <TrendingUp className="w-3 h-3" /> Commission structure
                        </p>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => setSel("TIERED")}
                            className={`flex items-start gap-2 rounded-xl border p-2.5 text-left transition-colors ${
                              sel === "TIERED"
                                ? "border-primary/60 bg-primary/10 ring-1 ring-primary/40"
                                : "border-border bg-secondary/40 hover:bg-secondary/70"
                            }`}
                            data-testid={`button-structure-tiered-${app.id}`}
                          >
                            <Layers className={`w-4 h-4 mt-0.5 flex-shrink-0 ${sel === "TIERED" ? "text-primary" : "text-muted-foreground"}`} />
                            <span>
                              <span className="block text-xs font-semibold text-foreground">Tiered</span>
                              <span className="block text-[10px] text-muted-foreground leading-tight">Retroactive weekly ladder</span>
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setSel("FLAT")}
                            className={`flex items-start gap-2 rounded-xl border p-2.5 text-left transition-colors ${
                              sel === "FLAT"
                                ? "border-primary/60 bg-primary/10 ring-1 ring-primary/40"
                                : "border-border bg-secondary/40 hover:bg-secondary/70"
                            }`}
                            data-testid={`button-structure-flat-${app.id}`}
                          >
                            <DollarSign className={`w-4 h-4 mt-0.5 flex-shrink-0 ${sel === "FLAT" ? "text-primary" : "text-muted-foreground"}`} />
                            <span>
                              <span className="block text-xs font-semibold text-foreground">Flat</span>
                              <span className="block text-[10px] text-muted-foreground leading-tight">Same rate per sale</span>
                            </span>
                          </button>
                        </div>
                      </div>

                      {/* Tiered preview OR flat rate input */}
                      {sel === "TIERED" ? (
                        <div className="rounded-xl bg-secondary/30 border border-border p-2.5">
                          <p className="text-[10px] text-muted-foreground mb-2">
                            Total weekly qualified sales set <strong className="text-foreground">one rate for every sale</strong> that week:
                          </p>
                          <div className="grid grid-cols-4 gap-1.5">
                            {DEFAULT_TIER_LADDER.map(t => (
                              <div key={t.range} className="rounded-lg bg-card border border-border px-1.5 py-1.5 text-center">
                                <div className="text-[9px] text-muted-foreground leading-tight">{t.range}</div>
                                <div className="text-xs font-bold text-primary">{t.rate}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="rounded-xl bg-secondary/30 border border-border p-2.5">
                          <label className="text-[10px] text-muted-foreground block mb-1.5">Rate per qualified sale</label>
                          <div className="flex items-center gap-1.5">
                            <span className="text-muted-foreground text-sm">$</span>
                            <input
                              type="number"
                              min={1}
                              step={1}
                              value={flatRate[app.id] ?? "150"}
                              onChange={e => setFlatRate(prev => ({ ...prev, [app.id]: e.target.value }))}
                              className="w-24 bg-card border border-border rounded-lg px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary/50 transition-colors"
                              data-testid={`input-flat-rate-${app.id}`}
                            />
                            <span className="text-[10px] text-muted-foreground">per sale</span>
                          </div>
                        </div>
                      )}

                      {/* Action buttons */}
                      <div className="flex gap-2">
                        <button
                          onClick={() => reviewMutation.mutate({ id: app.id, status: "approved", notes: reviewNotes[app.id], commission: commissionPayloadFor(app.id) })}
                          disabled={reviewMutation.isPending}
                          className="flex items-center gap-1.5 bg-green-500/15 hover:bg-green-500/25 border border-green-500/30 text-green-300 text-xs font-semibold px-3 py-2 rounded-lg transition-colors flex-1 justify-center disabled:opacity-50"
                          data-testid={`button-approve-${app.id}`}
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" /> Approve & Create Account
                        </button>
                        <button
                          onClick={() => reviewMutation.mutate({ id: app.id, status: "rejected", notes: reviewNotes[app.id] })}
                          disabled={reviewMutation.isPending}
                          className="flex items-center gap-1.5 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 text-xs font-semibold px-3 py-2 rounded-lg transition-colors justify-center disabled:opacity-50"
                          data-testid={`button-reject-${app.id}`}
                        >
                          <XCircle className="w-3.5 h-3.5" /> Reject
                        </button>
                      </div>
                    </div>
                  );
                })()}
              </div>

              {/* Expanded details */}
              {isExpanded && (
                <div className="border-t border-border px-4 pb-4 pt-3 space-y-4">
                  {/* Files */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1">
                        <Image className="w-3 h-3" /> Headshot
                      </p>
                      {app.headshotPath ? (
                        <a
                          href={`${API_BASE}${app.headshotPath}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                          data-testid={`link-headshot-${app.id}`}
                        >
                          <ExternalLink className="w-3 h-3" /> View Headshot
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">Not uploaded</span>
                      )}
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5 flex items-center gap-1">
                        <FileText className="w-3 h-3" /> Driver's License / ID
                      </p>
                      {app.licensePath ? (
                        <a
                          href={`${API_BASE}${app.licensePath}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1.5 text-xs text-primary hover:underline"
                          data-testid={`link-license-${app.id}`}
                        >
                          <ExternalLink className="w-3 h-3" /> View License / ID
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">Not uploaded</span>
                      )}
                    </div>
                  </div>

                  {/* Experience */}
                  <div>
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1 flex items-center gap-1">
                      <Briefcase className="w-3 h-3" /> Sales Experience
                    </p>
                    <p className="text-xs text-foreground">
                      {app.hasSalesExperience ? "Yes" : "No experience"}
                      {app.salesExperienceDetails && ` — ${app.salesExperienceDetails}`}
                    </p>
                  </div>

                  {/* Referral + date */}
                  <div className="grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">Referred By</p>
                      <p className="text-foreground">{app.referralSource || "—"}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">Submitted</p>
                      <p className="text-foreground">{submittedDate}</p>
                    </div>
                  </div>

                  {/* Review notes */}
                  {app.status === "pending" && (
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5">
                        Review Notes (optional)
                      </p>
                      <textarea
                        value={reviewNotes[app.id] || ""}
                        onChange={e => setReviewNotes(prev => ({ ...prev, [app.id]: e.target.value }))}
                        placeholder="Add a note before approving or rejecting..."
                        rows={2}
                        className="w-full bg-secondary/50 border border-border rounded-xl px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground resize-none outline-none focus:border-primary/50 transition-colors"
                        data-testid={`input-review-notes-${app.id}`}
                      />
                    </div>
                  )}

                  {/* Existing review notes (reviewed) */}
                  {app.status !== "pending" && app.reviewNotes && (
                    <div className="bg-secondary/30 rounded-xl px-3 py-2">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">Review Notes</p>
                      <p className="text-xs text-foreground">{app.reviewNotes}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
