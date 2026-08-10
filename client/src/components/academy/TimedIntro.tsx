// ── Timed introduction practice ───────────────────────────────────────────────
//
// A rep gets about ten seconds at a door. This drill makes that real: a running
// clock, a target band, and a self-check of the three things an opener must
// carry. Optionally it records the take through the existing PitchRecorder so
// the rep can hear their own pace, which is the part reading cannot teach.
//
// WHY THE SCORE IS PART SELF-REPORTED
//   The clock is measured. Whether they actually said their name and a reason
//   is not something a browser can hear reliably, and a wrong automatic score
//   on the one drill a rep repeats twenty times would poison the whole tab. So
//   the timing is objective and the content is a three-box honest check, which
//   is exactly the split the full pitch run already uses.
//
// REDUCED MOTION
//   The clock is a number and a rail. Under reduced motion the rail stops
//   animating its width and the number updates on a slower tick, so nothing on
//   screen moves continuously.

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { Chip, Panel, PrimaryButton, QuietButton } from "./primitives";
import { useReducedMotion } from "@/lib/useAcademy";

/** The band a door opener has to land inside. */
export const TARGET_MIN_SECONDS = 7;
export const TARGET_MAX_SECONDS = 12;
/** Anything past this is not an opener any more. */
const HARD_STOP_SECONDS = 40;

const CHECKS = [
  { id: "name", label: "You said your name and who you are with" },
  { id: "reason", label: "You said why you are on their street" },
  { id: "time", label: "You named how long this would take" },
] as const;

type CheckId = (typeof CHECKS)[number]["id"];

export type TimedIntroState = { bestScore: number | null; attempts: number };

