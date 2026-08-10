// ── Supervisor panel ──────────────────────────────────────────────────────────
//
// Three jobs: see where the team is, assign something specific to one rep, and
// configure the market's offers so reps have real numbers to quote.
//
// WHAT THIS SCREEN DELIBERATELY IS NOT
//   It is not a leaderboard. Reps are listed by NAME, never by score, and there
//   is no sort control that would turn the list into a ranking. Coaching detail
//   opens per rep, one at a time, behind a capability check on the server.
//   Team-wide weakness is shown as dimensions, not as people: "listening is the
//   gap" is actionable, "these four reps are worst at listening" is a wall
//   chart nobody should have to live under.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { BackLink, Chip, ErrorPanel, Panel, PanelSkeleton, PrimaryButton, QuietButton, Ring } from "./primitives";
import OfferConsole from "./OfferConsole";
import { ACADEMY_TEAM_KEY, useAcademyTeam } from "@/lib/useAcademy";
import { PATH_STAGES, TOTAL_ACTIVITIES } from "@shared/academyPath";
import { BAND_LABELS, DIMENSION_LABELS, bandFor } from "@shared/academyScoring";
import type { CertificationStatus, PathProgress, PracticeArea } from "@shared/academyProgress";
import type { SessionScore } from "@shared/academyScoring";

type RepDetail = {
  userId: number;
  path: PathProgress;
  certifications: CertificationStatus[];
  practiceAreas: PracticeArea[];
  sessions: { sessionId: string; personaId: string; overall: number; createdAt: string; score: SessionScore }[];
  assignments: { id: number; targetId: string; targetKind: string; note: string; dueOn: string | null; completedAt: string | null }[];
};

