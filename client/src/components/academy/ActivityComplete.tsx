// ── The moment after an activity ──────────────────────────────────────────────
//
// Finishing something used to drop the rep back on the stage list with no
// acknowledgement and no next step, which is the exact point where a new hire
// closes the tab. This screen is the payoff: what you just did, what it moved,
// and one tap into the next thing while the momentum is still there.
//
// IT NEVER CONGRATULATES A FAILED ATTEMPT
//   An activity with a passScore that came in under the bar renders as logged,
//   not passed, with the bar stated and the same drill offered again. Praise
//   that does not track the result is the fastest way to make every other piece
//   of praise in the tab worthless.
//
// THE CERTIFICATION BANNER ARRIVES LATE ON PURPOSE
//   Completion is optimistic, but certifications are re-derived by the server.
//   The caller hands us the set that was already earned BEFORE this activity;
//   when the refetched payload contains one that is not in it, that
//   certification was earned by what the rep just did, and it reveals itself.
//   Nothing here is animated into place before it is true.

import { useMemo } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { Chip, Panel, PrimaryButton, QuietButton } from "./primitives";
import { ACTIVITY_LABELS, type Activity } from "@shared/academyPath";
import type { CertificationStatus, PathProgress } from "@shared/academyProgress";

export type CelebrationTarget = {
  activity: Activity;
  score?: number;
  /** Certification ids the rep had already earned before this activity. */
  earnedBefore: string[];
};

