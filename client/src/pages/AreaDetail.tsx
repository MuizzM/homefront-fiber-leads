// ── Area Console: one area, end to end ────────────────────────────────────────
//
// The map answers "where"; this screen answers "what is happening here". It is
// the addressable page for a single territory: who holds it, which pass it is
// on, how much of it has actually been walked, and the lifecycle actions a
// manager takes about it — in one place, with a URL you can send someone.
//
// Everything on screen comes off endpoints that already exist and are already
// RBAC-guarded server-side. Nothing here recomputes a rate: every percentage is
// rendered exactly as the server sent it, because shared/territoryMetrics.ts
// owns the denominators (availableBase = total - unavailable - disqualified,
// never total) and a second opinion client-side is how two screens start
// disagreeing about the same ground.
//
// Out-of-scope areas 404 by design (the API refuses to confirm they exist), so
// "not found" and "not yours" render as ONE calm state that leaks nothing.

import { useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { DoorOpen, Hand, BadgeDollarSign, CalendarClock, UserCog, ShieldCheck, AlertTriangle, Ban, History, Loader2, SearchX, type LucideIcon } from "lucide-react";

import { FOCUS } from "@/lib/a11y";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useModalA11y } from "@/hooks/use-modal-a11y";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { EmptyState } from "@/components/EmptyState";
import { PassHistory } from "@/components/territory/PassHistory";
import { StartNextPassDialog } from "@/components/territory/StartNextPassDialog";
import { RepPicker } from "@/components/territory/RepPicker";
import { AreaDeleteDialog } from "@/components/AreaDeleteDialog";
import { can as roleCan } from "@shared/permissions";
import { can as capCan } from "@shared/capabilities";
import { AreaSkipTracePanel } from "@/components/area/AreaSkipTracePanel";
import { AreaMiniMap } from "@/components/area/AreaMiniMap";
import { repColorOf } from "@shared/repColors";
import { shortDate, shortRep } from "@shared/territoryLabel";
import {
  areaHolders, areaStatusMeta, initialsOf, isNotFoundError, isPoolArea,
  type AreaAssignmentRow, type AreaHistoryEvent, type AreaPassesResponse, type AreaDetailRow,
} from "@/lib/areaProgress";
import { activeAreaCountsByRep, areaCountsRecord, repAtCap } from "@/lib/areaCapacity";

// Territory lifecycle authority lives in shared/permissions.ts, NOT in the
// capability map: that rank model is what the Express middleware enforces on
// these exact routes (requireTeamLead for assign/unassign/reclaim,
// requireManager for a pass reset), so gating the buttons on the same function
// means the UI can never offer an action the API will reject.
type TeamRow = { id: number; name: string; active?: boolean; color?: string | null };

type TabId = "overview" | "passes" | "stats" | "doors" | "phones" | "map";

const CHIP = "text-2xs font-bold uppercase tracking-[0.09em] rounded-full px-2.5 py-1";

