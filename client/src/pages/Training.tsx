// Training — the Fiber Sales Academy.
//
// Six sections behind one tab strip: the guided Path, free Practice, the Pitch
// Lab, the Objection dojo, the field Reference library, and the module Library
// that was here before. Supervisors get a seventh.
//
// WHAT DID NOT CHANGE
//   The lesson curriculum in shared/trainingContent.ts, and the
//   training_progress rows it writes. A lesson opened from a path activity is
//   the SAME lesson reader writing the SAME row, so the training gate, the
//   ramp bonus and the manager rollup all keep working untouched. The Academy
//   is a layer on top, not a replacement.
//
// PROGRESSIVE DISCLOSURE
//   The tab opens on the Path, which opens on one card: continue where you
//   stopped. Everything else is one tap away and nothing is more than two. The
//   heavy pieces (role-play engine, personas, scorer) are lazy, so a rep who
//   only reads a reference card never downloads them.
//
// Page grammar follows the house style: PageHeader, eyebrow SectionLabels,
// tabular numbers, tokens only, 44px touch targets, FOCUS on every raw
// interactive. No decorative glyphs in copy.
import { Suspense, lazy, useLayoutEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { FOCUS } from "@/lib/a11y";
import { cn } from "@/lib/utils";
import { PageHeader, SectionLabel } from "@/components/ui/page-scaffold";
import { TrainingGateBanner, TrainingClearedBanner } from "@/components/TrainingLock";
import { TrainingAccessPanel } from "@/components/TrainingAccessPanel";
import PitchRecorder, { isPitchRecorderSupported } from "@/components/training/PitchRecorder";
import NumbersGame from "@/components/training/NumbersGame";
import PsychologyDeck from "@/components/training/PsychologyDeck";
import FullPitchRun from "@/components/training/FullPitchRun";
import {
  Chip, ErrorPanel, Panel, PanelSkeleton, PrimaryButton, QuietButton, Ring, SectionTabs,
} from "@/components/academy/primitives";
import PathView from "@/components/academy/PathView";
import PitchLab from "@/components/academy/PitchLab";
import ObjectionDojo from "@/components/academy/ObjectionDojo";
import ReferenceLibrary from "@/components/academy/ReferenceLibrary";
import { useAcademyOffers, useAcademyProgress, useCompleteActivity } from "@/lib/useAcademy";
import { ACADEMY_OBJECTIONS } from "@shared/academyObjections";
import { TOTAL_PATH_MINUTES } from "@shared/academyPath";
import { openAssignments } from "@shared/academyProgress";
import type { PersonaId } from "@shared/academyPersonas";
import {
  TRAINING_MODULES, TRAINING_LESSONS, TOTAL_TRAINING_LESSONS,
  getTrainingLesson, getTrainingModuleForLesson,
  type TrainingLesson, type TrainingModule,
} from "@shared/trainingContent";

// Lazy: the role-play engine, the ten personas and the eleven-dimension scorer
// are the heaviest thing in this tab and most visits never open them.
const RolePlayCoach = lazy(() => import("@/components/academy/RolePlayCoach"));
const SupervisorPanel = lazy(() => import("@/components/academy/SupervisorPanel"));

type ProgressRow = { lessonId: string; completedAt: string; quizScore: number | null };
type ProgressPayload = { totalLessons: number; completed: ProgressRow[] };

const PROGRESS_KEY = ["/api/training/progress"];

type SectionId = "path" | "practice" | "pitch" | "objections" | "reference" | "library" | "team";

/** The lesson after this one in curriculum order, or undefined at the end. */
function nextTrainingLesson(lessonId: string): TrainingLesson | undefined {
  const i = TRAINING_LESSONS.findIndex((l) => l.id === lessonId);
  return i >= 0 ? TRAINING_LESSONS[i + 1] : undefined;
}

// ── Day streak — computed, not stored ─────────────────────────────────────────
// Consecutive local days with at least one lesson completed, ending today or
// yesterday (yesterday keeps the flame alive until tonight, because a streak
// that dies while you sleep teaches resentment, not habit).
function dayStreak(rows: ProgressRow[], now = new Date()): number {
  const days = new Set<string>();
  for (const row of rows) {
    const d = new Date(row.completedAt);
    if (!Number.isFinite(d.getTime())) continue;
    days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
  }
  if (!days.size) return 0;
  const cursor = new Date(now);
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  if (!days.has(key(cursor))) cursor.setDate(cursor.getDate() - 1); // grace day
  let streak = 0;
  while (days.has(key(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// ── Quiz — instant feedback per question, score handed up on completion ───────
function LessonQuiz({ lesson, onScore }: { lesson: TrainingLesson; onScore: (score: number | null) => void }) {
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const answeredCount = Object.keys(answers).length;
  const correctCount = lesson.quiz.reduce((acc, q, i) => acc + (answers[i] === q.answerIndex ? 1 : 0), 0);
  const allAnswered = answeredCount === lesson.quiz.length;
  const score = allAnswered ? Math.round((correctCount / lesson.quiz.length) * 100) : null;

  function choose(qi: number, oi: number) {
    if (answers[qi] !== undefined) return; // locked after first pick
    const next = { ...answers, [qi]: oi };
    setAnswers(next);
    if (Object.keys(next).length === lesson.quiz.length) {
      const correct = lesson.quiz.reduce((acc, q, i) => acc + (next[i] === q.answerIndex ? 1 : 0), 0);
      onScore(Math.round((correct / lesson.quiz.length) * 100));
    }
  }

  return (
    <div className="space-y-4" data-testid="lesson-quiz">
      <div className="flex items-baseline justify-between gap-3">
        <SectionLabel>Check yourself</SectionLabel>
        <span className="text-xs tabular-nums text-muted-foreground" data-testid="quiz-progress">
          {allAnswered ? `Score: ${score}%` : `${answeredCount} of ${lesson.quiz.length} answered`}
        </span>
      </div>
      {lesson.quiz.map((q, qi) => {
        const picked = answers[qi];
        const answered = picked !== undefined;
        return (
          <div key={qi} className="rounded-xl border border-border bg-card p-4" data-testid={`quiz-question-${qi}`}>
            <div className="text-sm font-semibold text-foreground">{q.question}</div>
            <div className="mt-3 space-y-1.5" role="group" aria-label={`Question ${qi + 1} options`}>
              {q.options.map((opt, oi) => {
                const isCorrect = oi === q.answerIndex;
                const isPicked = picked === oi;
                return (
                  <button
                    key={oi}
                    type="button"
                    disabled={answered}
                    onClick={() => choose(qi, oi)}
                    data-testid={`quiz-q${qi}-opt${oi}`}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[13px] transition-colors",
                      FOCUS,
                      !answered && "border-border bg-background hover:border-primary/40 hover:bg-secondary/50",
                      answered && isCorrect && "border-success/50 bg-success/[0.08] text-foreground",
                      answered && isPicked && !isCorrect && "border-destructive/50 bg-destructive/[0.08] text-foreground",
                      answered && !isPicked && !isCorrect && "border-border bg-background opacity-55",
                    )}
                  >
                    <span
                      className={cn(
                        "grid h-5 w-5 shrink-0 place-items-center rounded-full border text-2xs font-bold",
                        answered && isCorrect ? "border-success bg-success text-white"
                          : answered && isPicked ? "border-destructive bg-destructive text-white"
                          : "border-border text-muted-foreground",
                      )}
                      aria-hidden="true"
                    >
                      {answered && isCorrect ? <Check className="h-3 w-3" /> : String.fromCharCode(65 + oi)}
                    </span>
                    <span className="min-w-0 flex-1">{opt}</span>
                  </button>
                );
              })}
            </div>
            {answered && (
              <div
                className={cn(
                  "mt-3 rounded-lg px-3 py-2 text-xs leading-relaxed",
                  picked === q.answerIndex ? "bg-success/[0.08]" : "bg-destructive/[0.08]",
                )}
                data-testid={`quiz-q${qi}-feedback`}
              >
                <span className={cn("font-semibold", picked === q.answerIndex ? "text-success" : "text-destructive")}>
                  {picked === q.answerIndex ? "Correct. " : "Not quite. "}
                </span>
                <span className="text-muted-foreground">{q.explanation}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Lesson reader ─────────────────────────────────────────────────────────────
function LessonView({
  lesson, module: mod, isComplete, savedScore, onBack, onComplete, onOpenLesson, saving,
}: {
  lesson: TrainingLesson;
  module: TrainingModule;
  isComplete: boolean;
  savedScore: number | null;
  onBack: () => void;
  onComplete: (quizScore: number | null) => void;
  onOpenLesson: (lessonId: string) => void;
  saving: boolean;
}) {
  const [quizScore, setQuizScore] = useState<number | null>(null);
  return (
    <div className="space-y-5" data-testid={`lesson-view-${lesson.id}`}>
      <button
        type="button"
        onClick={onBack}
        data-testid="lesson-back"
        className={cn("-ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground", FOCUS)}
      >
        <span aria-hidden="true">&lsaquo;</span> Back
      </button>

      <div>
        <SectionLabel>{mod.title}</SectionLabel>
        <h2 className="mt-1 text-lg font-bold tracking-tight text-foreground">{lesson.title}</h2>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">{lesson.minutes} min read</span>
          {isComplete && (
            <Chip tone="good">Completed{savedScore != null ? ` · ${savedScore}%` : ""}</Chip>
          )}
        </div>
      </div>

      <div className="space-y-5">
        {lesson.sections.map((s, i) => (
          <section key={i}>
            <h3 className="text-[15px] font-semibold text-foreground">{s.heading}</h3>
            {s.body.map((p, j) => (
              <p key={j} className="mt-2 text-sm leading-relaxed text-muted-foreground">{p}</p>
            ))}
          </section>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-card p-4" data-testid="lesson-takeaways">
        <SectionLabel>Key takeaways</SectionLabel>
        <ul className="mt-3 space-y-2">
          {lesson.keyTakeaways.map((t, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm text-foreground">
              <Check aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="leading-snug">{t}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-xl border border-primary/25 bg-primary/[0.06] p-4" data-testid="lesson-drill">
        <SectionLabel className="text-primary">Try this on your next 10 doors</SectionLabel>
        <p className="mt-2 text-sm leading-relaxed text-foreground">{lesson.drillPrompt}</p>
      </div>

      {lesson.pitchDrill && <PitchRecorder prompt={lesson.pitchDrill} persistKey={lesson.id} />}

      <LessonQuiz lesson={lesson} onScore={setQuizScore} />

      <div className="flex flex-wrap items-center gap-3 pb-6">
        <PrimaryButton
          disabled={saving}
          onClick={() => onComplete(quizScore)}
          testId="lesson-mark-complete"
          className={isComplete ? "border border-border bg-secondary text-foreground" : undefined}
        >
          {isComplete ? "Save again" : "Mark lesson complete"}
        </PrimaryButton>
        {isComplete && (() => {
          const next = nextTrainingLesson(lesson.id);
          return next ? (
            <PrimaryButton onClick={() => onOpenLesson(next.id)} testId="lesson-next">
              Next lesson <span aria-hidden="true">&rsaquo;</span>
            </PrimaryButton>
          ) : (
            <span className="text-xs font-semibold text-success">That was the last lesson. Curriculum done.</span>
          );
        })()}
        {quizScore == null && !isComplete && (
          <span className="text-xs text-muted-foreground">Finish the quiz to record a score.</span>
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function Training() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [section, setSection] = useState<SectionId>("path");
  const [openLessonId, setOpenLessonId] = useState<string | null>(null);
  const [showFullRun, setShowFullRun] = useState(false);
  const [rolePlayPersona, setRolePlayPersona] = useState<PersonaId | "any" | null>(null);
  const [rehearsalScript, setRehearsalScript] = useState<string | null>(null);
  const [focusCardId, setFocusCardId] = useState<string | null>(null);

  const canSeeTeam = ["team_lead", "manager", "admin", "super_admin"].includes(user?.role ?? "rep");
  const canManage = ["admin", "super_admin", "manager"].includes(user?.role ?? "rep");
  const isAdmin = ["admin", "super_admin"].includes(user?.role ?? "rep");
  const pitchSupported = isPitchRecorderSupported();

  // The list to lesson swap happens inside ONE route, so the app's scroll
  // container never resets on its own. Reset it here, in a layout effect, so
  // the new view paints at the top rather than mid-quiz.
  useLayoutEffect(() => {
    document.querySelector(".app-route-stage")?.scrollTo({ top: 0 });
  }, [openLessonId, showFullRun, section, rolePlayPersona, rehearsalScript]);

  // ── Lesson progress (unchanged contract) ────────────────────────────────────
  const { data, isLoading, isError, refetch } = useQuery<ProgressPayload>({
    queryKey: PROGRESS_KEY,
    queryFn: async () => (await apiRequest("GET", "/api/training/progress")).json(),
    staleTime: 30_000,
  });

  const academy = useAcademyProgress();
  const offers = useAcademyOffers();
  const completeActivity = useCompleteActivity();

  const completedById = useMemo(() => {
    const map = new Map<string, ProgressRow>();
    for (const row of data?.completed ?? []) map.set(row.lessonId, row);
    return map;
  }, [data]);

  const completeMutation = useMutation({
    mutationFn: async ({ lessonId, quizScore }: { lessonId: string; quizScore: number | null }) => {
      const res = await apiRequest(
        "POST",
        `/api/training/lessons/${lessonId}/complete`,
        quizScore == null ? {} : { quizScore },
      );
      return res.json() as Promise<ProgressRow>;
    },
    onMutate: async ({ lessonId, quizScore }) => {
      await queryClient.cancelQueries({ queryKey: PROGRESS_KEY });
      const previous = queryClient.getQueryData<ProgressPayload>(PROGRESS_KEY);
      queryClient.setQueryData<ProgressPayload>(PROGRESS_KEY, (old) => {
        const base: ProgressPayload = old ?? { totalLessons: TOTAL_TRAINING_LESSONS, completed: [] };
        const rest = base.completed.filter((r) => r.lessonId !== lessonId);
        const prior = base.completed.find((r) => r.lessonId === lessonId);
        return {
          ...base,
          completed: [...rest, {
            lessonId,
            completedAt: new Date().toISOString(),
            quizScore: quizScore ?? prior?.quizScore ?? null,
          }],
        };
      });
      return { previous };
    },
    // The optimistic ring just told the rep it worked, so a silent rollback IS
    // the bug: a gated new hire can "finish", walk off, and stay locked out.
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(PROGRESS_KEY, ctx.previous);
      toast({
        variant: "destructive",
        title: "Couldn't save your progress",
        description: "Tap Mark lesson complete again when you have signal.",
      });
    },
    onSettled: () => { queryClient.invalidateQueries({ queryKey: PROGRESS_KEY }); },
  });

  // Completing a path lesson also satisfies the path activity that points at
  // it, so the two views never disagree about what is finished.
  function completeLesson(lessonId: string, quizScore: number | null) {
    completeMutation.mutate({ lessonId, quizScore });
    const activity = academy.data?.path.stages
      .flatMap((s) => s.stage.activities)
      .find((a) => a.lessonId === lessonId);
    if (activity) completeActivity.mutate({ activityId: activity.id, score: quizScore });
  }

  const doneCount = completedById.size;
  const streak = useMemo(() => dayStreak(data?.completed ?? []), [data]);
  const openLesson = openLessonId ? getTrainingLesson(openLessonId) : undefined;
  const openModule = openLessonId ? getTrainingModuleForLesson(openLessonId) : undefined;

  const assignments = academy.data ? openAssignments(academy.data.assignments) : [];
  const objectionKeysDone = useMemo(() => {
    const done = new Set<string>();
    for (const record of academy.data?.records ?? []) {
      const match = /^act-objection-(.+)$/.exec(record.activityId);
      if (match) done.add(match[1]);
    }
    return done;
  }, [academy.data]);
  const readCardIds = useMemo(() => {
    const ids = new Set<string>();
    for (const record of academy.data?.records ?? []) {
      const activity = academy.data?.path.stages
        .flatMap((s) => s.stage.activities)
        .find((a) => a.id === record.activityId);
      if (activity?.cardId) ids.add(activity.cardId);
    }
    return ids;
  }, [academy.data]);

  const tabs = useMemo(() => {
    const base: { id: SectionId; label: string; badge?: number }[] = [
      { id: "path", label: "Path", badge: assignments.length },
      { id: "practice", label: "Practice" },
      { id: "pitch", label: "Pitch Lab" },
      { id: "objections", label: "Objections" },
      { id: "reference", label: "Reference" },
      { id: "library", label: "Library" },
    ];
    if (canSeeTeam) base.push({ id: "team", label: "Team" });
    return base;
  }, [assignments.length, canSeeTeam]);

  // ── Full-screen sub-views ───────────────────────────────────────────────────
  if (showFullRun) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-5 p-4 pb-24 pt-5 md:p-6 md:pb-10">
        <FullPitchRun onBack={() => setShowFullRun(false)} />
      </div>
    );
  }

  if (openLesson && openModule) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-5 p-4 pb-24 pt-5 md:p-6 md:pb-10">
        <LessonView
          // Keyed by lesson: "Next lesson" swaps the prop on a mounted view, and
          // without the remount the previous lesson's quiz score would be
          // submitted for the new one.
          key={openLesson.id}
          lesson={openLesson}
          module={openModule}
          isComplete={completedById.has(openLesson.id)}
          savedScore={completedById.get(openLesson.id)?.quizScore ?? null}
          saving={completeMutation.isPending}
          onBack={() => setOpenLessonId(null)}
          onComplete={(quizScore) => completeLesson(openLesson.id, quizScore)}
          onOpenLesson={setOpenLessonId}
        />
      </div>
    );
  }

  if (rolePlayPersona) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-5 p-4 pb-24 pt-5 md:p-6 md:pb-10">
        <Suspense fallback={<PanelSkeleton rows={4} testId="roleplay-loading" />}>
          <RolePlayCoach
            offers={offers.data?.offers ?? []}
            market={offers.data?.market ?? ""}
            initialPersonaId={rolePlayPersona === "any" ? undefined : rolePlayPersona}
            onBack={() => setRolePlayPersona(null)}
          />
        </Suspense>
      </div>
    );
  }

  if (rehearsalScript) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-5 p-4 pb-24 pt-5 md:p-6 md:pb-10">
        <button
          type="button"
          onClick={() => setRehearsalScript(null)}
          data-testid="rehearsal-back"
          className={cn("-ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-muted-foreground hover:text-foreground", FOCUS)}
        >
          <span aria-hidden="true">&lsaquo;</span> Back to the Pitch Lab
        </button>
        <PageHeader title="Rehearse your pitch" subtitle="Read it at door pace, then listen back. Nothing leaves your device." />
        <PitchRecorder prompt={rehearsalScript} persistKey="academy-pitch" />
      </div>
    );
  }

  // ── The tab ─────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-4 pb-24 pt-5 md:p-6 md:pb-10">
      <div className="hf-stagger space-y-5">
        <TrainingGateBanner />
        <TrainingClearedBanner />
        {isAdmin && <TrainingAccessPanel />}

        <PageHeader
          title="Fiber Sales Academy"
          subtitle="Everything you need for a real conversation at a real door, in the order you need it."
        />

        {/* Hero. Three numbers a rep can move today. */}
        <div className="rounded-2xl border border-border bg-card p-4 md:p-5" data-testid="training-hero">
          <div className="flex items-center gap-4">
            <Ring
              done={academy.data?.path.done ?? 0}
              total={academy.data?.path.total ?? 0}
              size={56}
              tone={academy.data?.path.percent === 100 ? "gold" : "primary"}
            />
            <div className="min-w-0 flex-1">
              <SectionLabel>Your path</SectionLabel>
              <div className="mt-0.5 text-xl font-bold tabular-nums tracking-tight text-foreground" data-testid="training-hero-count">
                {/* On error the count is UNKNOWN, not zero: "0 of 30" told a
                    finished rep their progress had been reset. */}
                {academy.isLoading || academy.isError ? " - " : `${academy.data?.path.done ?? 0} of ${academy.data?.path.total ?? 0}`}{" "}
                {/* BOTH, deliberately. The inherited `{" "}` renders collapsed
                    against the tabular-nums run (the hero read "58activities
                    done"), so the margin is what produces the visible gap. The
                    space still has to be in the DOM, because a screen reader
                    reads the text node, not the margin. */}
                <span className="ml-1.5 text-sm font-medium text-muted-foreground">activities done</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-500",
                    (academy.data?.path.percent ?? 0) >= 100 ? "bg-success" : "bg-primary",
                  )}
                  style={{ width: `${academy.data?.path.percent ?? 0}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                About {TOTAL_PATH_MINUTES} minutes end to end. Nothing has to be done in one sitting.
              </p>
            </div>
            <div className="flex shrink-0 flex-col gap-2">
              <div
                className={cn(
                  "flex flex-col items-center rounded-xl border px-3 py-2",
                  streak > 0 ? "border-[hsl(var(--accent-gold))]/30 bg-[hsl(var(--accent-gold-soft))]" : "border-border bg-secondary/40",
                )}
                data-testid="training-streak"
              >
                <span className="text-sm font-bold tabular-nums leading-none text-foreground">{streak}</span>
                <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">day streak</span>
              </div>
              <div className="hidden flex-col items-center rounded-xl border border-border bg-secondary/40 px-3 py-2 sm:flex" data-testid="training-lessons-done">
                <span className="text-sm font-bold tabular-nums leading-none text-foreground">
                  {isLoading || isError ? " - " : doneCount}
                </span>
                <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">lessons</span>
              </div>
            </div>
          </div>
          {isError && (
            <div className="mt-3">
              <QuietButton onClick={() => refetch()} testId="training-progress-retry">
                Progress didn't load. Retry
              </QuietButton>
            </div>
          )}
        </div>

        {/* Certifications and assignments. Only when there is something to say. */}
        {academy.data && (
          <>
            {assignments.length > 0 && (
              <Panel tone="accent" testId="academy-assignments">
                <SectionLabel className="text-primary">
                  Assigned to you
                </SectionLabel>
                <ul className="mt-2 space-y-2">
                  {assignments.slice(0, 3).map((a) => (
                    <li key={a.id} className="text-[13px] leading-relaxed text-foreground">
                      <span className="font-semibold">
                        {academy.data!.path.stages.find((s) => s.stage.id === a.targetId)?.stage.title ?? a.targetId}
                      </span>
                      {a.dueOn && <span className="text-muted-foreground"> · due {a.dueOn}</span>}
                      {a.note && <span className="block text-xs text-muted-foreground">{a.note}</span>}
                    </li>
                  ))}
                </ul>
              </Panel>
            )}

            {academy.data.certifications.some((c) => c.earned) && (
              <div data-testid="academy-certifications">
                <SectionLabel className="mb-1.5 px-1">Earned</SectionLabel>
                <div className="flex flex-wrap gap-1.5">
                  {academy.data.certifications.filter((c) => c.earned).map((c) => (
                    <Chip key={c.certification.id} tone="gold">{c.certification.title}</Chip>
                  ))}
                </div>
              </div>
            )}

            {academy.data.practiceAreas.length > 0 && (
              <Panel testId="academy-practice-areas">
                <SectionLabel>Worth practising</SectionLabel>
                <ul className="mt-2 space-y-2">
                  {academy.data.practiceAreas.map((area) => (
                    <li key={area.dimension} className="text-[13px] leading-relaxed">
                      <span className="font-semibold text-foreground">{area.label}</span>
                      <span className="text-muted-foreground"> · {area.suggestion}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </>
        )}

        <SectionTabs tabs={tabs} value={section} onChange={setSection} />
      </div>

      {/* ── Sections ─────────────────────────────────────────────────────────── */}
      {section === "path" && (
        academy.isLoading ? <PanelSkeleton rows={5} />
          : academy.isError ? (
            <ErrorPanel
              title="Your path didn't load"
              description="Nothing is lost. Your progress is on the server."
              onRetry={() => academy.refetch()}
            />
          ) : academy.data ? (
            <PathView
              progress={academy.data.path}
              records={academy.data.records}
              offers={offers.data?.offers ?? []}
              headline={offers.data?.headline ?? null}
              market={offers.data?.market ?? ""}
              onOpenLesson={setOpenLessonId}
              onOpenReference={(cardId) => { setFocusCardId(cardId); setSection("reference"); }}
            />
          ) : null
      )}

      {section === "practice" && (
        <div className="space-y-4" data-testid="academy-practice">
          <button
            type="button"
            onClick={() => setRolePlayPersona("any")}
            data-testid="open-roleplay"
            className={cn(
              "flex w-full items-center gap-4 rounded-2xl border border-primary/30 bg-primary/[0.08] p-4 text-left transition-colors hover:bg-primary/[0.14]",
              FOCUS,
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-bold text-foreground">Practise on a real door</span>
              <span className="block text-[13px] leading-snug text-muted-foreground">
                Ten households, by voice or by text. They push back, ask follow-ups, and walk away if you earn it.
                Everything runs on your device.
              </span>
            </span>
            <span aria-hidden="true" className="shrink-0 text-primary">&rsaquo;</span>
          </button>

          <button
            type="button"
            onClick={() => setShowFullRun(true)}
            data-testid="open-full-pitch-run"
            className={cn(
              "flex w-full items-center gap-4 rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-secondary/50",
              FOCUS,
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-bold text-foreground">Run the full pitch</span>
              <span className="block text-[13px] leading-snug text-muted-foreground">
                Four beats, one 30-second take, then the door talks back. About three minutes.
              </span>
            </span>
            <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">&rsaquo;</span>
          </button>

          {pitchSupported && (
            <button
              type="button"
              onClick={() => setRehearsalScript("Say your own opener, then your discovery question, then the one benefit this household would feel, then your ask.")}
              data-testid="open-pitch-practice"
              className={cn(
                "flex w-full items-center gap-4 rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:bg-secondary/50",
                FOCUS,
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-bold text-foreground">Record and listen back</span>
                <span className="block text-[13px] leading-snug text-muted-foreground">
                  Hear your own pace. The audio never leaves your phone.
                </span>
              </span>
              <span aria-hidden="true" className="shrink-0 text-muted-foreground/50">&rsaquo;</span>
            </button>
          )}

          <NumbersGame />
          <PsychologyDeck />
        </div>
      )}

      {section === "pitch" && (
        <PitchLab
          activityId={null}
          resume={null}
          offer={offers.data?.headline ?? null}
          onRehearse={(script) => setRehearsalScript(script)}
        />
      )}

      {section === "objections" && (
        <ObjectionDojo
          completedKeys={objectionKeysDone}
          onComplete={(key) => completeActivity.mutate({ activityId: `act-objection-${key}` })}
          onPractise={(personaId) => setRolePlayPersona(personaId)}
        />
      )}

      {section === "reference" && (
        offers.isLoading ? <PanelSkeleton rows={4} />
          : offers.isError ? (
            <ErrorPanel
              title="The reference library didn't load"
              description="Offers and competitor figures could not be fetched. Do not quote numbers from memory."
              onRetry={() => offers.refetch()}
            />
          ) : (
            <ReferenceLibrary
              offers={offers.data?.offers ?? []}
              expired={offers.data?.expired ?? []}
              competitors={offers.data?.competitors ?? []}
              day={offers.data?.day ?? ""}
              market={offers.data?.market ?? null}
              readCardIds={readCardIds}
              focusCardId={focusCardId}
              onCloseCard={() => setFocusCardId(null)}
            />
          )
      )}

      {section === "library" && (
        <div className="space-y-4" data-testid="academy-library">
          <p className="px-1 text-[13px] leading-relaxed text-muted-foreground">
            The full curriculum, {TOTAL_TRAINING_LESSONS} lessons across {TRAINING_MODULES.length} modules. The path
            above pulls the important ones into order; this is everything, for when you want to go deeper on one thing.
          </p>
          {TRAINING_MODULES.map((mod, mi) => {
            const modDone = mod.lessons.filter((l) => completedById.has(l.id)).length;
            return (
              <div key={mod.id} className="overflow-hidden rounded-2xl border border-border bg-card" data-testid={`training-module-${mod.id}`}>
                <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
                  <Ring done={modDone} total={mod.lessons.length} />
                  <div className="min-w-0 flex-1">
                    <SectionLabel>Module {mi + 1}</SectionLabel>
                    <div className="text-[15px] font-bold leading-snug tracking-tight text-foreground">{mod.title}</div>
                    <div className="line-clamp-2 text-xs text-muted-foreground">{mod.tagline}</div>
                  </div>
                </div>
                <div className="divide-y divide-border">
                  {mod.lessons.map((lesson) => {
                    const done = completedById.has(lesson.id);
                    const score = completedById.get(lesson.id)?.quizScore ?? null;
                    return (
                      <button
                        key={lesson.id}
                        type="button"
                        onClick={() => setOpenLessonId(lesson.id)}
                        data-testid={`training-lesson-${lesson.id}`}
                        className={cn("flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-secondary/50", FOCUS)}
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            "grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px] font-bold",
                            done ? "border-success bg-success text-white" : "border-border bg-background text-muted-foreground",
                          )}
                        >
                          {done && <Check className="h-3.5 w-3.5" />}
                        </span>
                        {/* Titles carry their meaning in the tail, so they must
                            wrap. The summary stays one line: it is a teaser. */}
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-semibold leading-snug text-foreground">{lesson.title}</span>
                          <span className="block truncate text-xs text-muted-foreground">{lesson.summary}</span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
                          {score != null && <span className="rounded-full bg-secondary px-1.5 py-0.5 font-semibold">{score}%</span>}
                          <span>{lesson.minutes} min</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {section === "team" && canSeeTeam && (
        <Suspense fallback={<PanelSkeleton rows={4} testId="supervisor-loading" />}>
          <SupervisorPanel canManage={canManage} />
        </Suspense>
      )}

      {/* A quiet footer note so the ten objections are discoverable from the
          path even before a rep reaches that stage. */}
      {section === "path" && (
        <p className="px-1 text-xs text-muted-foreground">
          {ACADEMY_OBJECTIONS.length} objections are drilled in their own tab, and everything you may quote in your
          market is under Reference.
        </p>
      )}
    </div>
  );
}
