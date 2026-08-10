// ── The guided path ───────────────────────────────────────────────────────────
//
// Thirteen stages, each a short sequence of activities. This component owns two
// things: the stage list, and running whichever activity is open.
//
// PROGRESSIVE DISCLOSURE, NOT GATES
//   A stage the rep has not unlocked renders dimmed with its reason stated, and
//   stays clickable. Locking someone out of a lesson they want to read is how a
//   training tab becomes a thing people resent. The dimming is a
//   recommendation; the ordering is the product.
//
// RESUME
//   Continue jumps to the first unfinished activity. Inside an activity, saved
//   state restores the rep mid-quiz. Both come from the server payload, so it
//   works across devices and not just across tabs.

import { Suspense, lazy, useState } from "react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { BackLink, Chip, DoneDot, Panel, PanelSkeleton, PrimaryButton, QuietButton, Ring } from "./primitives";
import ScenarioQuiz, { type ScenarioProgressState } from "./ScenarioQuiz";
import TimedIntro, { type TimedIntroState } from "./TimedIntro";
import BranchingConversation, { type BranchingState } from "./BranchingConversation";
import PitchLab, { type PitchLabState } from "./PitchLab";
import ObjectionDojo from "./ObjectionDojo";
import FeatureToOutcome from "./FeatureToOutcome";
import { useCompleteActivity, useResumeState } from "@/lib/useAcademy";
import {
  ACTIVITY_LABELS, getBranchTree, getScenarioSet,
  type Activity, type PathStage,
} from "@shared/academyPath";
import { getReferenceCard } from "@shared/academyReference";
import { isActivityPassed, type ActivityRecord, type PathProgress } from "@shared/academyProgress";
import type { AcademyOffer } from "@shared/academyOffers";
import type { PersonaId } from "@shared/academyPersonas";

// The role-play engine, personas and scorer are the heaviest thing in the tab.
// Lazy so a rep reading a reference card never downloads them.
const RolePlayCoach = lazy(() => import("./RolePlayCoach"));