export default function TimedIntro({
  resume, onComplete, onExit, passScore = 70,
}: {
  resume: TimedIntroState | null;
  onComplete: (score: number) => void;
  onExit: () => void;
  passScore?: number;
}) {
  const reduced = useReducedMotion();
  const [running, setRunning] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [finishedAt, setFinishedAt] = useState<number | null>(null);
  const [checks, setChecks] = useState<Record<CheckId, boolean>>({ name: false, reason: false, time: false });
  const [attempts, setAttempts] = useState(resume?.attempts ?? 0);
  const [best, setBest] = useState<number | null>(resume?.bestScore ?? null);
  const startedAt = useRef<number>(0);
  const raf = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTicking = useCallback(() => {
    if (raf.current) { clearInterval(raf.current); raf.current = null; }
  }, []);

  useEffect(() => stopTicking, [stopTicking]);

  const start = useCallback(() => {
    setChecks({ name: false, reason: false, time: false });
    setFinishedAt(null);
    setElapsedMs(0);
    startedAt.current = Date.now();
    setRunning(true);
    stopTicking();
    // 100ms normally, 1s under reduced motion: the number still counts, it just
    // stops being a continuously moving element.
    raf.current = setInterval(() => {
      const ms = Date.now() - startedAt.current;
      setElapsedMs(ms);
      if (ms >= HARD_STOP_SECONDS * 1000) {
        setRunning(false);
        setFinishedAt(HARD_STOP_SECONDS * 1000);
        stopTicking();
      }
    }, reduced ? 1000 : 100);
  }, [reduced, stopTicking]);

  const stop = useCallback(() => {
    stopTicking();
    setRunning(false);
    setFinishedAt(Date.now() - startedAt.current);
    setAttempts((a) => a + 1);
  }, [stopTicking]);

  const seconds = (finishedAt ?? elapsedMs) / 1000;
  const inBand = seconds >= TARGET_MIN_SECONDS && seconds <= TARGET_MAX_SECONDS;

  // Timing is 60 points, the three content checks are 40. An opener that is
  // perfectly timed but says nothing scores 60, which is the honest number: it
  // was the right length and the wrong content.
  const timingPoints = (() => {
    if (finishedAt == null) return 0;
    if (inBand) return 60;
    const distance = seconds < TARGET_MIN_SECONDS ? TARGET_MIN_SECONDS - seconds : seconds - TARGET_MAX_SECONDS;
    return Math.max(0, Math.round(60 - distance * 8));
  })();
  const contentPoints = Object.values(checks).filter(Boolean).length * (40 / 3);
  const score = finishedAt == null ? 0 : Math.round(timingPoints + contentPoints);
  const passed = score >= passScore;

  const railPct = Math.min(100, (seconds / TARGET_MAX_SECONDS) * 100);

  return (
    <div className="space-y-4" data-testid="timed-intro">
      <Panel tone="accent">
        <SectionLabel className="text-primary">Ten seconds, out loud</SectionLabel>
        <p className="mt-1 text-[13px] leading-relaxed text-foreground">
          Start the clock, say your opener at door pace, and stop it when you finish. The target is between{" "}
          {TARGET_MIN_SECONDS} and {TARGET_MAX_SECONDS} seconds: long enough to say something, short enough that they
          have not started closing the door.
        </p>
      </Panel>

      <Panel testId="timed-intro-clock">
        <div className="flex items-baseline justify-between gap-3">
          <span
            className={cn(
              "text-4xl font-bold tabular-nums tracking-tight",
              finishedAt == null ? "text-foreground" : inBand ? "text-success" : "text-warning",
            )}
            data-testid="timed-intro-seconds"
            aria-live={running ? "off" : "polite"}
          >
            {seconds.toFixed(1)}s
          </span>
          {finishedAt != null && (
            <Chip tone={inBand ? "good" : "warn"}>
              {inBand ? "Inside the band" : seconds < TARGET_MIN_SECONDS ? "Too short" : "Too long"}
            </Chip>
          )}
        </div>

        {/* The band is drawn on the rail so the target is visible, not remembered. */}
        <div className="relative mt-3 h-2 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
          <div
            className="absolute inset-y-0 bg-success/25"
            style={{
              left: `${(TARGET_MIN_SECONDS / TARGET_MAX_SECONDS) * 100}%`,
              right: "0%",
            }}
          />
          <div
            className={cn("h-full rounded-full", inBand ? "bg-success" : "bg-primary", !reduced && "transition-[width] duration-100 ease-linear")}
            style={{ width: `${railPct}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          <span>0s</span>
          <span>target {TARGET_MIN_SECONDS} to {TARGET_MAX_SECONDS}s</span>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {!running ? (
            <PrimaryButton onClick={start} testId="timed-intro-start">
              {finishedAt == null ? "Start the clock" : "Try again"}
            </PrimaryButton>
          ) : (
            <PrimaryButton onClick={stop} testId="timed-intro-stop">Stop</PrimaryButton>
          )}
          <QuietButton onClick={onExit} testId="timed-intro-exit">Leave for now</QuietButton>
        </div>
      </Panel>

      {finishedAt != null && (
        <Panel testId="timed-intro-checks">
          <SectionLabel>Honest check</SectionLabel>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            The clock is measured. This part is on you, and it only works if you are strict with yourself.
          </p>
          <div className="mt-3 space-y-2">
            {CHECKS.map((check) => (
              <label
                key={check.id}
                className={cn(
                  "flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 text-[13px] transition-colors",
                  checks[check.id] ? "border-success/40 bg-success/[0.06]" : "border-border bg-background hover:bg-secondary/50",
                )}
              >
                <input
                  type="checkbox"
                  checked={checks[check.id]}
                  onChange={(e) => setChecks((prev) => ({ ...prev, [check.id]: e.target.checked }))}
                  data-testid={`timed-intro-check-${check.id}`}
                  className="h-5 w-5 shrink-0 accent-[hsl(var(--primary))]"
                />
                <span className="text-foreground">{check.label}</span>
              </label>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="text-sm font-semibold tabular-nums text-foreground" data-testid="timed-intro-score">
              {score}%
            </span>
            <Chip tone={passed ? "good" : "warn"}>{passed ? "Counts as done" : `Needs ${passScore}%`}</Chip>
            <PrimaryButton
              onClick={() => {
                const next = best == null ? score : Math.max(best, score);
                setBest(next);
                onComplete(score);
              }}
              testId="timed-intro-save"
            >
              Save this take
            </PrimaryButton>
          </div>
          {attempts > 1 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Attempt {attempts}. Best so far {best == null ? score : Math.max(best, score)}%.
            </p>
          )}
        </Panel>
      )}
    </div>
  );
}
