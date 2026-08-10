// ── Academy client state ──────────────────────────────────────────────────────
//
// One query for the rep's whole path (progress, certifications, assignments,
// practice areas) and one for the market's live offers. Both are small, both
// are read on every Academy screen, and both reconcile in the background after
// painting from cache, so the tab opens instantly on a warm visit.
//
// Completion is optimistic for the same reason it is on the lesson list: a rep
// tapping "done" between two houses must see the ring move now, not after a
// round trip on LTE. The rollback path says so out loud rather than silently
// reverting, because a silent rollback is how a rep believes they finished
// something they did not.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { AcademyOffer, CompetitorOffer } from "@shared/academyOffers";
import type { ActivityRecord, Assignment, CertificationStatus, PathProgress, PracticeArea, TeamGap } from "@shared/academyProgress";
import type { RolePlaySession } from "@shared/academyRolePlay";
import type { SessionScore } from "@shared/academyScoring";

export const ACADEMY_PROGRESS_KEY = ["/api/training/academy/progress"];
export const ACADEMY_OFFERS_KEY = ["/api/training/academy/offers"];
export const ACADEMY_TEAM_KEY = ["/api/training/academy/team"];

export type AcademyProgressPayload = {
  records: ActivityRecord[];
  states: { activityId: string; state: unknown; updatedAt: string }[];
  path: PathProgress;
  certifications: CertificationStatus[];
  practiceAreas: PracticeArea[];
  assignments: Assignment[];
  rolePlayCount: number;
  rolePlayAverage: number | null;
};

export type OffersPayload = {
  day: string;
  market: string | null;
  version: number;
  offers: AcademyOffer[];
  expired: AcademyOffer[];
  headline: AcademyOffer | null;
  competitors: CompetitorOffer[];
};

export type RolePlaySummary = {
  sessionId: string;
  personaId: string;
  market: string;
  mode: string;
  outcome: string;
  overall: number;
  createdAt: string;
  score: SessionScore;
};

export type TeamPayload = {
  members: {
    userId: number; name: string; role: string;
    activitiesDone: number; rolePlayCount: number;
    rolePlayAverage: number | null; lastActivityAt: string | null;
  }[];
  gaps: TeamGap[];
};

/**
 * Fill in every list the page reads.
 *
 * The Academy endpoints are newer than the tab they live in, so during a
 * rolling deploy a client can hold a payload that predates half these fields.
 * A missing list must render as empty, never as a crash that takes the whole
 * Training tab down with it: the tab is what a gated new hire uses to get
 * unblocked, so it has to survive a partial answer.
 */
function normalizeProgress(raw: Partial<AcademyProgressPayload> | undefined): AcademyProgressPayload {
  return {
    records: raw?.records ?? [],
    states: raw?.states ?? [],
    path: raw?.path ?? { stages: [], done: 0, total: 0, percent: 0, resume: null },
    certifications: raw?.certifications ?? [],
    practiceAreas: raw?.practiceAreas ?? [],
    assignments: raw?.assignments ?? [],
    rolePlayCount: raw?.rolePlayCount ?? 0,
    rolePlayAverage: raw?.rolePlayAverage ?? null,
  };
}

export function useAcademyProgress() {
  return useQuery<AcademyProgressPayload>({
    queryKey: ACADEMY_PROGRESS_KEY,
    queryFn: async () => {
      const raw = await (await apiRequest("GET", "/api/training/academy/progress")).json();
      return normalizeProgress(raw);
    },
    staleTime: 30_000,
  });
}

export function useAcademyOffers(market?: string) {
  const url = market ? `/api/training/academy/offers?market=${encodeURIComponent(market)}` : "/api/training/academy/offers";
  return useQuery<OffersPayload>({
    queryKey: [...ACADEMY_OFFERS_KEY, market ?? ""],
    queryFn: async () => (await apiRequest("GET", url)).json(),
    // Offers expire on calendar days, so an hour of staleness can never show a
    // rep a promotion that ended. Anything longer could.
    staleTime: 10 * 60_000,
  });
}

export function useAcademyTeam(enabled: boolean) {
  return useQuery<TeamPayload>({
    queryKey: ACADEMY_TEAM_KEY,
    queryFn: async () => (await apiRequest("GET", "/api/training/academy/team")).json(),
    staleTime: 60_000,
    enabled,
  });
}

export function useRolePlayHistory() {
  return useQuery<{ sessions: RolePlaySummary[] }>({
    queryKey: ["/api/training/academy/roleplay"],
    queryFn: async () => (await apiRequest("GET", "/api/training/academy/roleplay")).json(),
    staleTime: 60_000,
  });
}

/** Mark an activity done. Optimistic, with an audible failure. */
export function useCompleteActivity() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async ({ activityId, score }: { activityId: string; score?: number | null }) => {
      const res = await apiRequest(
        "POST",
        `/api/training/academy/activities/${activityId}/complete`,
        score == null ? {} : { score },
      );
      return res.json() as Promise<ActivityRecord>;
    },
    onMutate: async ({ activityId, score }) => {
      await queryClient.cancelQueries({ queryKey: ACADEMY_PROGRESS_KEY });
      const previous = queryClient.getQueryData<AcademyProgressPayload>(ACADEMY_PROGRESS_KEY);
      queryClient.setQueryData<AcademyProgressPayload>(ACADEMY_PROGRESS_KEY, (old) => {
        if (!old) return old;
        const rest = old.records.filter((r) => r.activityId !== activityId);
        const prior = old.records.find((r) => r.activityId === activityId);
        // Mirror the server's best-score rule so the optimistic number never
        // disagrees with the reconciled one.
        const best = score == null ? prior?.score ?? null
          : prior?.score == null ? score
          : Math.max(prior.score, score);
        return {
          ...old,
          records: [...rest, { activityId, completedAt: new Date().toISOString(), score: best }],
        };
      });
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(ACADEMY_PROGRESS_KEY, ctx.previous);
      toast({
        variant: "destructive",
        title: "Couldn't save that",
        description: "Your progress did not reach the server. Try again when you have signal.",
      });
    },
    onSettled: () => { queryClient.invalidateQueries({ queryKey: ACADEMY_PROGRESS_KEY }); },
  });
}

