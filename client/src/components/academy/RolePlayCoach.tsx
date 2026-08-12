// ── Role-play coach ───────────────────────────────────────────────────────────
//
// A simulated door the rep can practise on by typing or by talking. The
// customer is driven entirely by shared/academyRolePlay.ts, which is pure and
// runs on the device: no model call, no network, nothing paid for, and it works
// between houses with no signal.
//
// VOICE
//   Input is the browser's SpeechRecognition, output is speechSynthesis. Both
//   are feature-detected; where either is missing the text mode is the whole
//   experience rather than a degraded one. Speaking the customer's line is
//   opt-in and off under reduced motion, because an unrequested voice is the
//   same kind of intrusion as unrequested animation.
//
// LAZY BY CONSTRUCTION
//   This module is imported through React.lazy from the Training page, so a rep
//   who never opens a role-play never downloads the engine, the personas or the
//   scorer. That is the single biggest thing keeping the tab fast on LTE.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/lib/a11y";
import { SectionLabel } from "@/components/ui/page-scaffold";
import { BackLink, Chip, Panel, PrimaryButton, QuietButton } from "./primitives";
import ScoreReport from "./ScoreReport";
import {
  cancelSpeech, isSpeechOutputSupported, isVoiceInputSupported, speakLine,
  useReducedMotion, useSubmitRolePlay, useVoiceInput,
} from "@/lib/useAcademy";
import { ACADEMY_PERSONAS, getPersona, SIGNAL_LABELS, type PersonaId } from "@shared/academyPersonas";
import { endSession, respond, startSession, type RolePlaySession } from "@shared/academyRolePlay";
import { scoreSession, type SessionScore } from "@shared/academyScoring";
import type { AcademyOffer } from "@shared/academyOffers";

type Phase = "picking" | "briefing" | "talking" | "report";

/** A session id that is also the engine seed. Stable per drill, so a stored
 *  transcript replays identically. */
function newSessionId(): string {
  const rand = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  return `rp-${rand}`;
}

