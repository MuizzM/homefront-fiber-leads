// ── The guided path ───────────────────────────────────────────────────────────
//
// Seven stages, each a short sequence of activities. This component owns three
// things: the stage trail, running whichever activity is open, and the moment
// after one finishes.
//
// EVERY ACTIVITY ENDS SOMEWHERE
//   Finishing hands off to ActivityComplete rather than dropping the rep back
//   on a list. That screen states what moved, reveals a stage or certification
//   if one landed, and offers the next activity in one tap. Chaining is the
//   difference between a rep who does one thing and a rep who does four.
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

import { Suspense, lazy, useLayoutEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { BackLink, Chip, DoneDot, Panel, PanelSkeleton, PrimaryButton, QuietButton, Ring } from "./primitives";
import ActivityComplete, { type CelebrationTarget } from "./ActivityComplete";
import ScenarioQuiz, { type ScenarioProgressState } from "./ScenarioQuiz";
import TimedIntro, { type TimedIntroState } from "./TimedIntro";
import BranchingConversation, { type BranchingState } from "./BranchingConversation";
import PitchLab, { type PitchLabState } from "./PitchLab";
import ObjectionDojo from "./ObjectionDojo";
import FeatureToOutcome from "./FeatureToOutcome";
import FiberBasics, { type FiberBasicsState } from "./FiberBasics";
import SpeechTrainer, { type SpeechTrainerState } from "./SpeechTrainer";
import { useCompleteActivity, useResumeState } from "@/lib/useAcademy";
import {
  ACTIVITY_LABELS, getBranchTree, getScenarioSet,
  type Activity, type PathStage,
} from "@shared/academyPath";
import { getReferenceCard } from "@shared/academyReference";
import {
  isActivityPassed, type ActivityRecord, type CertificationStatus, type PathProgress,
} from "@shared/academyProgress";
import type { AcademyOffer } from "@shared/academyOffers";
import type { PersonaId } from "@shared/academyPersonas";

// The role-play engine, personas and scorer are the heaviest thing in the tab.
// Lazy so a rep reading a reference card never downloads them.
const RolePlayCoach = lazy(() => import("./RolePlayCoach"));

export default function PathView({
  progress, records, certifications, offers, headline, market, onOpenLesson, onOpenReference,
}: {
  progress: PathProgress;
  records: ActivityRecord[];
  certifications: CertificationStatus[];
  offers: AcademyOffer[];
  headline: AcademyOffer | null;
  market: string;
  /** Path lessons open the existing lesson reader, which writes training_progress. */
  onOpenLesson: (lessonId: string) => void;
  onOpenReference: (cardId: string) => void;
}) {
  const [openActivity, setOpenActivity] = useState<Activity | null>(null);
  const [openStageId, setOpenStageId] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState<CelebrationTarget | null>(null);
  const complete = useCompleteActivity();

  // Moving between the trail, a stage, an activity and the completion screen is
  // navigation as far as a rep is concerned, so it starts at the top like every
  // other screen change in the app. Without this, finishing a long reference
  // card leaves the completion screen scrolled past its own headline.
  useLayoutEffect(() => {
    document.querySelector(".app-route-stage")?.scrollTo({ top: 0 });
  }, [openActivity?.id, openStageId, celebrate?.activity.id]);

  function open(activity: Activity) {
    setCelebrate(null);
    if (activity.kind === "lesson" && activity.lessonId) { onOpenLesson(activity.lessonId); return; }
    setOpenActivity(activity);
  }

  function finish(activity: Activity, score?: number) {
    complete.mutate({ activityId: activity.id, score: score ?? null });
    // Snapshot what was already earned so the completion screen can tell a
    // certification this activity produced from one the rep already had.
    setCelebrate({
      activity,
      score,
      earnedBefore: certifications.filter((c) => c.earned).map((c) => c.certification.id),
    });
    setOpenActivity(null);
  }

  if (openActivity) {
    return (
      <ActivityRunner
        activity={openActivity}
        offers={offers}
        headline={headline}
        market={market}
        onOpenReference={onOpenReference}
        onComplete={(score) => finish(openActivity, score)}
        onExit={() => setOpenActivity(null)}
      />
    );
  }

  if (celebrate) {
    return (
      <ActivityComplete
        target={celebrate}
        progress={progress}
        certifications={certifications}
        onNext={(activity) => open(activity)}
        onRetry={(activity) => { setCelebrate(null); setOpenActivity(activity); }}
        onBackToPath={() => setCelebrate(null)}
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

      {/* The stages as a trail: each ring is a node, the segment between two
          nodes takes the colour of the stage above it, and the next stage to
          work carries the one gold marker on the screen. The trail is the
          learning-path grammar every beginner app uses, in the house palette.

          The segment is a two-layer bar rather than a single colour, so a stage
          that is half finished shows as half finished on the way down. A rep
          scanning the trail can see the shape of their own week in it. */}
      <div>
        {progress.stages.map((stageProgress, i) => (
          <div key={stageProgress.stage.id}>
            {i > 0 && (() => {
              const above = progress.stages[i - 1];
              const fill = above.total > 0 ? Math.round((above.done / above.total) * 100) : 0;
              return (
                <div aria-hidden="true" className="ml-[35px] h-4 w-0.5 overflow-hidden rounded-full bg-border">
                  <div
                    className={cn(
                      "w-full rounded-full transition-[height] duration-500 ease-out",
                      above.complete ? "bg-success/60" : "bg-primary/50",
                    )}
                    style={{ height: `${fill}%` }}
                  />
                </div>
              );
            })()}
            <StageRow
              index={i}
              stageProgress={stageProgress}
              upNext={progress.resume?.stage.id === stageProgress.stage.id}
              onOpen={() => setOpenStageId(stageProgress.stage.id)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function StageRow({ index, stageProgress, upNext, onOpen }: {
  index: number;
  stageProgress: { stage: PathStage; done: number; total: number; complete: boolean; locked: boolean };
  upNext: boolean;
  onOpen: () => void;
}) {
  const { stage, done, total, complete, locked } = stageProgress;
  const minutes = stage.activities.reduce((n, a) => n + a.minutes, 0);
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid={`path-stage-row-${stage.id}`}
      className={cn(
        "flex min-h-12 w-full items-center gap-3 rounded-2xl border bg-card px-4 py-3 text-left transition-colors",
        complete ? "border-success/30" : upNext ? "border-primary/40 bg-primary/[0.03]" : "border-border",
        // The next stage carries the only gold on the screen, so a rep opening
        // the tab with no idea what to do has exactly one thing pulling at them.
        upNext && "ring-2 ring-[hsl(var(--accent-gold))]/30",
        locked && "opacity-60",
        "hover:bg-secondary/50",
        FOCUS,
      )}
    >
      <Ring done={done} total={total} size={40} tone={complete ? "gold" : "primary"} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Stage {index + 1}
          </span>
          {upNext && <Chip tone="gold">Up next</Chip>}
          {complete && <Chip tone="good">Done</Chip>}
          {!complete && !upNext && (
            <span className="text-[11px] tabular-nums text-muted-foreground">about {minutes} min</span>
          )}
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

function ActivityRunner({ activity, offers, headline, market, onOpenReference, onComplete, onExit }: {
  activity: Activity;
  offers: AcademyOffer[];
  headline: AcademyOffer | null;
  market: string;
  onOpenReference: (cardId: string) => void;
  onComplete: (score?: number) => void;
  onExit: () => void;
}) {
  const scenarioState = useResumeState<ScenarioProgressState>(activity.kind === "scenario" ? activity.id : null);
  const timedState = useResumeState<TimedIntroState>(activity.kind === "timed_intro" ? activity.id : null);
  const branchState = useResumeState<BranchingState>(activity.kind === "branching" ? activity.id : null);
  const pitchState = useResumeState<PitchLabState>(activity.kind === "pitch_lab" ? activity.id : null);
  const fiberState = useResumeState<FiberBasicsState>(activity.kind === "fiber_101" ? activity.id : null);
  const speechState = useResumeState<SpeechTrainerState>(activity.kind === "speech_trainer" ? activity.id : null);

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

  if (activity.kind === "fiber_101" && activity.fiberSection) {
    return (
      <div className="space-y-4">
        {header}
        <FiberBasics
          section={activity.fiberSection}
          activityId={activity.id}
          resume={fiberState}
          onComplete={() => onComplete()}
        />
      </div>
    );
  }

  if (activity.kind === "speech_trainer") {
    return (
      <div className="space-y-4">
        {header}
        <SpeechTrainer
          offer={headline}
          activityId={activity.id}
          resume={speechState}
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
    // The card is READ HERE. It used to mark itself done on tap and throw the
    // rep out into the Reference library mid-stage, which both broke the run of
    // work and recorded a card as read that nobody had read.
    return (
      <div className="space-y-4">
        {header}
        <p className="text-[13px] leading-relaxed text-muted-foreground">{card.summary}</p>
        <ol className="space-y-2.5">
          {card.points.map((point, i) => (
            <li
              key={i}
              className="flex gap-3 rounded-xl border border-border bg-card p-3.5"
              data-testid={`reference-point-${i}`}
            >
              <span
                aria-hidden="true"
                className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-secondary text-[11px] font-bold tabular-nums text-muted-foreground"
              >
                {i + 1}
              </span>
              <span className="text-[13px] leading-relaxed text-foreground">{point}</span>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap gap-2">
          <PrimaryButton onClick={() => onComplete()} testId="reference-activity-done">Got it</PrimaryButton>
          <QuietButton onClick={() => onOpenReference(card.id)} testId="reference-activity-library">
            Open in the Reference
          </QuietButton>
        </div>
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
