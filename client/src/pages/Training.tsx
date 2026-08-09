// Training — the D2D psychology & pitch curriculum, rendered from the shared
// content file. Progress is server-backed (training_progress) and optimistic:
// tapping "Mark complete" updates the rings instantly, then reconciles.
//
// Page grammar follows the house style: PageHeader + eyebrow SectionLabels,
// StatStrip-style hero numbers (tabular-nums), Linear-style lesson rows, and
// tokens only (bg-card / border-border / rounded-xl / FOCUS).
import { useLayoutEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  GraduationCap,
  ChevronLeft,
  ChevronRight,
  Check,
  CheckCircle2,
  Circle,
  Flame,
  Lightbulb,
  Target,
  RefreshCw,
  Users,
  Zap,
  Mic,
  ArrowRight,
  MessageSquare,
} from "lucide-react";
import NumbersGame from "@/components/training/NumbersGame";
import PsychologyDeck from "@/components/training/PsychologyDeck";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { FOCUS } from "@/lib/a11y";
import { cn } from "@/lib/utils";
import { PageHeader, SectionLabel } from "@/components/ui/page-scaffold";
import { TrainingGateBanner, TrainingClearedBanner } from "@/components/TrainingLock";
import { TrainingAccessPanel } from "@/components/TrainingAccessPanel";
import PitchRecorder, { isPitchRecorderSupported } from "@/components/training/PitchRecorder";
import FullPitchRun from "@/components/training/FullPitchRun";
import {
  TRAINING_MODULES,
  TRAINING_LESSONS,
  TOTAL_TRAINING_LESSONS,
  TRAINING_FAST_START,
  getFastStartLessons,
  getTrainingLesson,
  getTrainingModuleForLesson,
  type TrainingLesson,
  type TrainingModule,
} from "@shared/trainingContent";

/** The lesson after this one in curriculum order, or undefined at the end. */
function nextTrainingLesson(lessonId: string): TrainingLesson | undefined {
  const i = TRAINING_LESSONS.findIndex((l) => l.id === lessonId);
  return i >= 0 ? TRAINING_LESSONS[i + 1] : undefined;
}

type ProgressRow = { lessonId: string; completedAt: string; quizScore: number | null };
type ProgressPayload = { totalLessons: number; completed: ProgressRow[] };
type SummaryRow = { userId: number; name: string; role: string; completedCount: number; avgQuizScore: number | null; lastCompletedAt: string | null };
type SummaryPayload = { totalLessons: number; reps: SummaryRow[] };

const PROGRESS_KEY = ["/api/training/progress"];

// ── Day streak — computed, not stored ─────────────────────────────────────────
// Consecutive local days with at least one lesson completed, ending today or
// yesterday (yesterday keeps the flame alive until tonight — the Duolingo rule,
// because a streak that dies while you sleep teaches resentment, not habit).
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

// ── Progress ring — SVG, tokens only, number in tabular-nums ─────────────────
function ProgressRing({ done, total, size = 44 }: { done: number; total: number; size?: number }) {
  const stroke = 3.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? done / total : 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} aria-hidden="true">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-border" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round"
          className={cn("transition-[stroke-dashoffset] duration-500 ease-out", pct >= 1 ? "stroke-emerald-500" : "stroke-primary")}
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)}
        />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-[11px] font-bold tabular-nums text-foreground">
        {done}/{total}
      </span>
    </div>
  );
}