export default function ActivityComplete({
  target, progress, certifications, onNext, onBackToPath, onRetry,
}: {
  target: CelebrationTarget;
  progress: PathProgress;
  certifications: CertificationStatus[];
  onNext: (activity: Activity) => void;
  onBackToPath: () => void;
  onRetry: (activity: Activity) => void;
}) {
  const { activity, score, earnedBefore } = target;

  const passed = activity.passScore == null || (score != null && score >= activity.passScore);
  const stage = progress.stages.find((s) => s.stage.activities.some((a) => a.id === activity.id));
  const stageIndex = progress.stages.findIndex((s) => s.stage.id === stage?.stage.id);
  const stageJustCompleted = !!stage?.complete;
  const next = progress.resume?.activity ?? null;

  const justEarned = useMemo(
    () => certifications.filter((c) => c.earned && !earnedBefore.includes(c.certification.id)),
    [certifications, earnedBefore],
  );

  const pathComplete = progress.total > 0 && progress.done >= progress.total;

  return (
    <div className="hf-stagger space-y-4" data-testid="activity-complete">
      {/* The acknowledgement itself. One mark, one line, no confetti. */}
      <Panel
        className={cn("relative overflow-hidden text-center", passed && "border-success/30")}
        testId="activity-complete-head"
      >
        <div
          aria-hidden="true"
          className={cn(
            "status-pop mx-auto grid h-14 w-14 place-items-center rounded-full border-2",
            passed ? "border-success bg-success/10 text-success" : "border-warning bg-warning/10 text-warning",
          )}
        >
          {passed
            ? <Check className="h-7 w-7" strokeWidth={3} />
            : <span className="text-xl font-bold tabular-nums">{score ?? 0}</span>}
        </div>
        <div className="mt-3">
          <SectionLabel className={passed ? "text-success" : "text-warning"}>
            {passed ? "Activity complete" : "Attempt logged"}
          </SectionLabel>
          <h2 className="mt-1 text-lg font-bold leading-snug tracking-tight text-foreground" data-testid="activity-complete-title">
            {activity.title}
          </h2>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground" data-testid="activity-complete-line">
            {passed
              ? score != null
                ? `Scored ${score}. That one is behind you.`
                : "That one is behind you."
              : `You scored ${score ?? 0} and the bar is ${activity.passScore}. Nothing is lost, and the attempt is saved. Run it again when you want the pass.`}
          </p>
        </div>
      </Panel>

      {/* What it moved. A rep should never have to go looking for the effect of
          the thing they just finished. */}
      {stage && (
        <Panel testId="activity-complete-stage">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <SectionLabel>Stage {stageIndex + 1} of {progress.stages.length}</SectionLabel>
            <span className="text-xs font-semibold tabular-nums text-muted-foreground" data-testid="activity-complete-stage-count">
              {stage.done} of {stage.total} done
            </span>
          </div>
          <div className="mt-1 text-[14px] font-bold leading-snug text-foreground">{stage.stage.title}</div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-700 ease-out",
                stage.complete ? "bg-success" : "bg-primary",
              )}
              style={{ width: `${stage.total > 0 ? Math.round((stage.done / stage.total) * 100) : 0}%` }}
            />
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {stage.complete ? stage.stage.outcome : `Whole path: ${progress.done} of ${progress.total} activities.`}
          </p>
        </Panel>
      )}

      {stageJustCompleted && !pathComplete && (
        <div
          className="hf-shine relative overflow-hidden rounded-2xl border border-[hsl(var(--accent-gold))]/35 bg-[hsl(var(--accent-gold-soft))] p-4"
          data-testid="stage-complete-banner"
        >
          <SectionLabel className="text-[hsl(var(--accent-gold-text))]">Stage complete</SectionLabel>
          <p className="mt-1 text-[14px] font-bold leading-snug text-foreground">
            {stage?.stage.title}
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            {stage?.stage.outcome}
          </p>
        </div>
      )}

      {/* Certifications land a beat later, once the server has re-derived them. */}
      {justEarned.map((c) => (
        <div
          key={c.certification.id}
          className="hf-shine relative overflow-hidden rounded-2xl border border-[hsl(var(--accent-gold))]/35 bg-[hsl(var(--accent-gold-soft))] p-4"
          data-testid={`certification-earned-${c.certification.id}`}
        >
          <SectionLabel className="text-[hsl(var(--accent-gold-text))]">Certification earned</SectionLabel>
          <p className="mt-1 text-[15px] font-bold leading-snug text-foreground">{c.certification.title}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{c.certification.meaning}</p>
        </div>
      ))}

      {/* One tap into the next thing. This is the whole point of the screen. */}
      {pathComplete ? (
        <Panel tone="accent" testId="path-complete">
          <SectionLabel className="text-primary">The path is done</SectionLabel>
          <p className="mt-1 text-[13px] leading-relaxed text-foreground">
            Every activity is behind you. The drills, the dojo and the role-play personas stay open for as long as you want them, and the Reference is the thing you open on a porch.
          </p>
          <div className="mt-3">
            <QuietButton onClick={onBackToPath} testId="activity-complete-back">Back to the path</QuietButton>
          </div>
        </Panel>
      ) : (
        <Panel tone="accent" testId="activity-complete-next">
          <SectionLabel className="text-primary">{passed ? "Next up" : "What now"}</SectionLabel>
          {!passed ? (
            <>
              <div className="mt-1 text-[15px] font-bold leading-snug text-foreground">{activity.title}</div>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                {ACTIVITY_LABELS[activity.kind]} · about {activity.minutes} min
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <PrimaryButton onClick={() => onRetry(activity)} testId="activity-complete-retry">
                  Run it again
                </PrimaryButton>
                <QuietButton onClick={onBackToPath} testId="activity-complete-back">Back to the path</QuietButton>
              </div>
            </>
          ) : next ? (
            <>
              <div className="mt-1 text-[15px] font-bold leading-snug text-foreground">{next.title}</div>
              <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{next.detail}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Chip tone="neutral">{ACTIVITY_LABELS[next.kind]}</Chip>
                <span className="text-xs tabular-nums text-muted-foreground">about {next.minutes} min</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <PrimaryButton onClick={() => onNext(next)} testId="activity-complete-next-start">
                  Keep going
                </PrimaryButton>
                <QuietButton onClick={onBackToPath} testId="activity-complete-back">Back to the path</QuietButton>
              </div>
            </>
          ) : (
            <div className="mt-2">
              <QuietButton onClick={onBackToPath} testId="activity-complete-back">Back to the path</QuietButton>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
