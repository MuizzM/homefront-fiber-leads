// Training — the D2D psychology & pitch curriculum, rendered from the shared
// content file. Progress is server-backed (training_progress) and optimistic:
// tapping "Mark complete" updates the rings instantly, then reconciles.
//
// Page grammar follows the house style: PageHeader + eyebrow SectionLabels,
// StatStrip-style hero numbers (tabular-nums), Linear-style lesson rows, and
// tokens only (bg-card / border-border / rounded-xl / FOCUS).
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  GraduationCap,
  ChevronLeft,
  ChevronRight,
  Check,
  CheckCircle2,
  Circle,
  Lightbulb,
  Target,
  RefreshCw,
  Users,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { FOCUS } from "@/lib/a11y";
import { cn } from "@/lib/utils";
import { PageHeader, SectionLabel } from "@/components/ui/page-scaffold";
import {
  TRAINING_MODULES,
  TOTAL_TRAINING_LESSONS,
  getTrainingLesson,
  getTrainingModuleForLesson,
  type TrainingLesson,
  type TrainingModule,
} from "@shared/trainingContent";

type ProgressRow = { lessonId: string; completedAt: string; quizScore: number | null };
type ProgressPayload = { totalLessons: number; completed: ProgressRow[] };
type SummaryRow = { userId: number; name: string; role: string; completedCount: number; avgQuizScore: number | null; lastCompletedAt: string | null };
type SummaryPayload = { totalLessons: number; reps: SummaryRow[] };

const PROGRESS_KEY = ["/api/training/progress"];

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
          className={pct >= 1 ? "stroke-emerald-500" : "stroke-primary"}
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
  lesson, module: mod, isComplete, savedScore, onBack, onComplete, saving,
}: {
  lesson: TrainingLesson;
  module: TrainingModule;
  isComplete: boolean;
  savedScore: number | null;
  onBack: () => void;
  onComplete: (quizScore: number | null) => void;
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

      <LessonQuiz lesson={lesson} onScore={setQuizScore} />

      <div className="flex items-center gap-3 pb-6">
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
                    {r.avgQuizScore != null ? `${r.avgQuizScore}%` : "—"}
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

// ── Page ──────────────────────────────────────────────────────────────────────
export default function Training() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [openLessonId, setOpenLessonId] = useState<string | null>(null);
  const canSeeTeam = ["admin", "manager", "super_admin"].includes(user?.role ?? "rep");

  const { data, isLoading, isError, refetch } = useQuery<ProgressPayload>({
    queryKey: PROGRESS_KEY,
    queryFn: async () => (await apiRequest("GET", "/api/training/progress")).json(),
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
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(PROGRESS_KEY, ctx.previous);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: PROGRESS_KEY });
    },
  });

  const doneCount = completedById.size;
  const total = TOTAL_TRAINING_LESSONS;
  const openLesson = openLessonId ? getTrainingLesson(openLessonId) : undefined;
  const openModule = openLessonId ? getTrainingModuleForLesson(openLessonId) : undefined;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-4 pb-24 pt-5 md:p-6 md:pb-10">
      {openLesson && openModule ? (
        <LessonView
          lesson={openLesson}
          module={openModule}
          isComplete={completedById.has(openLesson.id)}
          savedScore={completedById.get(openLesson.id)?.quizScore ?? null}
          saving={completeMutation.isPending}
          onBack={() => setOpenLessonId(null)}
          onComplete={(quizScore) => completeMutation.mutate({ lessonId: openLesson.id, quizScore })}
        />
      ) : (
        <>
          <PageHeader
            icon={GraduationCap}
            title="Training"
            subtitle="Door-to-door psychology and pitch craft, built for the field."
          />

          {/* Overall progress hero */}
          <div className="rounded-2xl border border-border bg-card p-4 md:p-5" data-testid="training-hero">
            <div className="flex items-center gap-4">
              <ProgressRing done={doneCount} total={total} size={56} />
              <div className="min-w-0 flex-1">
                <SectionLabel>Your progress</SectionLabel>
                <div className="mt-0.5 text-xl font-bold tabular-nums tracking-tight text-foreground" data-testid="training-hero-count">
                  {isLoading ? "—" : `${doneCount} of ${total}`}{" "}
                  <span className="text-sm font-medium text-muted-foreground">lessons complete</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                  <div
                    className={cn("h-full rounded-full transition-all", doneCount >= total ? "bg-emerald-500" : "bg-primary")}
                    style={{ width: `${total > 0 ? Math.round((doneCount / total) * 100) : 0}%` }}
                  />
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
                <RefreshCw className="h-4 w-4" aria-hidden="true" /> Progress didn't load — retry
              </button>
            )}
          </div>

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
                      <div className="truncate text-[15px] font-bold tracking-tight text-foreground">{mod.title}</div>
                      <div className="truncate text-xs text-muted-foreground">{mod.tagline}</div>
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
                          {done ? (
                            <CheckCircle2 className="h-[18px] w-[18px] shrink-0 text-emerald-500" aria-hidden="true" />
                          ) : (
                            <Circle className="h-[18px] w-[18px] shrink-0 text-muted-foreground/40" aria-hidden="true" />
                          )}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-semibold text-foreground">{lesson.title}</span>
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