export default function RolePlayCoach({
  offers, market, initialPersonaId, onBack, onScored,
}: {
  offers: AcademyOffer[];
  market: string;
  initialPersonaId?: PersonaId;
  onBack: () => void;
  /** Fired with the server-confirmed score, so the path can mark the activity. */
  onScored?: (score: SessionScore) => void;
}) {
  const reduced = useReducedMotion();
  const submit = useSubmitRolePlay();
  const [phase, setPhase] = useState<Phase>(initialPersonaId ? "briefing" : "picking");
  const [personaId, setPersonaId] = useState<PersonaId | null>(initialPersonaId ?? null);
  const [session, setSession] = useState<RolePlaySession | null>(null);
  const [draft, setDraft] = useState("");
  const [score, setScore] = useState<SessionScore | null>(null);
  const [speakBack, setSpeakBack] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const persona = personaId ? getPersona(personaId) : undefined;
  const voiceSupported = useMemo(() => isVoiceInputSupported(), []);
  const speechSupported = useMemo(() => isSpeechOutputSupported(), []);

  const send = useCallback((text: string) => {
    const clean = text.trim();
    if (!clean) return;
    setSession((prev) => {
      if (!prev || prev.outcome !== "in_progress") return prev;
      const next = respond(prev, clean, { offers });
      const lastCustomer = [...next.turns].reverse().find((t) => t.role === "customer");
      if (lastCustomer && speakBack && !reduced) speakLine(lastCustomer.text, true);
      return next;
    });
    setDraft("");
  }, [offers, speakBack, reduced]);

  const voice = useVoiceInput(send);

  // Keep the newest turn in view. Instant under reduced motion.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [session?.turns.length, reduced]);

  useEffect(() => () => cancelSpeech(), []);

  function begin(id: PersonaId) {
    setPersonaId(id);
    setSession(null);
    setScore(null);
    setPhase("briefing");
  }

  function startTalking() {
    if (!personaId) return;
    const fresh = startSession({ id: newSessionId(), personaId, market });
    setSession(fresh);
    setPhase("talking");
    if (speakBack && !reduced) speakLine(fresh.turns[0].text, true);
    // Focus the composer so a keyboard user is not hunting for it.
    window.setTimeout(() => inputRef.current?.focus(), 50);
  }

  function finish(current: RolePlaySession) {
    voice.stop();
    cancelSpeech();
    const ended = current.outcome === "in_progress" ? endSession(current) : current;
    // Score locally so the report paints instantly, then take the server's
    // recomputed version as the record of truth when it lands.
    const local = scoreSession(ended, { offers });
    setSession(ended);
    setScore(local);
    setPhase("report");
    submit.mutate({ session: ended, mode: voiceSupported && voice.state !== "unsupported" ? "voice" : "text" }, {
      onSuccess: (result) => {
        if (result?.score) { setScore(result.score); onScored?.(result.score); }
        else onScored?.(local);
      },
      onError: () => onScored?.(local),
    });
  }

  // The engine ends the conversation on its own terms. When it does, roll
  // straight into the report rather than leaving a dead composer on screen.
  useEffect(() => {
    if (session && session.outcome !== "in_progress" && phase === "talking") finish(session);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.outcome]);

  // ── Persona picker ──────────────────────────────────────────────────────────
  if (phase === "picking") {
    return (
      <div className="space-y-4" data-testid="roleplay-picker">
        <BackLink label="Back to practice" onClick={onBack} />
        <div>
          <h2 className="text-lg font-bold tracking-tight text-foreground">Pick a door</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Ten households you will actually meet. Each one behaves differently, and each one is beaten by a different
            thing. Everything runs on your device.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {ACADEMY_PERSONAS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => begin(p.id)}
              data-testid={`roleplay-persona-${p.id}`}
              className={cn(
                "flex min-h-11 flex-col items-start gap-1 rounded-2xl border border-border bg-card p-3.5 text-left",
                "transition-colors hover:border-primary/40 hover:bg-secondary/50",
                FOCUS,
              )}
            >
              <span className="text-[13px] font-bold text-foreground">{p.label}</span>
              <span className="text-xs leading-snug text-muted-foreground">{p.summary}</span>
              <span className="mt-1 flex flex-wrap gap-1">
                <Chip tone="neutral">{p.patience} turns of patience</Chip>
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Briefing ────────────────────────────────────────────────────────────────
  if (phase === "briefing" && persona) {
    return (
      <div className="space-y-4" data-testid="roleplay-briefing">
        <BackLink label="Pick a different door" onClick={() => setPhase("picking")} />
        <div>
          <SectionLabel>{persona.label}</SectionLabel>
          <h2 className="mt-1 text-lg font-bold tracking-tight text-foreground">{persona.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{persona.summary}</p>
        </div>

        <Panel tone="accent">
          <SectionLabel className="text-primary">Before you knock</SectionLabel>
          <ul className="mt-2 space-y-2">
            {persona.briefing.map((line, i) => (
              <li key={i} className="text-[13px] leading-relaxed text-foreground">{line}</li>
            ))}
          </ul>
        </Panel>

        <Panel>
          <SectionLabel>What moves this person</SectionLabel>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {persona.wins.map((w) => <Chip key={w} tone="info">{SIGNAL_LABELS[w]}</Chip>)}
          </div>
        </Panel>

        {(voiceSupported || speechSupported) && (
          <Panel testId="roleplay-voice-options">
            <SectionLabel>Voice</SectionLabel>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {voiceSupported
                ? "You can talk instead of typing. Nothing is uploaded: the recognition runs in your browser."
                : "This browser cannot listen, so this drill is typed. Everything else works the same."}
            </p>
            {speechSupported && (
              <div className="mt-3">
                <QuietButton
                  onClick={() => setSpeakBack((v) => !v)}
                  pressed={speakBack}
                  testId="roleplay-speak-toggle"
                >
                  {speakBack ? "Customer speaks out loud" : "Customer stays silent"}
                </QuietButton>
                {reduced && speakBack && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Your system asks for reduced motion, so the customer voice stays off during the drill.
                  </p>
                )}
              </div>
            )}
          </Panel>
        )}

        <PrimaryButton onClick={startTalking} testId="roleplay-start" full>Knock on the door</PrimaryButton>
      </div>
    );
  }

  // ── Report ──────────────────────────────────────────────────────────────────
  if (phase === "report" && score && session) {
    return (
      <div className="space-y-4">
        <BackLink label="Back to practice" onClick={onBack} />
        {submit.isPending && (
          <p className="text-xs text-muted-foreground" role="status">Saving this session...</p>
        )}
        <ScoreReport
          score={score}
          session={session}
          onRunAgain={() => { setScore(null); startTalking(); }}
          onDone={onBack}
        />
      </div>
    );
  }

  // ── The conversation ────────────────────────────────────────────────────────
  if (!session || !persona) return null;
  const live = session.outcome === "in_progress";
  const patiencePct = Math.max(0, Math.round((session.patience / persona.patience) * 100));

  return (
    <div className="flex flex-col gap-3" data-testid="roleplay-conversation">
      <div className="flex items-center justify-between gap-3">
        <BackLink label="End and score" onClick={() => finish(session)} testId="roleplay-end" />
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {persona.name}
          </span>
          {/* Patience is the honest tension in the drill, so it is visible. */}
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                patiencePct > 60 ? "bg-success" : patiencePct > 30 ? "bg-warning" : "bg-destructive",
              )}
              style={{ width: `${patiencePct}%` }}
            />
          </div>
          <span className="sr-only">Patience remaining {patiencePct} percent</span>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="max-h-[52vh] space-y-3 overflow-y-auto rounded-2xl border border-border bg-card p-4"
        style={{ overscrollBehavior: "contain" }}
        role="log"
        aria-label="Conversation"
        aria-live="polite"
      >
        {session.turns.map((turn, i) => (
          <div key={i} className={cn("max-w-[85%]", turn.role === "rep" && "ml-auto", !reduced && "hf-rise")}>
            <div className="mb-0.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              {turn.role === "rep" ? "You" : persona.name}
            </div>
            <div
              className={cn(
                "rounded-2xl border px-3.5 py-2.5 text-[13px] leading-relaxed",
                turn.role === "rep"
                  ? "rounded-tr-sm border-primary/25 bg-primary/[0.07] text-foreground"
                  : "rounded-tl-sm border-border bg-secondary/60 text-foreground",
              )}
            >
              {turn.text}
            </div>
            {turn.role === "rep" && turn.violations.length > 0 && (
              <p className="mt-1 text-[11px] leading-snug text-destructive">{turn.violations[0].message}</p>
            )}
          </div>
        ))}
        {voice.interim && (
          <div className="ml-auto max-w-[85%] opacity-60">
            <div className="rounded-2xl rounded-tr-sm border border-dashed border-primary/30 px-3.5 py-2.5 text-[13px] italic text-muted-foreground">
              {voice.interim}
            </div>
          </div>
        )}
      </div>

      {live ? (
        <form
          onSubmit={(e) => { e.preventDefault(); send(draft); }}
          className="space-y-2"
        >
          <label htmlFor="roleplay-input" className="sr-only">What do you say</label>
          <textarea
            id="roleplay-input"
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, shift-enter breaks the line. A door turn is one or
              // two sentences, so sending is the common case.
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(draft); }
            }}
            rows={2}
            placeholder="Say it the way you would at the door"
            data-testid="roleplay-input"
            className={cn(
              "w-full resize-none rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm leading-relaxed text-foreground",
              "placeholder:text-muted-foreground",
              FOCUS,
            )}
          />
          <div className="flex flex-wrap items-center gap-2">
            <PrimaryButton type="submit" disabled={!draft.trim()} testId="roleplay-send">Say it</PrimaryButton>
            {voiceSupported && (
              <QuietButton
                onClick={() => (voice.state === "listening" ? voice.stop() : voice.start())}
                pressed={voice.state === "listening"}
                testId="roleplay-mic"
              >
                {voice.state === "listening" ? "Listening, tap to stop" : "Talk instead"}
              </QuietButton>
            )}
            <QuietButton onClick={() => finish(session)} testId="roleplay-finish">End and score</QuietButton>
          </div>
          {voice.state === "denied" && (
            <p className="text-xs text-destructive" role="status">
              The microphone is blocked for this site. Type your turn, or allow the mic in your browser settings.
            </p>
          )}
        </form>
      ) : (
        <PrimaryButton onClick={() => finish(session)} testId="roleplay-see-report" full>See your report</PrimaryButton>
      )}
    </div>
  );
}
