// ── Speech trainer ────────────────────────────────────────────────────────────
//
// Three rungs from reading a pitch to owning one:
//
//   1. READ IT       the script, beat by beat, out loud at door pace.
//   2. FILL THE GAPS the same script with the load-bearing words blanked.
//                    Recall is the step reading skips, so it gets its own rung.
//   3. FROM MEMORY   the script hidden. Speak it (or type it), and the same
//                    offline classifier the role-play scorer uses checks that
//                    all four beats actually came out of your mouth: an opener,
//                    a question, a benefit, an ask.
//
// The script is the rep's own Pitch Lab draft when one exists, so they memorise
// the pitch they will actually say; otherwise a sound default assembled from
// approved blocks. No audio leaves the device, nothing here is scored against
// anyone, and a peek at the script is a button, not a failure.

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { useAuth } from "@/lib/auth";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { Chip, DoneDot, Panel, PrimaryButton, QuietButton } from "./primitives";
import { useActivityAutosave, useResumeState, useVoiceInput } from "@/lib/useAcademy";
import type { PitchLabState } from "./PitchLab";
import { CATEGORY_LABELS, getPitchBlock, renderBlock } from "@shared/academyPitchBlocks";
import { classify, type RepIntent } from "@shared/academyRolePlay";
import type { AcademyOffer } from "@shared/academyOffers";

export type SpeechTrainerState = { step: number };

/** A sound default: no tokens, so it renders whole even with no live offer. */
const DEFAULT_BLOCK_IDS = ["intro-build-crew", "disc-current-provider", "ben-work-calls", "close-two-slots"];

const BEATS: readonly { key: string; label: string; intents: readonly RepIntent[] }[] = [
  { key: "opener", label: "Opener: who you are and why this street", intents: ["identity", "reason"] },
  { key: "question", label: "Question: ask before you pitch", intents: ["permission", "discovery"] },
  { key: "benefit", label: "Benefit: an outcome they feel", intents: ["benefit", "proof"] },
  { key: "ask", label: "Ask: one concrete next step", intents: ["close"] },
];

type ScriptLine = { label: string; text: string };

export default function SpeechTrainer({
  offer, activityId = null, resume = null, onComplete,
}: {
  offer: AcademyOffer | null;
  activityId?: string | null;
  resume?: SpeechTrainerState | null;
  onComplete?: () => void;
}) {
  const { user } = useAuth();
  const [step, setStep] = useState(() => Math.min(Math.max(resume?.step ?? 0, 0), 2));
  useActivityAutosave(activityId, useMemo(() => ({ step }), [step]));

  // The rep's own draft, straight from the Pitch Lab's saved state.
  const draft = useResumeState<PitchLabState>("act-pitch-lab");
  const lines = useMemo<ScriptLine[]>(() => {
    // The Pitch Lab leaves {name} for the rep on purpose; here the rep is
    // memorising their own opener, so their own name belongs in it.
    const name = user?.name?.trim().split(/\s+/)[0] || "your name";
    const finish = (text: string) => text.replaceAll("{name}", name);
    const ids = draft?.blockIds?.length ? draft.blockIds : DEFAULT_BLOCK_IDS;
    const built = ids
      .map((id) => getPitchBlock(id))
      .filter((b): b is NonNullable<typeof b> => !!b)
      .map((block) => {
        const rendered = renderBlock(block, offer);
        return rendered.unresolved.length > 0
          ? null
          : { label: CATEGORY_LABELS[block.category], text: finish(rendered.text) };
      })
      .filter((l): l is ScriptLine => !!l);
    if (built.length >= 3) return built;
    // A draft of one block, or one full of unresolved tokens, is not enough to
    // memorise. Fall back to the default rather than training a fragment.
    return DEFAULT_BLOCK_IDS
      .map((id) => getPitchBlock(id)!)
      .map((block) => ({ label: CATEGORY_LABELS[block.category], text: finish(renderBlock(block, offer).text) }));
  }, [draft, offer, user]);

  const usingDraft = !!draft?.blockIds?.length && lines.length >= 3;

  return (
    <div className="space-y-4" data-testid="speech-trainer">
      <div className="flex flex-wrap gap-2">
        <QuietButton pressed={step === 0} onClick={() => setStep(0)} testId="speech-step-read">1. Read it</QuietButton>
        <QuietButton pressed={step === 1} onClick={() => setStep(1)} testId="speech-step-gaps">2. Fill the gaps</QuietButton>
        <QuietButton pressed={step === 2} onClick={() => setStep(2)} testId="speech-step-memory">3. From memory</QuietButton>
      </div>

      <p className="px-1 text-xs text-muted-foreground" data-testid="speech-script-source">
        {usingDraft
          ? "This is your own pitch from the Pitch Lab."
          : "This is the standard pitch from approved blocks. Build your own in the Pitch Lab and it will appear here instead."}
      </p>

      {step === 0 && <ReadStep lines={lines} onNext={() => setStep(1)} />}
      {step === 1 && <GapsStep lines={lines} onNext={() => setStep(2)} />}
      {step === 2 && <MemoryStep lines={lines} onComplete={onComplete} />}
    </div>
  );
}