export default function SupervisorPanel({ canManage }: { canManage: boolean }) {
  const [view, setView] = useState<"team" | "offers">("team");
  const [openRepId, setOpenRepId] = useState<number | null>(null);
  const { data, isLoading, isError, refetch } = useAcademyTeam(true);

  if (openRepId != null) {
    return <RepDetailView userId={openRepId} canManage={canManage} onBack={() => setOpenRepId(null)} />;
  }

  return (
    <div className="space-y-4" data-testid="supervisor-panel">
      <div className="flex gap-1.5">
        <QuietButton onClick={() => setView("team")} pressed={view === "team"} testId="supervisor-view-team">
          Team
        </QuietButton>
        {canManage && (
          <QuietButton onClick={() => setView("offers")} pressed={view === "offers"} testId="supervisor-view-offers">
            Market offers
          </QuietButton>
        )}
      </div>

      {view === "offers" && canManage ? (
        <OfferConsole />
      ) : isLoading ? (
        <PanelSkeleton rows={4} testId="supervisor-loading" />
      ) : isError ? (
        <ErrorPanel
          title="Team progress didn't load"
          description="The roll-up could not be fetched. Nothing is lost."
          onRetry={() => refetch()}
          testId="supervisor-error"
        />
      ) : !data?.members.length ? (
        <Panel testId="supervisor-empty">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Nobody on the team has started the Academy yet. Assign a first stage to someone and it will show up here.
          </p>
        </Panel>
      ) : (
        <>
          {data.gaps.length > 0 && (
            <div data-testid="supervisor-gaps">
              <SectionLabel className="mb-1.5 px-1">Where the team is weakest</SectionLabel>
              <div className="space-y-2">
                {data.gaps.map((gap) => (
                  <Panel key={gap.dimension} testId={`supervisor-gap-${gap.dimension}`}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[13px] font-semibold text-foreground">{gap.label}</span>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-[13px] font-bold tabular-nums text-foreground">{gap.average}</span>
                        <Chip tone={gap.average >= 80 ? "good" : gap.average >= 55 ? "warn" : "bad"}>
                          {BAND_LABELS[bandFor(gap.average)]}
                        </Chip>
                      </div>
                    </div>
                    <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{gap.suggestion}</p>
                    {gap.repsBelow > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {gap.repsBelow} {gap.repsBelow === 1 ? "person is" : "people are"} below the developing line here.
                      </p>
                    )}
                  </Panel>
                ))}
              </div>
            </div>
          )}

          <div data-testid="supervisor-roster">
            <div className="mb-1.5 flex items-baseline justify-between gap-3 px-1">
              <SectionLabel>The team</SectionLabel>
              <span className="text-xs text-muted-foreground">by name</span>
            </div>
            <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
              {data.members.map((member) => (
                <button
                  key={member.userId}
                  type="button"
                  onClick={() => setOpenRepId(member.userId)}
                  data-testid={`supervisor-rep-${member.userId}`}
                  className={cn(
                    "flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary/50",
                    FOCUS,
                  )}
                >
                  <Ring done={member.activitiesDone} total={TOTAL_ACTIVITIES} size={38} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold leading-snug text-foreground">{member.name}</span>
                    <span className="block truncate text-xs capitalize text-muted-foreground">
                      {member.role.replace(/_/g, " ")}
                      {member.rolePlayCount > 0 && ` · ${member.rolePlayCount} role-plays`}
                    </span>
                  </span>
                  <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">&rsaquo;</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── One rep ───────────────────────────────────────────────────────────────────

function RepDetailView({ userId, canManage, onBack }: { userId: number; canManage: boolean; onBack: () => void }) {
  const { data, isLoading, isError, refetch } = useQuery<RepDetail>({
    queryKey: ["/api/training/academy/team", userId],
    queryFn: async () => (await apiRequest("GET", `/api/training/academy/team/${userId}`)).json(),
    staleTime: 30_000,
  });

  return (
    <div className="space-y-4" data-testid={`supervisor-rep-detail-${userId}`}>
      <BackLink label="Back to the team" onClick={onBack} />

      {isLoading ? (
        <PanelSkeleton rows={4} />
      ) : isError || !data ? (
        <ErrorPanel
          title="This rep's detail didn't load"
          description="Their coaching record could not be fetched."
          onRetry={() => refetch()}
        />
      ) : (
        <>
          <Panel>
            <div className="flex items-center gap-4">
              <Ring done={data.path.done} total={data.path.total} size={52} />
              <div className="min-w-0 flex-1">
                <SectionLabel>Path progress</SectionLabel>
                <div className="mt-0.5 text-lg font-bold tabular-nums tracking-tight text-foreground">
                  {data.path.done} of {data.path.total}
                  <span className="ml-1.5 text-sm font-medium text-muted-foreground">activities</span>
                </div>
              </div>
            </div>
          </Panel>

          {data.certifications.some((c) => c.earned) && (
            <div>
              <SectionLabel className="mb-1.5 px-1">Certifications</SectionLabel>
              <div className="flex flex-wrap gap-1.5">
                {data.certifications.filter((c) => c.earned).map((c) => (
                  <Chip key={c.certification.id} tone="gold">{c.certification.title}</Chip>
                ))}
              </div>
            </div>
          )}

          {data.practiceAreas.length > 0 && (
            <div data-testid="rep-practice-areas">
              <SectionLabel className="mb-1.5 px-1">Needs practice</SectionLabel>
              <div className="space-y-2">
                {data.practiceAreas.map((area) => (
                  <Panel key={area.dimension}>
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[13px] font-semibold text-foreground">{area.label}</span>
                      <span className="text-[13px] font-bold tabular-nums text-foreground">{area.average}</span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{area.suggestion}</p>
                  </Panel>
                ))}
              </div>
            </div>
          )}

          {canManage && <AssignForm userId={userId} />}

          {data.assignments.length > 0 && (
            <div data-testid="rep-assignments">
              <SectionLabel className="mb-1.5 px-1">Assigned</SectionLabel>
              <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
                {data.assignments.map((a) => (
                  <div key={a.id} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="min-w-0 flex-1 text-[13px] font-semibold text-foreground">
                        {PATH_STAGES.find((s) => s.id === a.targetId)?.title ?? a.targetId}
                      </span>
                      <Chip tone={a.completedAt ? "good" : a.dueOn ? "warn" : "neutral"}>
                        {a.completedAt ? "Done" : a.dueOn ? `Due ${a.dueOn}` : "Open"}
                      </Chip>
                    </div>
                    {a.note && <p className="mt-0.5 text-xs text-muted-foreground">{a.note}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.sessions.length > 0 && (
            <div data-testid="rep-sessions">
              <SectionLabel className="mb-1.5 px-1">Recent role-plays</SectionLabel>
              <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
                {data.sessions.slice(0, 8).map((s) => (
                  <div key={s.sessionId} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[13px] font-semibold capitalize text-foreground">
                        {s.personaId.replace(/_/g, " ")}
                      </span>
                      <span className="text-[13px] font-bold tabular-nums text-foreground">{s.overall}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {s.score.coaching[0] ?? "No coaching note recorded."}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Assign ────────────────────────────────────────────────────────────────────

function AssignForm({ userId }: { userId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [stageId, setStageId] = useState(PATH_STAGES[0].id);
  const [note, setNote] = useState("");
  const [dueOn, setDueOn] = useState("");

  const stageOptions = useMemo(() => PATH_STAGES.map((s) => ({ id: s.id, title: s.title })), []);

  const assign = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/training/academy/assignments", {
        userId, targetId: stageId, targetKind: "stage", note, dueOn: dueOn || null,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Assigned", description: "It is on their path now, with your note." });
      setNote("");
      setDueOn("");
      queryClient.invalidateQueries({ queryKey: ["/api/training/academy/team", userId] });
      queryClient.invalidateQueries({ queryKey: ACADEMY_TEAM_KEY });
    },
    onError: () => {
      toast({ variant: "destructive", title: "Could not assign", description: "Nothing was saved. Try again." });
    },
  });

  return (
    <Panel testId="assign-form">
      <SectionLabel>Assign a stage</SectionLabel>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        The note is shown to them. Say why, in your own words: an assignment without a reason reads as a punishment.
      </p>
      <div className="mt-3 space-y-2">
        <div>
          <label htmlFor="assign-stage" className="sr-only">Stage</label>
          <select
            id="assign-stage"
            value={stageId}
            onChange={(e) => setStageId(e.target.value)}
            data-testid="assign-stage"
            className={cn("min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground", FOCUS)}
          >
            {stageOptions.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="assign-note" className="sr-only">Why</label>
          <input
            id="assign-note"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="Why this, for them, right now"
            data-testid="assign-note"
            className={cn("min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground", FOCUS)}
          />
        </div>
        <div>
          <label htmlFor="assign-due" className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Due (optional)
          </label>
          <input
            id="assign-due"
            type="date"
            value={dueOn}
            onChange={(e) => setDueOn(e.target.value)}
            data-testid="assign-due"
            className={cn("min-h-11 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground", FOCUS)}
          />
        </div>
        <PrimaryButton onClick={() => assign.mutate()} disabled={assign.isPending} testId="assign-submit">
          {assign.isPending ? "Assigning..." : "Assign it"}
        </PrimaryButton>
      </div>
    </Panel>
  );
}

/** Re-exported so the dimension labels stay importable from one place. */
export { DIMENSION_LABELS };