export default function PathView({
  progress, records, offers, headline, market, onOpenLesson, onOpenReference,
}: {
  progress: PathProgress;
  records: ActivityRecord[];
  offers: AcademyOffer[];
  headline: AcademyOffer | null;
  market: string;
  /** Path lessons open the existing lesson reader, which writes training_progress. */
  onOpenLesson: (lessonId: string) => void;
  onOpenReference: (cardId: string) => void;
}) {
  const [openActivity, setOpenActivity] = useState<Activity | null>(null);
  const [openStageId, setOpenStageId] = useState<string | null>(null);
  const complete = useCompleteActivity();

  function open(activity: Activity) {
    if (activity.kind === "lesson" && activity.lessonId) { onOpenLesson(activity.lessonId); return; }
    if (activity.kind === "reference" && activity.cardId) {
      // Opening a required card IS reading it. Mark it and hand off to the
      // library, which is where the card actually lives.
      complete.mutate({ activityId: activity.id });
      onOpenReference(activity.cardId);
      return;
    }
    setOpenActivity(activity);
  }

  function finish(activity: Activity, score?: number) {
    complete.mutate({ activityId: activity.id, score: score ?? null });
    setOpenActivity(null);
  }

  if (openActivity) {
    return (
      <ActivityRunner
        activity={openActivity}
        offers={offers}
        headline={headline}
        market={market}
        onComplete={(score) => finish(openActivity, score)}
        onExit={() => setOpenActivity(null)}
      />
    );
  }

  const openStage = openStageId ? progress.stages.find((s) => s.stage.id === openStageId) : null;

  if (openStage) {
    return (
      <div className="space-y-4" data-testid={`path-stage-${openStage.stage.id}`}>
        <BackLink label="All stages" onClick={() => setOpenStageId(null)} />
        <div>
          <SectionLabel>Stage</SectionLabel>
          <h2 className="mt-1 text-lg font-bold leading-snug tracking-tight text-foreground">{openStage.stage.title}</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{openStage.stage.outcome}</p>
        </div>
        <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card">
          {openStage.stage.activities.map((activity) => (
            <ActivityRow
              key={activity.id}
              activity={activity}
              done={isActivityPassed(activity, records)}
              onOpen={() => open(activity)}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="path-view">
      {progress.resume && (
        <Panel tone="accent" testId="path-resume">
          <SectionLabel className="text-primary">Pick up where you stopped</SectionLabel>
          <div className="mt-1 text-[15px] font-bold leading-snug text-foreground">{progress.resume.activity.title}</div>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {progress.resume.stage.title} · about {progress.resume.activity.minutes} min
          </p>
          <div className="mt-3">
            <PrimaryButton onClick={() => open(progress.resume!.activity)} testId="path-continue">Continue</PrimaryButton>
          </div>
        </Panel>
      )}

      <div className="space-y-2">
        {progress.stages.map((stageProgress, i) => (
          <StageRow
            key={stageProgress.stage.id}
            index={i}
            stageProgress={stageProgress}
            onOpen={() => setOpenStageId(stageProgress.stage.id)}
          />
        ))}
      </div>
    </div>
  );
}

function StageRow({ index, stageProgress, onOpen }: {
  index: number;
  stageProgress: { stage: PathStage; done: number; total: number; complete: boolean; locked: boolean };
  onOpen: () => void;
}) {
  const { stage, done, total, complete, locked } = stageProgress;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`path-stage-row-${stage.id}`}
      className={cn(
        "flex min-h-12 w-full items-center gap-3 rounded-2xl border bg-card px-4 py-3 text-left transition-colors",
        complete ? "border-success/30" : "border-border",
        locked && "opacity-60",
        "hover:bg-secondary/50",
        FOCUS,
      )}
    >
      <Ring done={done} total={total} size={40} tone={complete ? "gold" : "primary"} />
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Stage {index + 1}
        </span>
        <span className="block text-[14px] font-bold leading-snug text-foreground">{stage.title}</span>
        <span className="block text-xs leading-snug text-muted-foreground">{stage.outcome}</span>
        {locked && (
          <span className="mt-1 block text-[11px] text-muted-foreground">
            Suggested after the stage above. You can still open it.
          </span>
        )}
      </span>
      <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">&rsaquo;</span>
    </button>
  );
}

function ActivityRow({ activity, done, onOpen }: { activity: Activity; done: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`path-activity-${activity.id}`}
      className={cn(
        "flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary/50",
        FOCUS,
      )}
    >
      <DoneDot done={done} />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold leading-snug text-foreground">{activity.title}</span>
        <span className="block text-xs leading-snug text-muted-foreground">{activity.detail}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
        <Chip tone="neutral">{ACTIVITY_LABELS[activity.kind]}</Chip>
        <span>{activity.minutes} min</span>
      </span>
    </button>
  );
}

// ── Running one activity ──────────────────────────────────────────────────────

function ActivityRunner({ activity, offers, headline, market, onComplete, onExit }: {
  activity: Activity;
  offers: AcademyOffer[];
  headline: AcademyOffer | null;
  market: string;
  onComplete: (score?: number) => void;
  onExit: () => void;
}) {
  const scenarioState = useResumeState<ScenarioProgressState>(activity.kind === "scenario" ? activity.id : null);
  const timedState = useResumeState<TimedIntroState>(activity.kind === "timed_intro" ? activity.id : null);
  const branchState = useResumeState<BranchingState>(activity.kind === "branching" ? activity.id : null);
  const pitchState = useResumeState<PitchLabState>(activity.kind === "pitch_lab" ? activity.id : null);

  const header = (
    <div className="space-y-3">
      <BackLink label="Back to the path" onClick={onExit} />
      <div>
        <SectionLabel>{ACTIVITY_LABELS[activity.kind]}</SectionLabel>
        <h2 className="mt-1 text-lg font-bold leading-snug tracking-tight text-foreground">{activity.title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{activity.detail}</p>
      </div>
    </div>
  );

  if (activity.kind === "scenario" && activity.scenarioId) {
    const set = getScenarioSet(activity.scenarioId);
    if (!set) return <MissingActivity onExit={onExit} />;
    return (
      <div className="space-y-4">
        {header}
        <ScenarioQuiz
          set={set}
          activityId={activity.id}
          resume={scenarioState}
          passScore={activity.passScore}
          onComplete={(score) => onComplete(score)}
          onExit={onExit}
        />
      </div>
    );
  }

  if (activity.kind === "timed_intro") {
    return (
      <div className="space-y-4">
        {header}
        <TimedIntro
          resume={timedState}
          passScore={activity.passScore}
          onComplete={(score) => onComplete(score)}
          onExit={onExit}
        />
      </div>
    );
  }

  if (activity.kind === "branching" && activity.branchId) {
    const tree = getBranchTree(activity.branchId);
    if (!tree) return <MissingActivity onExit={onExit} />;
    return (
      <div className="space-y-4">
        {header}
        <BranchingConversation
          tree={tree}
          activityId={activity.id}
          resume={branchState}
          onComplete={(score) => onComplete(score)}
          onExit={onExit}
        />
      </div>
    );
  }

  if (activity.kind === "pitch_lab") {
    return (
      <div className="space-y-4">
        {header}
        <PitchLab
          activityId={activity.id}
          resume={pitchState}
          offer={headline}
          onComplete={(score) => onComplete(score)}
        />
      </div>
    );
  }

  if (activity.kind === "objection_drill" && activity.objectionKey) {
    return (
      <div className="space-y-4">
        {header}
        <ObjectionDojo
          focusKey={activity.objectionKey}
          completedKeys={new Set()}
          onComplete={() => onComplete()}
        />
      </div>
    );
  }

  if (activity.kind === "flashcards") {
    return (
      <div className="space-y-4">
        {header}
        <FeatureToOutcome onComplete={(score) => onComplete(score)} onExit={onExit} />
      </div>
    );
  }

  if (activity.kind === "roleplay" && activity.personaId) {
    return (
      <Suspense fallback={<PanelSkeleton rows={4} testId="roleplay-loading" />}>
        <RolePlayCoach
          offers={offers}
          market={market}
          initialPersonaId={activity.personaId as PersonaId}
          onBack={onExit}
          onScored={(score) => onComplete(score.overall)}
        />
      </Suspense>
    );
  }

  if (activity.kind === "reference" && activity.cardId) {
    const card = getReferenceCard(activity.cardId);
    if (!card) return <MissingActivity onExit={onExit} />;
    return (
      <div className="space-y-4">
        {header}
        <ul className="space-y-2.5">
          {card.points.map((point, i) => (
            <li key={i} className="rounded-xl border border-border bg-card p-3.5 text-[13px] leading-relaxed text-foreground">
              {point}
            </li>
          ))}
        </ul>
        <PrimaryButton onClick={() => onComplete()} testId="reference-activity-done">Got it</PrimaryButton>
      </div>
    );
  }

  return <MissingActivity onExit={onExit} />;
}

function MissingActivity({ onExit }: { onExit: () => void }) {
  return (
    <Panel tone="warn" testId="activity-missing">
      <p className="text-[13px] leading-relaxed text-foreground">
        This activity could not be loaded. Nothing is lost. Go back and try it again.
      </p>
      <div className="mt-3"><QuietButton onClick={onExit}>Back to the path</QuietButton></div>
    </Panel>
  );
}