// ── Rung 1: read it ───────────────────────────────────────────────────────────

function ReadStep({ lines, onNext }: { lines: ScriptLine[]; onNext: () => void }) {
  return (
    <div className="space-y-3" data-testid="speech-read">
      <Panel tone="accent">
        <SectionLabel className="text-primary">Out loud, twice</SectionLabel>
        <p className="mt-1 text-[13px] leading-relaxed text-foreground">
          Door pace, standing up if you can. Reading silently stores the shape of the pitch; saying it stores the pitch.
        </p>
      </Panel>
      <ScriptCard lines={lines} />
      <PrimaryButton onClick={onNext} testId="speech-read-next">I read it out loud</PrimaryButton>
    </div>
  );
}

function ScriptCard({ lines }: { lines: ScriptLine[] }) {
  return (
    <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
      {lines.map((line, i) => (
        <div key={i}>
          <SectionLabel>{line.label}</SectionLabel>
          <p className="mt-0.5 text-[15px] leading-relaxed text-foreground">{line.text}</p>
        </div>
      ))}
    </div>
  );
}

// ── Rung 2: fill the gaps ─────────────────────────────────────────────────────

/** Blank roughly every third content word. Deterministic, so the same script
 *  always drops the same words and progress feels like progress. */
function cloze(text: string): string {
  let contentIndex = 0;
  return text
    .split(/(\s+)/)
    .map((token) => {
      if (!/\w/.test(token)) return token;
      const core = token.replace(/[^\w'$.]/g, "");
      if (core.length < 4) return token;
      contentIndex += 1;
      if (contentIndex % 3 !== 0) return token;
      return token.replace(/[\w'$.]+/, (m) => "_".repeat(Math.min(m.length, 10)));
    })
    .join("");
}

function GapsStep({ lines, onNext }: { lines: ScriptLine[]; onNext: () => void }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="space-y-3" data-testid="speech-gaps">
      <Panel tone="accent">
        <SectionLabel className="text-primary">Say the missing words</SectionLabel>
        <p className="mt-1 text-[13px] leading-relaxed text-foreground">
          Read it out loud again, filling every blank from memory. Check yourself when you are done, then hide it and
          run it once more clean.
        </p>
      </Panel>
      <div className="space-y-3 rounded-2xl border border-border bg-card p-4">
        {lines.map((line, i) => (
          <div key={i}>
            <SectionLabel>{line.label}</SectionLabel>
            <p className="mt-0.5 text-[15px] leading-relaxed tracking-wide text-foreground" data-testid={`speech-gap-line-${i}`}>
              {revealed ? line.text : cloze(line.text)}
            </p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <QuietButton onClick={() => setRevealed((v) => !v)} pressed={revealed} testId="speech-gaps-reveal">
          {revealed ? "Hide the words again" : "Check the full script"}
        </QuietButton>
        <PrimaryButton onClick={onNext} testId="speech-gaps-next">I can fill every gap</PrimaryButton>
      </div>
    </div>
  );
}

// ── Rung 3: from memory ───────────────────────────────────────────────────────

function MemoryStep({ lines, onComplete }: { lines: ScriptLine[]; onComplete?: () => void }) {
  const [utterances, setUtterances] = useState<string[]>([]);
  const [typed, setTyped] = useState("");
  const [peek, setPeek] = useState(false);
  const voice = useVoiceInput((text) => setUtterances((u) => [...u, text]));

  const classified = useMemo(() => utterances.map((text) => ({ text, result: classify(text) })), [utterances]);
  const intents = useMemo(() => new Set(classified.flatMap((c) => c.result.intents)), [classified]);
  const violations = useMemo(
    () => classified.flatMap((c) => c.result.violations).filter((v) => v.kind !== "ignored_no"),
    [classified],
  );
  const covered = BEATS.filter((b) => b.intents.some((i) => intents.has(i)));
  const allCovered = covered.length === BEATS.length;

  function addTyped() {
    const text = typed.trim();
    if (!text) return;
    setUtterances((u) => [...u, text]);
    setTyped("");
  }

  return (
    <div className="space-y-3" data-testid="speech-memory">
      <Panel tone="accent">
        <SectionLabel className="text-primary">Script hidden. Your turn</SectionLabel>
        <p className="mt-1 text-[13px] leading-relaxed text-foreground">
          Deliver the whole pitch from memory, one beat at a time. The same engine that scores role-play listens for the
          four beats below. It runs on your device and nothing is recorded or sent anywhere.
        </p>
      </Panel>

      {/* The four beats, lighting up as they land. */}
      <div className="rounded-2xl border border-border bg-card p-4" data-testid="speech-beats">
        <SectionLabel>The four beats</SectionLabel>
        <ul className="mt-2 space-y-2">
          {BEATS.map((beat) => {
            const done = beat.intents.some((i) => intents.has(i));
            return (
              <li key={beat.key} className="flex items-center gap-2.5" data-testid={`speech-beat-${beat.key}`}>
                <DoneDot done={done} />
                <span className={cn("text-[13px] leading-snug", done ? "font-semibold text-foreground" : "text-muted-foreground")}>
                  {beat.label}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Input: voice where the browser has it, typing everywhere. */}
      <div className="space-y-2">
        {voice.state !== "unsupported" && (
          <div className="flex flex-wrap items-center gap-2">
            {voice.state === "listening" ? (
              <PrimaryButton onClick={voice.stop} testId="speech-mic-stop">Stop listening</PrimaryButton>
            ) : (
              <PrimaryButton onClick={voice.start} disabled={voice.state === "denied"} testId="speech-mic-start">
                Speak the next beat
              </PrimaryButton>
            )}
            {voice.state === "denied" && (
              <span className="text-xs text-muted-foreground">Microphone was blocked. Type your lines below instead.</span>
            )}
            {voice.interim && (
              <span className="text-[13px] italic text-muted-foreground" data-testid="speech-interim">{voice.interim}</span>
            )}
          </div>
        )}
        <div className="flex gap-2">
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTyped(); } }}
            placeholder={voice.state === "unsupported" ? "Type a line of your pitch" : "Or type a line instead"}
            aria-label="Type a line of your pitch"
            data-testid="speech-typed-input"
            className={cn(
              "min-h-11 w-full flex-1 rounded-xl border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground",
              FOCUS,
            )}
          />
          <QuietButton onClick={addTyped} testId="speech-typed-add">Add</QuietButton>
        </div>
      </div>

      {/* What landed so far. */}
      {classified.length > 0 && (
        <div className="space-y-1.5" data-testid="speech-transcript">
          {classified.map((c, i) => (
            <div key={i} className="rounded-xl border border-border bg-card px-3 py-2">
              <p className="text-[13px] leading-relaxed text-foreground">{c.text}</p>
              {c.result.intents.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {BEATS.filter((b) => b.intents.some((i2) => c.result.intents.includes(i2))).map((b) => (
                    <Chip key={b.key} tone="info">{b.key}</Chip>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {violations.length > 0 && (
        <Panel tone="warn" testId="speech-violations">
          <SectionLabel className="text-warning">The scorer would flag this</SectionLabel>
          <ul className="mt-1 space-y-1">
            {violations.map((v, i) => (
              <li key={i} className="text-[13px] leading-relaxed text-foreground">{v.message}</li>
            ))}
          </ul>
        </Panel>
      )}

      {allCovered && (
        <Panel tone="accent" testId="speech-all-covered">
          <SectionLabel className="text-primary">All four beats, from memory</SectionLabel>
          <p className="mt-1 text-[13px] leading-relaxed text-foreground">
            That is a complete pitch with the script hidden. Run it once more without looking at this screen, then take
            it to a role-play door.
          </p>
          {onComplete && (
            <div className="mt-3">
              <PrimaryButton onClick={onComplete} testId="speech-complete">Done</PrimaryButton>
            </div>
          )}
        </Panel>
      )}

      <div className="flex flex-wrap gap-2">
        <QuietButton onClick={() => setPeek((v) => !v)} pressed={peek} testId="speech-peek">
          {peek ? "Hide the script" : "Peek at the script"}
        </QuietButton>
        {classified.length > 0 && (
          <QuietButton onClick={() => setUtterances([])} testId="speech-reset">Start the run over</QuietButton>
        )}
      </div>
      {peek && <ScriptCard lines={lines} />}
    </div>
  );
}