// ── Quiz — instant feedback per question, score handed up on completion ───────
function LessonQuiz({ lesson, onScore }: { lesson: TrainingLesson; onScore: (score: number | null) => void }) {
  // answers[i] = chosen option index, or undefined
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const answeredCount = Object.keys(answers).length;
  const correctCount = lesson.quiz.reduce((acc, q, i) => acc + (answers[i] === q.answerIndex ? 1 : 0), 0);
  const allAnswered = answeredCount === lesson.quiz.length;
  const score = allAnswered ? Math.round((correctCount / lesson.quiz.length) * 100) : null;

  function choose(qi: number, oi: number) {
    if (answers[qi] !== undefined) return; // locked after first pick — instant feedback, no retries
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
                      answered && isCorrect && "border-emerald-500/50 bg-emerald-500/10 text-foreground",
                      answered && isPicked && !isCorrect && "border-red-500/50 bg-red-500/10 text-foreground",
                      answered && !isPicked && !isCorrect && "border-border bg-background opacity-55",
                    )}
                  >
                    <span
                      className={cn(
                        "grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[10px] font-bold",
                        answered && isCorrect ? "border-emerald-500 bg-emerald-500 text-white"
                          : answered && isPicked ? "border-red-500 bg-red-500 text-white"
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
                  picked === q.answerIndex ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-red-500/10 text-red-600 dark:text-red-400",
                )}
                data-testid={`quiz-q${qi}-feedback`}
              >
                <span className="font-semibold">{picked === q.answerIndex ? "Correct. " : "Not quite. "}</span>
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
        className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 -ml-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground", FOCUS)}
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" /> All modules
      </button>

      <div>
        <SectionLabel>{mod.title}</SectionLabel>
        <h2 className="mt-1 text-lg font-bold tracking-tight text-foreground">{lesson.title}</h2>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">{lesson.minutes} min read</span>
          {isComplete && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-1.5 py-0.5 font-semibold text-emerald-600 dark:text-emerald-400">
              <Check className="h-3 w-3" aria-hidden="true" /> Completed{savedScore != null ? ` · ${savedScore}%` : ""}
            </span>
          )}
        </div>
      </div>

      {/* Readable body */}
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

      {/* Key takeaways */}
      <div className="rounded-xl border border-border bg-card p-4" data-testid="lesson-takeaways">
        <div className="flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-primary" aria-hidden="true" />
          <SectionLabel>Key takeaways</SectionLabel>
        </div>
        <ul className="mt-3 space-y-2">
          {lesson.keyTakeaways.map((t, i) => (
            <li key={i} className="flex items-start gap-2.5 text-sm text-foreground">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
              <span className="leading-snug">{t}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Field drill */}
      <div className="rounded-xl border border-primary/25 bg-primary/[0.06] p-4" data-testid="lesson-drill">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-primary" aria-hidden="true" />
          <SectionLabel className="text-primary">Try this on your next 10 doors</SectionLabel>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-foreground">{lesson.drillPrompt}</p>
      </div>

      {/* Pitch practice — only on lessons that carry a spoken-pitch drill */}
      {lesson.pitchDrill && <PitchRecorder prompt={lesson.pitchDrill} persistKey={lesson.id} />}

      <LessonQuiz lesson={lesson} onScore={setQuizScore} />

      <div className="flex flex-wrap items-center gap-3 pb-6">
        <button
          type="button"
          disabled={saving}
          onClick={() => onComplete(quizScore)}
          data-testid="lesson-mark-complete"
          className={cn(
            "inline-flex min-h-11 items-center gap-2 rounded-xl px-5 text-sm font-semibold transition-transform active:scale-[.98] disabled:opacity-60",
            FOCUS,
            isComplete ? "border border-border bg-secondary text-foreground" : "bg-primary text-primary-foreground",
          )}
        >
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          {isComplete ? "Save again" : "Mark lesson complete"}
        </button>
        {/* Completing used to dead-end here: the only feedback was this button
            relabeling. Momentum is the whole game in a 113-lesson curriculum,
            so once complete, the primary action becomes the NEXT lesson. */}
        {isComplete && (() => {
          const next = nextTrainingLesson(lesson.id);
          return next ? (
            <button
              type="button"
              onClick={() => onOpenLesson(next.id)}
              data-testid="lesson-next"
              className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground transition-transform active:scale-[.98]",
                FOCUS,
              )}
            >
              Next lesson <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          ) : (
            <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
              That was the last lesson. Curriculum done.
            </span>
          );
        })()}
        {quizScore == null && !isComplete && (
          <span className="text-xs text-muted-foreground">Finish the quiz to record a score.</span>
        )}
      </div>
    </div>
  );
}