export default function AreaDetail() {
  const [, params] = useRoute("/areas/:id");
  const id = Number.parseInt(params?.id ?? "", 10);
  const validId = Number.isFinite(id) && id > 0;

  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const role = user?.role;
  const { toast } = useToast();

  // team_lead+ may hand areas out and pull them back; a pass reset clears an
  // entire team's outcomes with no undo and stays manager+.
  const canAssign = roleCan(role, "assign_territory");
  const canNextPass = roleCan(role, "reset_territory_pass");
  // Admin-only and last in the row: deleting is the one action here that ends
  // the area rather than changing it.
  const canDelete = roleCan(role, "delete_territory");
  const [deleteOpen, setDeleteOpen] = useState(false);
  // /passes and /history are requireTeamLead routes. A rep asking for them gets
  // a 403, so we never ask: the tab and the pass chip simply are not theirs.
  const canSeePasses = canAssign;
  // Gated on the SAME capability the Express middleware checks, so the tab and
  // the button can never offer something the API will 403. Both land on
  // team_lead+ (manager and admin inherit), which is who runs an area.
  const canReadSkipTrace = capCan(role, "lead.skip_trace.read");
  const canRunSkipTrace = capCan(role, "lead.skip_trace.request");

  const [tab, setTab] = useState<TabId>("overview");
  const [assignOpen, setAssignOpen] = useState(false);
  const [nextPassOpen, setNextPassOpen] = useState(false);
  const [pickedRepId, setPickedRepId] = useState<number | null>(null);
  // Crew editing. `confirmRemoveId` arms one rep's Remove; `removingRepId` is
  // which one is in flight, so only that row spins. `confirmUnassign` arms the
  // header's Unassign the same way — both fire the same mutation, so neither
  // may be a one-tap action.
  const [addRepOpen, setAddRepOpen] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<number | null>(null);
  const [confirmUnassign, setConfirmUnassign] = useState(false);
  const [removingRepId, setRemovingRepId] = useState<number | null>(null);

  const progressQuery = useQuery<AreaDetailRow>({
    queryKey: [`/api/territories/${id}/progress`],
    enabled: validId,
  });
  const area = progressQuery.data;

  // The tenure ledger (territory_assignments) — who held this ground, put
  // there by whom, closed by whom. Team-lead+ like /history; loaded with the
  // passes tab where it renders.
  const assignmentsQuery = useQuery<AreaAssignmentRow[]>({
    queryKey: [`/api/territories/${id}/assignments`],
    enabled: validId && canAssign && tab === "passes",
  });

  const passesQuery = useQuery<AreaPassesResponse>({
    queryKey: [`/api/territories/${id}/passes`],
    enabled: validId && canSeePasses,
  });

  const historyQuery = useQuery<AreaHistoryEvent[]>({
    queryKey: [`/api/territories/${id}/history`],
    enabled: validId && canSeePasses && tab === "passes",
  });

  const teamQuery = useQuery<TeamRow[]>({
    queryKey: ["/api/team"],
    // Also for "Add a rep" on the crew card — without it the picker opens empty.
    enabled: canAssign && (assignOpen || nextPassOpen || addRepOpen),
  });
  // The whole territory list, for per-rep load counts. RepPicker exists to
  // stop a manager handing a sixth area to someone at the cap — but only when
  // its caller supplies the data, and this screen (one of the two primary
  // assignment surfaces) never did: the mistake surfaced as a server 409 toast
  // AFTER the tap instead of a disabled row before it.
  const territoriesQuery = useQuery<any[]>({
    queryKey: ["/api/territories"],
    enabled: canAssign && (assignOpen || addRepOpen),
    staleTime: 30_000,
  });
  // "Can they take THIS area": the current area is excluded, matching the
  // server's own cap check, so re-assigning ground a rep already holds is
  // never refused as one-too-many.
  const areaCountsMap = useMemo(
    () => activeAreaCountsByRep((territoriesQuery.data ?? []) as any[], id),
    [territoriesQuery.data, id],
  );
  const areaCounts = useMemo(() => areaCountsRecord(areaCountsMap), [areaCountsMap]);
  const reps = useMemo(
    () => (teamQuery.data ?? []).filter(m => m.active !== false).map(m => ({
      id: m.id, name: m.name, color: m.color,
      areaCount: areaCountsMap.get(m.id) ?? 0,
      atCap: repAtCap(areaCountsMap, m.id),
    })),
    [teamQuery.data, areaCountsMap],
  );

  const invalidateArea = () => {
    queryClient.invalidateQueries({ queryKey: [`/api/territories/${id}/progress`] });
    queryClient.invalidateQueries({ queryKey: [`/api/territories/${id}/passes`] });
    queryClient.invalidateQueries({ queryKey: [`/api/territories/${id}/history`] });
    queryClient.invalidateQueries({ queryKey: ["/api/territories"] });
    queryClient.invalidateQueries({ queryKey: ["/api/territories/progress"] });
    queryClient.invalidateQueries({ queryKey: ["/api/leads"] });
  };

  // Handing the area to a rep. An area nobody holds is an /assign; taking one
  // off its current holder and giving it to someone else is a reclaim in
  // reassign mode — the same two calls the Field Map makes, so both screens
  // move the same rows.
  const assignMutation = useMutation({
    mutationFn: async (repId: number) => {
      const pool = area ? isPoolArea(area) : true;
      const res = pool
        ? await apiRequest("POST", `/api/territories/${id}/assign`, { repId })
        : await apiRequest("POST", `/api/territories/${id}/reclaim`, { mode: "reassign", newRepId: repId });
      return res.json();
    },
    onSuccess: () => {
      setAssignOpen(false);
      setPickedRepId(null);
      invalidateArea();
      toast({ title: "Area assigned", severity: "success" });
    },
    onError: (e: any) => toast({
      title: "Couldn't assign this area",
      description: String(e?.message ?? e).slice(0, 160),
      variant: "destructive",
    }),
  });

  // Take ONE rep off the area. The server releases their doors inside it and
  // leaves the doors in the area for whoever is left, so this is "off the crew",
  // not "the area is over".
  const unassignMutation = useMutation({
    mutationFn: async (repId: number) => {
      const res = await apiRequest("POST", `/api/territories/${id}/unassign`, { repId });
      return res.json() as Promise<{ leadsReleased: number; assigneeIds: number[] }>;
    },
    onSuccess: (data, repId) => {
      setRemovingRepId(null);
      invalidateArea();
      const name = (area && areaHolders(area).find(h => h.id === repId)?.name) ?? "That rep";
      const n = data?.leadsReleased ?? 0;
      toast({
        title: `${name} removed from this area`,
        description: n > 0
          ? `${n} ${n === 1 ? "door" : "doors"} went back to the pool.`
          : "They had no doors in it.",
        severity: "success",
      });
    },
    onError: (e: any) => {
      setRemovingRepId(null);
      toast({
        title: "Couldn't remove the rep from this area",
        description: String(e?.message ?? e).slice(0, 160),
        variant: "destructive",
      });
    },
  });

  // Add a rep. /share takes the COMPLETE holder set, so the caller sends who
  // should be on it afterwards — the same contract the map's assignee bar uses.
  const shareMutation = useMutation({
    mutationFn: async (repIds: number[]) => {
      const res = await apiRequest("POST", `/api/territories/${id}/share`, { repIds });
      return res.json();
    },
    onSuccess: () => {
      setAddRepOpen(false);
      invalidateArea();
      toast({ title: "Added to this area", severity: "success" });
    },
    onError: (e: any) => toast({
      title: "Couldn't add that rep",
      description: String(e?.message ?? e).slice(0, 160),
      variant: "destructive",
    }),
  });

  const nextPassMutation = useMutation({
    mutationFn: async (body: {
      territoryAction: string; newRepId?: number; keepPendingCallbacks: boolean; note?: string;
    }) => {
      const res = await apiRequest("POST", `/api/territories/${id}/next-pass`, body);
      return res.json();
    },
    onSuccess: (data: any) => {
      setNextPassOpen(false);
      invalidateArea();
      toast({
        title: data?.nextPass != null ? `Pass ${data.nextPass} started` : "Next pass started",
        severity: "success",
      });
    },
    onError: (e: any) => toast({
      title: "Couldn't start the next pass",
      description: String(e?.message ?? e).slice(0, 160),
      variant: "destructive",
    }),
  });

  // ── Not found / not yours ───────────────────────────────────────────────────
  if (!validId || (progressQuery.isError && isNotFoundError(progressQuery.error))) {
    return (
      <div className="mx-auto w-full max-w-5xl p-4 pt-5 pb-24 md:p-6" data-testid="area-not-found">
        <BackLink />
        <EmptyState
          icon={SearchX}
          title="Area not found"
          description="This area either doesn't exist or isn't one of yours. Ask your manager if you think it should be."
          action={<Link href="/areas" className={cn("text-sm font-semibold text-primary underline underline-offset-4", FOCUS)}>Back to areas</Link>}
          testId="area-not-found-state"
        />
      </div>
    );
  }

  if (progressQuery.isError) {
    return (
      <div className="mx-auto w-full max-w-5xl p-4 pt-5 pb-24 md:p-6" data-testid="area-error">
        <BackLink />
        <div role="alert" className="rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-foreground">
          Couldn't load this area. Check your connection and try again.
        </div>
      </div>
    );
  }

  if (progressQuery.isLoading || !area) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-5 p-4 pt-5 pb-24 md:p-6" data-testid="area-loading">
        <BackLink />
        <Skeleton className="h-8 w-56 rounded-lg" />
        <Skeleton className="h-6 w-72 rounded-full" />
        <Skeleton className="h-28 w-full rounded-2xl" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-28 rounded-2xl" />)}
        </div>
      </div>
    );
  }

  const meta = areaStatusMeta(area.status);
  const pool = isPoolArea(area);
  const currentPass = passesQuery.data?.currentPass;
  const lastPass = passesQuery.data?.passes?.[0] ?? null;
  const dot = area.color || repColorOf({ id: area.repId, color: null });
  // The whole crew, primary first. One source for the header line, the card and
  // the remove control, so they cannot disagree about who is on this ground.
  const holders = areaHolders(area);

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "overview", label: "Overview" },
    ...(canSeePasses ? [{ id: "passes" as TabId, label: "Passes & history" }] : []),
    { id: "stats", label: "Stats" },
    { id: "doors", label: "Doors" },
    ...(canReadSkipTrace ? [{ id: "phones" as TabId, label: "Phones" }] : []),
    { id: "map", label: "Map" },
  ];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 p-4 pt-5 pb-24 md:p-6" data-testid="area-detail">
      <BackLink />

      {/* ── Title: the area's own colour, then its name. Nothing else at this size. */}
      <div className="flex items-center gap-2.5">
        <span
          data-testid="area-color-dot"
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 rounded-full border border-foreground/10"
          style={{ backgroundColor: dot }}
        />
        <h1 className="min-w-0 truncate text-xl font-bold tracking-tight text-foreground" data-testid="area-name">
          {area.name}
        </h1>
      </div>

      {/* ── Chips: state, sweep, and the two facts that date the area. */}
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn(CHIP, meta.chip)} data-testid="area-status-chip">{meta.label}</span>
        {currentPass != null && (
          <span className={cn(CHIP, "bg-secondary text-muted-foreground")} data-testid="area-pass-chip">
            Pass {currentPass}
          </span>
        )}
        <span className="text-[13px] text-muted-foreground" data-testid="area-meta">
          <span className="tabular-nums">{area.total.toLocaleString()}</span> doors
          {" · "}last activity {shortDate(area.lastActivityAt) ?? "never"}
        </span>
      </div>

      {/* ── Actions. Hidden, never disabled: a control you may not use should not
             be on screen at all. The server enforces the same ranks. */}
      <div className="flex flex-wrap gap-2" data-testid="area-actions">
        {canAssign && (
          <button
            type="button"
            data-testid="area-action-reassign"
            // No preselect. area.repId still names the LAST holder after a
            // reclaim, so preselecting it armed a one-tap hand-back to exactly
            // the person the area was taken from. An empty picker makes the
            // choice deliberate; confirm stays disabled until one is made.
            onClick={() => { setPickedRepId(null); setAssignOpen(true); }}
            className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-secondary px-3.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/70", FOCUS)}
          >
            
            {pool ? "Assign" : "Re-assign"}
          </button>
        )}
        {/* Only for a one-rep area: "Unassign Bo" is unambiguous there. On a
            crew it would beg the question WHICH rep, so removal moves to the
            per-rep control on the card below. */}
        {canAssign && !pool && holders.length === 1 && area.repId != null && (
          confirmUnassign ? (
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                data-testid="area-action-unassign-confirm"
                disabled={unassignMutation.isPending}
                onClick={() => { setConfirmUnassign(false); setRemovingRepId(area.repId as number); unassignMutation.mutate(area.repId as number); }}
                className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-destructive px-3.5 text-sm font-semibold text-destructive-foreground disabled:opacity-50", FOCUS)}
              >
                Unassign {shortRep(area.repName)}
              </button>
              <button
                type="button"
                data-testid="area-action-unassign-cancel"
                onClick={() => setConfirmUnassign(false)}
                className={cn("min-h-11 rounded-xl border border-border px-3.5 text-sm font-semibold text-foreground", FOCUS)}
              >
                Keep
              </button>
            </span>
          ) : (
            <button
              type="button"
              data-testid="area-action-unassign"
              disabled={unassignMutation.isPending}
              onClick={() => setConfirmUnassign(true)}
              className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-secondary px-3.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/70 disabled:opacity-50", FOCUS)}
            >
              {unassignMutation.isPending
                ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                : null}
              Unassign {shortRep(area.repName)}
            </button>
          )
        )}
        {canDelete && (
          <button
            type="button"
            data-testid="area-action-delete"
            onClick={() => setDeleteOpen(true)}
            className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-destructive/40 bg-destructive/5 px-3.5 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/10", FOCUS)}
          >
            
            Delete area
          </button>
        )}
        {canNextPass && (
          <button
            type="button"
            data-testid="area-action-next-pass"
            onClick={() => setNextPassOpen(true)}
            className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-secondary px-3.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/70", FOCUS)}
          >
            
            Start next pass
          </button>
        )}
        <Link
          href="/map"
          data-testid="area-action-open-map"
          className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-card px-3.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/60", FOCUS)}
        >
          
          Open in map
        </Link>
      </div>

      {/* ── Tabs ───────────────────────────────────────────────────────────── */}
      <div className="inline-flex w-full flex-wrap rounded-xl border border-border bg-card p-1 sm:w-auto" role="tablist" aria-label="Area console">
        {tabs.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            data-testid={`area-tab-${t.id}`}
            className={cn(
              "h-11 md:h-9 flex-1 rounded-lg px-4 text-xs font-semibold transition-colors sm:flex-none",
              tab === t.id ? "bg-secondary text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              FOCUS,
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <section className="space-y-4" data-testid="area-panel-overview">
          {/* Hero: the one thing a manager opens this page to learn. */}
          <div
            className={cn("rounded-2xl border bg-gradient-to-br p-4 md:flex md:items-stretch md:gap-6", meta.hero)}
            data-testid="area-hero"
          >
            <div className="min-w-0 flex-1">
              <SectionLabel>Current assignment</SectionLabel>
              <div className="mt-1 text-2xl font-bold tracking-tight text-foreground" data-testid="area-hero-value">
                {pool
                  ? meta.label
                  : `${meta.label} to ${holders.length > 2
                      ? `${holders[0].name} +${holders.length - 1}`
                      : holders.map(h => h.name).join(" and ") || area.repName}`}
              </div>
              <p className="mt-1 text-[13px] text-muted-foreground">{meta.blurb}</p>
            </div>
            <div className="mt-4 border-t border-border pt-4 md:mt-0 md:w-56 md:shrink-0 md:border-l md:border-t-0 md:pl-6 md:pt-0" data-testid="area-hero-snapshot">
              <SectionLabel>Snapshot</SectionLabel>
              <dl className="mt-1.5 space-y-1 text-[13px]">
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-muted-foreground">Last pass closed</dt>
                  <dd className="font-semibold text-foreground">
                    {lastPass ? shortDate(lastPass.closedAt) ?? " - " : canSeePasses ? "None yet" : " - "}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <dt className="text-muted-foreground">Doors</dt>
                  <dd className="font-semibold tabular-nums text-foreground">{area.total.toLocaleString()}</dd>
                </div>
              </dl>
            </div>
          </div>

          {/* ── Why this area ─────────────────────────────────────────────────
              The deploy briefing was captured at creation ("why this ground was
              cut") and then never re-read by any screen — the one moment a rep
              or manager could use it, it was invisible. Scan-created areas
              render it here; hand-drawn areas simply have none. */}
          {area.briefing && (
            <div className="rounded-2xl border border-border bg-card p-4" data-testid="area-briefing">
              <SectionLabel>Why this area</SectionLabel>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-3">
                <div className="flex items-baseline justify-between gap-2 sm:block">
                  <span className="text-muted-foreground">Unworked doors</span>
                  <div className="font-semibold tabular-nums text-foreground">
                    {area.briefing.unworked.toLocaleString()} of {area.briefing.doors.toLocaleString()}
                  </div>
                </div>
                <div className="flex items-baseline justify-between gap-2 sm:block">
                  <span className="text-muted-foreground">Avg lead score</span>
                  <div className="font-semibold tabular-nums text-foreground">{area.briefing.avgScore}</div>
                </div>
                <div className="flex items-baseline justify-between gap-2 sm:block">
                  <span className="text-muted-foreground">New fiber</span>
                  <div className="font-semibold tabular-nums text-foreground">{area.briefing.newFiber.toLocaleString()} confirmed</div>
                </div>
                {area.briefing.topCompetitor && (
                  <div className="col-span-2 sm:col-span-3">
                    <span className="text-muted-foreground">
                      Top competitor: <span className="font-semibold text-foreground">{area.briefing.topCompetitor.name}</span>
                      {" "}on {area.briefing.topCompetitor.count} doors ({area.briefing.competitorShare}% of the area).
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* The retrospective a manager wrote when they marked it done. */}
          {area.completionNotes && (
            <div className="rounded-2xl border border-info/25 bg-info/5 p-4" data-testid="area-completion-notes">
              <SectionLabel>Completion notes</SectionLabel>
              <p className="mt-1.5 whitespace-pre-wrap text-[13px] text-foreground">{area.completionNotes}</p>
            </div>
          )}

          {/* ── Who works this area ──────────────────────────────────────────
              An area is many-to-many everywhere else in the product; this card
              used to print exactly one name, so a crew read as one rep's ground
              and there was no way to take somebody off it from the Area tab.
              Removal is per-rep and two-step: dropping a rep hands their doors
              back, so a mis-tap costs someone their working queue. */}
          <div className="rounded-2xl border border-border bg-card p-4" data-testid="area-owner">
            <SectionLabel>{holders.length > 1 ? `Who works this area · ${holders.length} reps` : "Owner"}</SectionLabel>
            {pool ? (
              <div className="mt-2 flex items-center gap-3" data-testid="area-owner-empty">
                
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-foreground">Unassigned</div>
                  <div className="text-[13px] text-muted-foreground">
                    Nobody holds this area. Its doors stay in the pool until you hand it out.
                  </div>
                </div>
              </div>
            ) : (
              <ul className="mt-2 space-y-1.5" data-testid="area-owner-list">
                {holders.map((h, i) => {
                  const arming = confirmRemoveId === h.id;
                  const busy = unassignMutation.isPending && removingRepId === h.id;
                  return (
                    <li key={h.id} className="flex items-center gap-3" data-testid={`area-holder-${h.id}`}>
                      <span
                        data-testid={i === 0 ? "area-owner-avatar" : `area-holder-avatar-${h.id}`}
                        aria-hidden="true"
                        style={{ borderColor: repColorOf({ id: h.id, color: null }) }}
                        className="grid h-10 w-10 shrink-0 place-items-center rounded-full border-2 text-[13px] font-bold text-foreground"
                      >
                        {initialsOf(h.name)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div
                          className="truncate text-sm font-semibold text-foreground"
                          {...(i === 0 ? { "data-testid": "area-owner-name" } : {})}
                        >
                          {h.name}
                        </div>
                        <div className="text-[13px] text-muted-foreground">
                          {holders.length > 1 && i === 0 ? "Primary" : "Assigned rep"}
                          {currentPass != null ? ` · working pass ${currentPass}` : ""}
                        </div>
                      </div>
                      {canAssign && (
                        arming ? (
                          <span className="flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              data-testid={`area-holder-remove-confirm-${h.id}`}
                              disabled={unassignMutation.isPending}
                              onClick={() => { setConfirmRemoveId(null); setRemovingRepId(h.id); unassignMutation.mutate(h.id); }}
                              className={cn("min-h-11 rounded-xl bg-destructive px-3 text-[13px] font-semibold text-destructive-foreground disabled:opacity-50", FOCUS)}
                            >
                              {busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : "Remove"}
                            </button>
                            <button
                              type="button"
                              data-testid={`area-holder-remove-cancel-${h.id}`}
                              onClick={() => setConfirmRemoveId(null)}
                              className={cn("min-h-11 rounded-xl border border-border px-3 text-[13px] font-semibold text-foreground", FOCUS)}
                            >
                              Keep
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            data-testid={`area-holder-remove-${h.id}`}
                            aria-label={`Remove ${h.name} from this area`}
                            disabled={unassignMutation.isPending}
                            onClick={() => setConfirmRemoveId(h.id)}
                            className={cn("inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border border-border bg-secondary px-3 text-[13px] font-semibold text-foreground transition-colors hover:bg-secondary/70 disabled:opacity-50", FOCUS)}
                          >
                            
                            Remove
                          </button>
                        )
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {canAssign && !pool && (
              <div className="mt-3 border-t border-border pt-3">
                {addRepOpen ? (
                  <>
                    <RepPicker
                      label="Add a rep to this area"
                      disabled={shareMutation.isPending}
                      reps={reps.filter(r => !holders.some(h => h.id === r.id))}
                      areaCounts={areaCounts}
                      onChange={(repId) => shareMutation.mutate([...holders.map(h => h.id), repId])}
                    />
                    <button
                      type="button"
                      data-testid="area-add-rep-cancel"
                      onClick={() => setAddRepOpen(false)}
                      disabled={shareMutation.isPending}
                      className={cn("mt-2 min-h-11 w-full rounded-xl border border-border bg-secondary text-[13px] font-semibold text-foreground disabled:opacity-50", FOCUS)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    data-testid="area-add-rep"
                    onClick={() => setAddRepOpen(true)}
                    className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-dashed border-border px-3.5 text-[13px] font-semibold text-muted-foreground transition-colors hover:border-solid hover:bg-secondary hover:text-foreground", FOCUS)}
                  >
                    
                    Add a rep
                  </button>
                )}
              </div>
            )}

            {canAssign && !pool && (
              <p className="mt-2 text-[12px] leading-snug text-muted-foreground" data-testid="area-holder-note">
                Removing a rep takes this area out of their app and hands their doors in it back - the doors stay in the area for whoever is left.
              </p>
            )}
          </div>

          {/* The four numbers. Denominators are never recomputed here (file
              header) — but display clamps to 0–100 like AreaStatsCard, since a
              repeat pass can push the raw rate past 100. */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="area-stat-grid">
            <HeadlineStat
              label="Doors in area" value={area.total} sub="Matches current filter set"
              icon={DoorOpen} chip="bg-primary/15" tone="text-primary" testId="area-stat-total"
            />
            <HeadlineStat
              label="Knocked" value={area.knocked} sub={`${pct(area.knockCompletionRate)}% of the area covered`}
              icon={Hand} chip="bg-info/10" tone="text-info" testId="area-stat-knocked"
            />
            <HeadlineStat
              label="Sold" value={area.sold} sub={`${pct(area.penetrationRate)}% penetration`}
              icon={BadgeDollarSign} chip="bg-success/10" tone="text-success" testId="area-stat-sold"
            />
            <HeadlineStat
              label="Follow-ups" value={area.followUp} sub="Callbacks to sweep"
              icon={CalendarClock} chip="bg-warning/10" tone="text-warning" testId="area-stat-followup"
            />
          </div>
        </section>
      )}

      {tab === "passes" && canSeePasses && (
        <section className="space-y-5" data-testid="area-panel-passes">
          <PassHistory
            currentPass={passesQuery.data?.currentPass ?? 1}
            passes={passesQuery.data?.passes ?? []}
            loading={passesQuery.isLoading}
            error={passesQuery.isError ? "Couldn't load this area's pass history." : null}
          />

          <div>
            <SectionLabel className="mb-2">Event log</SectionLabel>
            {historyQuery.isLoading ? (
              <div className="space-y-2" data-testid="area-history-loading">
                {[0, 1, 2].map(i => <Skeleton key={i} className="h-12 w-full rounded-xl" />)}
              </div>
            ) : historyQuery.isError ? (
              <div role="alert" className="text-sm text-destructive">Couldn't load this area's events.</div>
            ) : (historyQuery.data ?? []).length === 0 ? (
              <EmptyState
                icon={History} bordered title="No events yet"
                description="Assignments, reclaims, and pass resets are recorded here as they happen."
                testId="area-history-empty"
              />
            ) : (
              <ol className="space-y-2" data-testid="area-history-list">
                {(historyQuery.data ?? []).map(ev => (
                  <li key={ev.id} className="flex items-baseline justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] font-semibold text-foreground">
                        {String(ev.type ?? "event").replace(/[_:]/g, " ")}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {ev.actorUserId != null ? `by user #${ev.actorUserId}` : "system"}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {shortDate(ev.at) ?? ev.at}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {/* ── Assignment roster ──────────────────────────────────────────────
              territory_assignments is the append-only tenure ledger — written on
              every holder change since it shipped, read by nothing until now.
              "Who held this ground, put there by whom, taken off by whom" is the
              question a manager asks when an area goes wrong. */}
          <div>
            <SectionLabel className="mb-2">Assignment roster</SectionLabel>
            {assignmentsQuery.isLoading ? (
              <div className="space-y-2" data-testid="area-roster-loading">
                {[0, 1].map(i => <Skeleton key={i} className="h-12 w-full rounded-xl" />)}
              </div>
            ) : assignmentsQuery.isError ? (
              <div role="alert" className="text-sm text-destructive">Couldn't load this area's roster.</div>
            ) : (assignmentsQuery.data ?? []).length === 0 ? (
              <EmptyState
                icon={UserCog} bordered title="No tenures recorded yet"
                description="Each rep's stint on this area - who put them on and who took them off - is recorded here."
                testId="area-roster-empty"
              />
            ) : (
              <ol className="space-y-2" data-testid="area-roster-list">
                {(assignmentsQuery.data ?? []).map(a => (
                  <li key={a.id} className="rounded-xl border border-border bg-card px-3 py-2.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">
                        {a.repName ?? `Rep #${a.repId}`}
                        {a.roleInTerritory === "primary" && (
                          <span className="ml-1.5 text-2xs font-bold uppercase tracking-wide text-muted-foreground">primary</span>
                        )}
                      </span>
                      <span className={cn(CHIP, "shrink-0", a.unassignedAt == null
                        ? "bg-success/10 text-success"
                        : "bg-secondary text-muted-foreground")}>
                        {a.unassignedAt == null ? "Holding" : "Ended"}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      On {shortDate(a.assignedAt) ?? a.assignedAt}
                      {a.assignedByName ? ` by ${a.assignedByName}` : ""}
                      {a.unassignedAt
                        ? <> · off {shortDate(a.unassignedAt) ?? a.unassignedAt}{a.unassignedByName ? ` by ${a.unassignedByName}` : ""}</>
                        : ""}
                      {a.reason ? ` · ${a.reason}` : ""}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </section>
      )}

      {tab === "stats" && (
        <section className="space-y-4" data-testid="area-panel-stats">
          <div>
            <SectionLabel className="mb-2">Door breakdown</SectionLabel>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" data-testid="area-breakdown">
              <MiniStat label="Contacted" value={area.contacted} hint={`${pct(area.contactRate)}% of doors knocked answered`} testId="area-stat-contacted" />
              <MiniStat label="Nobody home" value={area.notHome} hint="Knocked, no answer yet" testId="area-stat-nothome" />
              <MiniStat label="Untouched" value={area.untouched} hint="Available doors never knocked" testId="area-stat-untouched" />
              <MiniStat label="Disqualified" value={area.disqualified} hint="Terminal no - out of the base" testId="area-stat-disqualified" />
              <MiniStat label="Unavailable" value={area.unavailable} hint="Do not knock - out of the base" testId="area-stat-unavailable" />
              <MiniStat label="Knock attempts" value={area.attempts} hint="Every knock, including repeat visits" testId="area-stat-attempts" />
            </div>
            {/* "Every rate" was false: contact rate divides by doors KNOCKED,
                not by the available base. Scope the claim to the rates it
                actually covers, or the note teaches managers the wrong math. */}
            <p className="mt-2 text-xs text-muted-foreground" data-testid="area-base-note">
              Coverage and penetration divide by the <span className="tabular-nums">{area.availableBase.toLocaleString()}</span> available
              doors ({area.total.toLocaleString()} total minus {area.unavailable} unavailable and {area.disqualified} disqualified),
              never by the raw total. Contact rate divides by doors knocked.
            </p>
          </div>

          <div>
            <SectionLabel className="mb-2">Location verification</SectionLabel>
            <div className="rounded-2xl border border-border bg-card p-4">
              <div className="grid grid-cols-3 gap-2" data-testid="area-verification">
                <VerifyTile icon={ShieldCheck} label="Verified" value={area.verified}
                  className="border-success/15 bg-success/[0.08] text-success" testId="area-verified" />
                <VerifyTile icon={AlertTriangle} label="Needs review" value={area.needsReview}
                  className="border-warning/15 bg-warning/[0.08] text-warning" testId="area-needs-review" />
                <VerifyTile icon={Ban} label="Invalid" value={area.invalid}
                  className="border-destructive/15 bg-destructive/[0.08] text-destructive" testId="area-invalid" />
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  
                  Average distance when marked{" "}
                  <span className="tabular-nums text-foreground">{area.avgDistanceM != null ? `${area.avgDistanceM} m` : " - "}</span>
                </span>
                <span>Max allowed <span className="tabular-nums">{area.maxAllowedDistanceM} m</span></span>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Counts are knocks, not doors: one door knocked three times contributes three verdicts.
                Area worked is <span className="tabular-nums text-foreground">{area.areaWorkedPct}%</span> -
                {" "}{area.verifiedWorkedLeads} of {area.total} doors have a location-verified worked knock.
              </p>
            </div>
          </div>
        </section>
      )}

      {tab === "doors" && (
        <section className="rounded-2xl border border-border bg-card p-4" data-testid="area-panel-doors">
          <SectionLabel>Doors</SectionLabel>
          <p className="mt-2 text-[13px] text-muted-foreground">
            The door list lives on the Leads screen, which owns search, filters, dispositions, and assignment.
            It has no per-area filter yet, so this opens the full list rather than pretending to scope it.
            To see only this area's doors, use the map: the polygon is the filter.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/leads" data-testid="area-doors-leads-link"
              className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-primary px-3.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90", FOCUS)}>
               Open Leads
            </Link>
            <Link href="/map" data-testid="area-doors-map-link"
              className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-secondary px-3.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/70", FOCUS)}>
               Open the map
            </Link>
          </div>
        </section>
      )}

      {tab === "phones" && canReadSkipTrace && (
        <AreaSkipTracePanel areaId={id} canRun={canRunSkipTrace} />
      )}

      {tab === "map" && (
        <section className="rounded-2xl border border-border bg-card p-4" data-testid="area-panel-map">
          <SectionLabel>Map</SectionLabel>
          {Array.isArray(area.polygon) && area.polygon.length >= 3 ? (
            <>
              {/* The boundary itself - same paint rule as the Field Map, fitted
                  to the area. Knocking and editing stay on the Field Map; this
                  answers "where is it" without leaving the console. */}
              <div className="mt-3">
                <AreaMiniMap
                  polygon={area.polygon}
                  color={area.color}
                  status={area.status}
                  repId={area.repId}
                  areaName={area.name}
                />
              </div>
              <p className="mt-2 text-[12px] text-muted-foreground">
                A preview of <span className="font-semibold text-foreground">{area.name}</span>'s boundary.
                Knocking, pins, and boundary edits live on the Field Map.
              </p>
            </>
          ) : (
            <p className="mt-2 text-[13px] text-muted-foreground">
              This area has no stored boundary to draw. The Field Map is where
              boundaries are drawn and edited.
            </p>
          )}
          <Link href="/map" data-testid="area-map-link"
            className={cn("mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-primary px-3.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90", FOCUS)}>
             Open the Field Map
          </Link>
        </section>
      )}

      {/* ── Assign / re-assign ─────────────────────────────────────────────── */}
      {assignOpen && canAssign && (
        <AreaAssignDialog onClose={() => !assignMutation.isPending && setAssignOpen(false)}>
          <div className="relative max-h-[85vh] w-full space-y-3 overflow-y-auto rounded-t-2xl border border-border bg-card p-4 text-foreground sm:max-w-md sm:rounded-2xl">
            <h2 className="text-base font-semibold">{pool ? "Assign this area" : "Hand this area to another rep"}</h2>
            <p className="text-xs text-muted-foreground">
              The chosen rep gets the area and every door inside it.
            </p>
            {/* A shared area's re-assign REPLACES the whole crew — say so
                before the tap, not in the aftermath. The complete-holder-set
                edit lives on the crew card below for the other intent. */}
            {!pool && holders.length > 1 && (
              <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground" data-testid="area-assign-crew-impact">
                {holders.length} reps work this area today. Handing it to one rep takes the
                other {holders.length - 1 === 1 ? "rep" : `${holders.length - 1} reps`} off it
                and moves their doors here to the new owner. To change the crew instead,
                use the crew card on this page.
              </p>
            )}
            {teamQuery.isLoading ? (
              <Skeleton className="h-32 w-full rounded-lg" />
            ) : (
              <RepPicker
                reps={reps}
                value={pickedRepId}
                onChange={setPickedRepId}
                disabled={assignMutation.isPending}
                label="Assign to"
                areaCounts={areaCounts}
              />
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setAssignOpen(false)} disabled={assignMutation.isPending}
                className={cn("min-h-11 rounded-xl border border-border px-4 text-sm font-semibold disabled:opacity-50", FOCUS)}>
                Cancel
              </button>
              <button
                type="button"
                data-testid="area-assign-confirm"
                disabled={pickedRepId == null || assignMutation.isPending}
                onClick={() => pickedRepId != null && assignMutation.mutate(pickedRepId)}
                className={cn("inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50", FOCUS)}
              >
                {assignMutation.isPending && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                Assign
              </button>
            </div>
          </div>
        </AreaAssignDialog>
      )}

      {/* ── Start next pass — the existing dialog, unchanged ────────────────── */}
      {canDelete && area && (
        <AreaDeleteDialog
          target={{
            id: Number(id), name: String(area.name ?? "this area"),
            total: Number(area.total) || 0, sold: Number(area.sold) || 0,
            repName: area.repName ?? null,
          }}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          // The area this page is about no longer exists, so staying on it
          // would render a 404 shell. Go back to the index.
          onDeleted={() => setLocation("/areas")}
        />
      )}
      {nextPassOpen && canNextPass && (
        <StartNextPassDialog
          open
          territoryId={id}
          busy={nextPassMutation.isPending}
          reps={reps}
          fetchPreview={async (territoryId, keepPendingCallbacks) => {
            const res = await apiRequest(
              "GET",
              `/api/territories/${territoryId}/next-pass/preview?keepPendingCallbacks=${keepPendingCallbacks}`,
            );
            return res.json();
          }}
          onConfirm={opts => nextPassMutation.mutate(opts)}
          onCancel={() => setNextPassOpen(false)}
        />
      )}
    </div>
  );
}

/** Display clamp for server-computed rates. Repeat passes can push raw rates
 *  past 100 ("109.24% covered" reads as a bug), so cap at 100 — but keep one
 *  decimal: a 7.5% penetration rounded to 8% erases real resolution at the low
 *  end where managers actually compare areas. Denominators stay server-owned
 *  (file header); this only formats. */
function pct(rate: unknown): number {
  return Math.round(Math.max(0, Math.min(100, Number(rate) || 0)) * 10) / 10;
}

function BackLink() {
  return (
    <Link href="/areas" data-testid="area-back-link"
      className={cn("inline-flex items-center gap-1.5 text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground", FOCUS)}>
       Areas
    </Link>
  );
}

/** KpiTile's grammar (rounded-2xl / border-border / bg-card / tinted icon chip /
 *  26px tabular number) plus the sub-line KpiTile has no slot for. */
function HeadlineStat({ label, value, sub, testId }: {
  label: string;
  value: number;
  sub: string;
  icon: LucideIcon;
  chip: string;
  tone: string;
  testId: string;
}) {
  return (
    <div className="relative min-w-0 rounded-2xl border border-border bg-card p-3.5" data-testid={testId}>
      
      <div className="pr-9 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1.5 text-[26px] font-bold leading-none tracking-tight tabular-nums text-foreground" data-testid={`${testId}-value`}>
        {value.toLocaleString()}
      </div>
      <div className="mt-1.5 text-[11px] text-muted-foreground" data-testid={`${testId}-sub`}>{sub}</div>
    </div>
  );
}

function MiniStat({ label, value, hint, testId }: { label: string; value: number; hint: string; testId: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3" data-testid={testId}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-bold leading-none tabular-nums text-foreground">{value.toLocaleString()}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>
    </div>
  );
}

function VerifyTile({ label, value, className, testId }: {
  icon: LucideIcon; label: string; value: number; className: string; testId: string;
}) {
  return (
    <div className={cn("rounded-xl border px-2 py-2 text-center", className)} data-testid={testId}>
      <div className="inline-flex items-center gap-1">
        
        <span className="text-sm font-bold tabular-nums">{value.toLocaleString()}</span>
      </div>
      <div className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}

// The assign dialog's shell: scrim, Escape, and initial focus. The hand-rolled
// role=dialog markup closed only via its scrim or Cancel — no Escape handler,
// no autofocus, no way for a keyboard user to leave without tabbing back into
// the page behind it. Every sibling dialog (StartNextPassDialog,
// ReclaimAllDialog, the map's share dialog) already handles Escape; the map's
// was added precisely because its absence "reads as the dialog is stuck" on
// phones. Focus lands on the panel itself so the first Tab hits the picker.
function AreaAssignDialog({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Full modal contract via the shared hook: Escape (capture), focus moved to
  // the first control, Tab contained, focus restored to the opener - the
  // aria-modal claim was only half-true with the old Escape-only handler.
  useModalA11y(panelRef, { active: true, onClose });
  return (
    <div role="dialog" aria-modal="true" aria-label="Assign this area"
         data-testid="area-assign-dialog"
         className="fixed inset-0 z-overlay flex items-end justify-center sm:items-center">
      <button
        type="button" aria-label="Close" data-testid="area-assign-scrim"
        onClick={onClose}
        className="absolute inset-0 bg-overlay"
      />
      <div ref={panelRef} tabIndex={-1} className="contents">
        {children}
      </div>
    </div>
  );
}