/** Submit a finished role-play. The server re-scores it; we take its answer. */
export function useSubmitRolePlay() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationFn: async ({ session, mode }: { session: RolePlaySession; mode: "text" | "voice" }) => {
      const res = await apiRequest("POST", "/api/training/academy/roleplay", { session, mode });
      return res.json() as Promise<{ score: SessionScore; sessionId: string }>;
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Session not saved",
        description: "Your coaching report is on screen but did not reach the server.",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ACADEMY_PROGRESS_KEY });
      queryClient.invalidateQueries({ queryKey: ["/api/training/academy/roleplay"] });
    },
  });
}

/**
 * Autosave an activity's in-progress state, debounced.
 *
 * Save failures are SILENT here, and that is deliberate: this fires every few
 * seconds while a rep works, and a toast per failed autosave on a bad
 * connection would bury the screen. Losing autosaved state costs a rep one
 * quiz; losing the completion does not, because that has its own loud path.
 */
export function useActivityAutosave(activityId: string | null, state: unknown, enabled = true) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSent = useRef<string>("");

  useEffect(() => {
    if (!enabled || !activityId) return;
    const json = JSON.stringify(state ?? null);
    if (json === lastSent.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      lastSent.current = json;
      apiRequest("PUT", `/api/training/academy/activities/${activityId}/state`, { state })
        .catch(() => { lastSent.current = ""; });
    }, 1200);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [activityId, state, enabled]);
}

/** The saved mid-activity state for one activity, from the progress payload. */
export function useResumeState<T>(activityId: string | null): T | null {
  const { data } = useAcademyProgress();
  return useMemo(() => {
    if (!activityId || !data) return null;
    const found = data.states.find((s) => s.activityId === activityId);
    return (found?.state as T) ?? null;
  }, [activityId, data]);
}

// ── Motion ────────────────────────────────────────────────────────────────────

/**
 * True when the viewer asked for reduced motion. The CSS handles every declared
 * animation; this exists for the JS-driven ones (a counting timer, a typing
 * effect) that CSS cannot reach.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    // addListener is the Safari fallback; both are harmless to attach.
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener?.(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else mq.removeListener?.(onChange);
    };
  }, []);
  return reduced;
}

// ── Speech ────────────────────────────────────────────────────────────────────
//
// Voice role-play uses the browser's own SpeechRecognition and speechSynthesis.
// No audio leaves the device and no service is paid for. Neither API is
// universal, so both are feature-detected and the text mode is always the
// fallback rather than a degraded experience.

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
};

function recognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isVoiceInputSupported(): boolean {
  return recognitionCtor() !== null;
}

export function isSpeechOutputSupported(): boolean {
  return typeof window !== "undefined" && typeof window.speechSynthesis !== "undefined";
}

export type VoiceState = "idle" | "listening" | "denied" | "unsupported";

/** Push-to-talk dictation. Returns the final transcript through onFinal. */
export function useVoiceInput(onFinal: (text: string) => void) {
  const [state, setState] = useState<VoiceState>(() => (recognitionCtor() ? "idle" : "unsupported"));
  const [interim, setInterim] = useState("");
  const ref = useRef<SpeechRecognitionLike | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const stop = useCallback(() => {
    try { ref.current?.stop(); } catch { /* already stopped */ }
    setState((s) => (s === "listening" ? "idle" : s));
    setInterim("");
  }, []);

  const start = useCallback(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) { setState("unsupported"); return; }
    try {
      const rec = new Ctor();
      ref.current = rec;
      rec.continuous = false;
      rec.interimResults = true;
      rec.lang = "en-US";
      rec.onresult = (event: any) => {
        let final = "";
        let partial = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const chunk = event.results[i][0]?.transcript ?? "";
          if (event.results[i].isFinal) final += chunk;
          else partial += chunk;
        }
        setInterim(partial);
        if (final.trim()) { onFinalRef.current(final.trim()); setInterim(""); }
      };
      rec.onerror = (event: any) => {
        setState(event?.error === "not-allowed" || event?.error === "service-not-allowed" ? "denied" : "idle");
        setInterim("");
      };
      rec.onend = () => { setState((s) => (s === "listening" ? "idle" : s)); setInterim(""); };
      rec.start();
      setState("listening");
    } catch {
      setState("idle");
    }
  }, []);

  useEffect(() => () => { try { ref.current?.abort(); } catch { /* gone */ } }, []);

  return { state, interim, start, stop };
}

/** Speak a customer line. Cancels anything already speaking, and stays silent
 *  under reduced motion, where an unrequested voice is the same intrusion. */
export function speakLine(text: string, enabled: boolean): void {
  if (!enabled || !isSpeechOutputSupported()) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  } catch { /* speech is a nicety, never a failure path */ }
}

export function cancelSpeech(): void {
  if (!isSpeechOutputSupported()) return;
  try { window.speechSynthesis.cancel(); } catch { /* no-op */ }
}