// ── Manager rollup table ──────────────────────────────────────────────────────
function TeamProgressTable() {
  const { data, isLoading, isError } = useQuery<SummaryPayload>({
    queryKey: ["/api/training/summary"],
    queryFn: async () => (await apiRequest("GET", "/api/training/summary")).json(),
    staleTime: 60_000,
  });
  if (isLoading || isError) return null;
  const reps = data?.reps ?? [];
  const total = data?.totalLessons ?? TOTAL_TRAINING_LESSONS;
  if (!reps.length) return null;
  return (
    <div data-testid="training-team-table">
      <div className="mb-1.5 flex items-center gap-2 px-1">
        <Users className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <SectionLabel>Team progress</SectionLabel>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-semibold">Rep</th>
                <th className="px-4 py-2.5 text-right font-semibold">Lessons</th>
                <th className="px-4 py-2.5 text-right font-semibold">Avg quiz</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {reps.map((r) => (
                <tr key={r.userId} data-testid={`training-team-row-${r.userId}`}>
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-foreground">{r.name}</div>
                    <div className="text-xs capitalize text-muted-foreground">{r.role.replace("_", " ")}</div>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-foreground">
                    {r.completedCount}<span className="text-muted-foreground"> / {total}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                    {r.avgQuizScore != null ? `${r.avgQuizScore}%` : " - "}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Fast-start track ──────────────────────────────────────────────────────────
// The "get door-ready in 15 minutes" curated path, surfaced at the top for reps
// who have barely started. Pure references into the existing lessons.
function FastStartTrack({
  completedById, onOpen,
}: {
  completedById: Map<string, ProgressRow>;
  onOpen: (lessonId: string) => void;
}) {
  const steps = getFastStartLessons();
  if (!steps.length) return null;
  return (
    <div className="rounded-2xl border border-primary/30 bg-primary/[0.06] p-4 md:p-5" data-testid="fast-start-track">
      <div className="flex items-center gap-2">
        <Zap className="h-4 w-4 text-primary" aria-hidden="true" />
        <SectionLabel className="text-primary">Get door-ready in 15 minutes</SectionLabel>
      </div>
      <p className="mt-1 text-sm leading-relaxed text-foreground">
        New here? Start with these five. They are the highest-leverage lessons on the whole board - enough to knock your
        first block with a real pitch instead of winging it.
      </p>
      <ol className="mt-3 space-y-1.5">
        {steps.map(({ step, lesson }, i) => {
          const done = completedById.has(lesson.id);
          return (
            <li key={lesson.id}>
              <button
                type="button"
                onClick={() => onOpen(lesson.id)}
                data-testid={`fast-start-step-${lesson.id}`}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-secondary/50",
                  FOCUS,
                )}
              >
                <span
                  className={cn(
                    "grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold tabular-nums",
                    done ? "bg-emerald-500 text-white" : "bg-primary text-primary-foreground",
                  )}
                  aria-hidden="true"
                >
                  {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  {/* Wrap, don't truncate: the differentiating words are at the end. */}
                  <span className="block text-[13px] font-semibold leading-snug text-foreground">{lesson.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{step.why}</span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ── Standalone pitch practice ─────────────────────────────────────────────────
// The headline feature reachable from the header: rehearse the two pitches every
// rep needs cold, without hunting for the right lesson first.
const STANDALONE_PITCH_LESSON_IDS = ["m3-pitch-skeleton", "m9-ten-second-pitch"] as const;

function PitchPracticeView({ onBack }: { onBack: () => void }) {
  const lessons = STANDALONE_PITCH_LESSON_IDS
    .map((id) => getTrainingLesson(id))
    .filter((l): l is TrainingLesson => !!l && !!l.pitchDrill);
  return (
    <div className="space-y-5" data-testid="pitch-practice-view">
      <button
        type="button"
        onClick={onBack}
        data-testid="pitch-practice-back"
        className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 -ml-2 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground", FOCUS)}
      >
        <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Back to training
      </button>
      <PageHeader
        icon={Mic}
        title="Pitch practice"
        subtitle="Record your pitch, hear it back, and tighten it before you hit the doors."
      />
      <div className="space-y-4">
        {lessons.map((lesson) => (
          <div key={lesson.id}>
            <SectionLabel className="mb-1.5 px-1">{lesson.title}</SectionLabel>
            <PitchRecorder prompt={lesson.pitchDrill!} persistKey={`standalone-${lesson.id}`} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function Training() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [openLessonId, setOpenLessonId] = useState<string | null>(null);
  const [showPitchPractice, setShowPitchPractice] = useState(false);
  const [showFullRun, setShowFullRun] = useState(false);

  // The list ⇄ lesson swap happens inside ONE route, so the app's scroll
  // container (App.tsx keys it by location) never resets. Without this a rep
  // opening a module-10 lesson from thousands of px down the list lands in the
  // middle of the quiz, not at the title. Layout effect so the reset paints
  // with the new view, not a frame after it.
  useLayoutEffect(() => {
    document.querySelector(".app-route-stage")?.scrollTo({ top: 0 });
  }, [openLessonId, showPitchPractice, showFullRun]);
  const canSeeTeam = ["admin", "manager", "super_admin"].includes(user?.role ?? "rep");
  const isAdmin = ["admin", "super_admin"].includes(user?.role ?? "rep");
  const pitchSupported = isPitchRecorderSupported();

  const { data, isLoading, isError, refetch } = useQuery<ProgressPayload>({
    queryKey: PROGRESS_KEY,
    queryFn: async () => (await apiRequest("GET", "/api/training/progress")).json(),
    // Persisted (queryClient PERSISTED_QUERY_KEYS) + a short staleTime: after
    // one warm visit the page paints its real numbers instantly from cache and
    // reconciles in the background — no skeleton, no dash.
    staleTime: 30_000,
  });

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
    // Optimistic: the ring and hero move the instant the rep taps.
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
    // The optimistic ring/streak just told the rep it worked, so a silent
    // rollback IS the bug: a gated new hire can "finish", walk off, and stay
    // locked out. Say it failed, in words, while they are still on the lesson.
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(PROGRESS_KEY, ctx.previous);
      toast({
        variant: "destructive",
        title: "Couldn't save your progress",
        description: "Tap Mark lesson complete again when you have signal.",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: PROGRESS_KEY });
    },
  });

  const doneCount = completedById.size;
  const total = TOTAL_TRAINING_LESSONS;
  const streak = useMemo(() => dayStreak(data?.completed ?? []), [data]);
  const avgQuiz = useMemo(() => {
    const scores = (data?.completed ?? []).map(r => r.quizScore).filter((s): s is number => s != null);
    return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  }, [data]);
  const openLesson = openLessonId ? getTrainingLesson(openLessonId) : undefined;
  const openModule = openLessonId ? getTrainingModuleForLesson(openLessonId) : undefined;
  // Surface the fast-start track while a rep is still ramping — once they have
  // cleared the curated five, they no longer need the "start here" scaffold.
  const showFastStart = doneCount < TRAINING_FAST_START.length;

  return (
    <div className="hf-stagger mx-auto w-full max-w-4xl space-y-5 p-4 pb-24 pt-5 md:p-6 md:pb-10">
      {showFullRun ? (
        <FullPitchRun onBack={() => setShowFullRun(false)} />
      ) : showPitchPractice ? (
        <PitchPracticeView onBack={() => setShowPitchPractice(false)} />
      ) : openLesson && openModule ? (
        <LessonView
          // Keyed by lesson: "Next lesson" swaps the lesson prop on a mounted
          // view, and without the remount the previous lesson's local quiz
          // score would be submitted for the new one.
          key={openLesson.id}
          lesson={openLesson}
          module={openModule}
          isComplete={completedById.has(openLesson.id)}
          savedScore={completedById.get(openLesson.id)?.quizScore ?? null}
          saving={completeMutation.isPending}
          onBack={() => setOpenLessonId(null)}
          onComplete={(quizScore) => completeMutation.mutate({ lessonId: openLesson.id, quizScore })}
          onOpenLesson={setOpenLessonId}
        />
      ) : (
        <>
          {/* Why the rest of the app is closed, stated where the rep can act on
              it — and the one-time "you're in" when they clear it. */}
          <TrainingGateBanner />
          <TrainingClearedBanner />
          {/* Admin lock/unlock console. Lives on the Training page because that
              is where someone goes when they are thinking about who has and has
              not been trained. */}
          {isAdmin && <TrainingAccessPanel />}
          <PageHeader
            icon={GraduationCap}
            title="Training"
            subtitle="Door-to-door psychology and pitch craft, built for the field."
            actions={
              pitchSupported ? (
                <button
                  type="button"
                  onClick={() => setShowPitchPractice(true)}
                  data-testid="open-pitch-practice"
                  className={cn(
                    "inline-flex min-h-11 items-center gap-2 rounded-xl border border-primary/30 bg-primary/[0.08] px-4 text-sm font-semibold text-primary transition-colors hover:bg-primary/[0.14]",
                    FOCUS,
                  )}
                >
                  <Mic className="h-4 w-4" aria-hidden="true" /> Pitch practice
                </button>
              ) : undefined
            }
          />

          {/* Overall progress hero — ring, streak flame, quiz average. Three
              numbers a rep can move today, side by side, Opal-style. */}
          <div className="rounded-2xl border border-border bg-card p-4 md:p-5" data-testid="training-hero">
            <div className="flex items-center gap-4">
              <ProgressRing done={doneCount} total={total} size={56} />
              <div className="min-w-0 flex-1">
                <SectionLabel>Your progress</SectionLabel>
                <div className="mt-0.5 text-xl font-bold tabular-nums tracking-tight text-foreground" data-testid="training-hero-count">
                  {/* On error the count is UNKNOWN, not zero — "0 of 30" told a
                      finished rep their progress had been reset. */}
                  {isLoading || isError ? " - " : `${doneCount} of ${total}`}{" "}
                  <span className="text-sm font-medium text-muted-foreground">lessons complete</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                  <div
                    className={cn("h-full rounded-full transition-all duration-500", doneCount >= total ? "bg-emerald-500" : "bg-primary")}
                    style={{ width: `${total > 0 ? Math.round((doneCount / total) * 100) : 0}%` }}
                  />
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <div
                  className={cn(
                    "flex flex-col items-center rounded-xl border px-3 py-2",
                    streak > 0 ? "border-orange-500/30 bg-orange-500/10" : "border-border bg-secondary/40",
                  )}
                  data-testid="training-streak"
                >
                  <Flame className={cn("h-4 w-4", streak > 0 ? "text-orange-500" : "text-muted-foreground/50")} aria-hidden="true" />
                  <span className="mt-0.5 text-sm font-bold tabular-nums leading-none text-foreground">{streak}</span>
                  <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">day streak</span>
                </div>
                <div className="hidden flex-col items-center rounded-xl border border-border bg-secondary/40 px-3 py-2 sm:flex" data-testid="training-avg-quiz">
                  <Target className="h-4 w-4 text-primary" aria-hidden="true" />
                  <span className="mt-0.5 text-sm font-bold tabular-nums leading-none text-foreground">{avgQuiz != null ? `${avgQuiz}%` : " - "}</span>
                  <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">avg quiz</span>
                </div>
              </div>
            </div>
            {isError && (
              <button
                type="button"
                onClick={() => refetch()}
                data-testid="training-progress-retry"
                className={cn("mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-secondary px-4 text-sm font-semibold text-foreground", FOCUS)}
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" /> Progress didn't load. Retry
              </button>
            )}
          </div>

          {/* The flagship drill gets a full-width door, not a header button:
              the complete pitch as one rehearsal, then live objections. */}
          <button
            type="button"
            onClick={() => setShowFullRun(true)}
            data-testid="open-full-pitch-run"
            className={cn(
              "flex w-full items-center gap-4 rounded-2xl border border-primary/30 bg-primary/[0.08] p-4 text-left transition-colors hover:bg-primary/[0.14]",
              FOCUS,
            )}
          >
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground">
              <Mic className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-bold text-foreground">Run the full pitch</span>
              <span className="block text-[13px] text-muted-foreground">
                Four beats, one 30-second take, then the door talks back. About three minutes.
              </span>
            </span>
            <ChevronRight className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          </button>

          {/* Fast-start track - "start here" for reps still ramping */}
          {showFastStart && <FastStartTrack completedById={completedById} onOpen={setOpenLessonId} />}

          {/* The interactive layer - motivation as arithmetic, psychology as a
              deck. These are the parts a rep opens twice. */}
          <NumbersGame />
          <PsychologyDeck />

          {/* Manager rollup */}
          {canSeeTeam && <TeamProgressTable />}

          {/* Modules */}
          <div className="space-y-4">
            {TRAINING_MODULES.map((mod, mi) => {
              const modDone = mod.lessons.filter((l) => completedById.has(l.id)).length;
              return (
                <div key={mod.id} className="overflow-hidden rounded-2xl border border-border bg-card" data-testid={`training-module-${mod.id}`}>
                  <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
                    <ProgressRing done={modDone} total={mod.lessons.length} />
                    <div className="min-w-0 flex-1">
                      <SectionLabel>Module {mi + 1}</SectionLabel>
                      <div className="text-[15px] font-bold leading-snug tracking-tight text-foreground">{mod.title}</div>
                      <div className="line-clamp-2 text-xs text-muted-foreground">{mod.tagline}</div>
                    </div>
                  </div>

                  {/* Engagement layer - punchy hook, a real-talk field story, and
                      one say-this-not-that swap. All optional and additive. */}
                  {(mod.hook || mod.fieldStory || mod.sayThisNotThat) && (
                    <div className="space-y-3 border-b border-border bg-secondary/20 px-4 py-3" data-testid={`training-module-engagement-${mod.id}`}>
                      {mod.hook && (
                        <p className="flex items-start gap-2 text-[13px] font-semibold leading-snug text-foreground">
                          <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                          <span>{mod.hook}</span>
                        </p>
                      )}
                      {mod.fieldStory && (
                        <div className="rounded-lg border border-border bg-card p-3">
                          <SectionLabel className="text-primary">Real talk</SectionLabel>
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{mod.fieldStory}</p>
                        </div>
                      )}
                      {mod.sayThisNotThat && (
                        <div className="rounded-lg border border-border bg-card p-3" data-testid={`training-say-this-${mod.id}`}>
                          <div className="flex items-center gap-1.5">
                            <MessageSquare className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                            <SectionLabel className="text-primary">Say this, not that</SectionLabel>
                          </div>
                          <div className="mt-2 space-y-1.5 text-xs leading-relaxed">
                            <p className="flex items-start gap-2 text-muted-foreground line-through decoration-red-500/50">
                              <span aria-hidden="true" className="font-semibold text-red-500/80 no-underline">Not</span>
                              <span>{mod.sayThisNotThat.instead}</span>
                            </p>
                            <p className="flex items-start gap-2 text-foreground">
                              <span aria-hidden="true" className="font-semibold text-emerald-500">Say</span>
                              <span>{mod.sayThisNotThat.say}</span>
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

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
                          {done ? (
                            <CheckCircle2 className="h-[18px] w-[18px] shrink-0 text-emerald-500" aria-hidden="true" />
                          ) : (
                            <Circle className="h-[18px] w-[18px] shrink-0 text-muted-foreground/40" aria-hidden="true" />
                          )}
                          {/* Titles carry their meaning in the tail ("the assumptive
                              close: the full play" vs "…: the full pl…"), so they
                              must wrap, not truncate. The summary stays one line -
                              it is a teaser, and the lesson page has the rest. */}
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-semibold leading-snug text-foreground">{lesson.title}</span>
                            <span className="block truncate text-xs text-muted-foreground">{lesson.summary}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
                            {score != null && <span className="rounded-full bg-secondary px-1.5 py-0.5 font-semibold">{score}%</span>}
                            <span>{lesson.minutes} min</span>
                            <ChevronRight className="h-4 w-4 text-muted-foreground/50" aria-hidden="true" />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
