// Pitch Recorder — a practice mirror for reps. Records a spoken pitch with the
// browser's native MediaRecorder, plays it straight back so the rep HEARS their
// own delivery, and keeps the last take for the session. No upload, no server:
// this is a rehearsal tool, the audio never leaves the device.
//
// Graceful degradation is the whole point of the guards here: a browser without
// MediaRecorder hides the feature entirely (returns null); a denied mic shows a
// plain message with a retry. On unmount every track is stopped and every object
// URL revoked, so we never leave a microphone hot.
import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { FOCUS } from "@/lib/a11y";
import { cn } from "@/lib/utils";
import { SectionLabel } from "@/components/ui/page-scaffold";

type RecorderState = "idle" | "recording" | "recorded";
type ErrorKind = null | "denied" | "failed";

const BAR_COUNT = 28;

/** True only when the native pieces we need actually exist. Computed at render
 *  so a test (or a browser feature flag) that toggles globals is respected. */
export function isPitchRecorderSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

function createObjectUrl(blob: Blob): string | null {
  try {
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

function revokeObjectUrl(url: string | null) {
  if (!url || url.startsWith("data:")) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* no-op */
  }
}

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const PERSIST_PREFIX = "pitch-take:";
function storageKeyFor(id?: string): string | null {
  return id ? `${PERSIST_PREFIX}${id}` : null;
}

export default function PitchRecorder({
  prompt,
  title = "Practice your pitch",
  persistKey,
}: {
  /** The script or drill the rep reads while recording. */
  prompt: string;
  title?: string;
  /** When set, the kept take is saved to localStorage under this key so it
   *  survives within the session. Usually the lesson id. */
  persistKey?: string;
}) {
  const supported = isPitchRecorderSupported();

  const [state, setState] = useState<RecorderState>("idle");
  const [error, setError] = useState<ErrorKind>(null);
  const [seconds, setSeconds] = useState(0);
  const [takeSeconds, setTakeSeconds] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [kept, setKept] = useState(false);
  // True only after a CONFIRMED localStorage write (or restore). kept alone
  // means "kept for this session"; persisted means it survives reload.
  const [persisted, setPersisted] = useState(false);
  const [levels, setLevels] = useState<number[]>(() => new Array(BAR_COUNT).fill(0));

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rafRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const urlRef = useRef<string | null>(null);

  // Keep a ref in sync with the current object URL so the unmount cleanup — which
  // captures once — always revokes the latest one.
  urlRef.current = audioUrl;

  const stopMeter = useCallback(() => {
    if (rafRef.current != null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = null;
    if (analyserRef.current) {
      try {
        analyserRef.current.disconnect();
      } catch {
        /* no-op */
      }
      analyserRef.current = null;
    }
    if (audioCtxRef.current) {
      try {
        void audioCtxRef.current.close();
      } catch {
        /* no-op */
      }
      audioCtxRef.current = null;
    }
  }, []);

  const stopTracks = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        try {
          track.stop();
        } catch {
          /* no-op */
        }
      }
      streamRef.current = null;
    }
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Load a previously kept take (as a data URL) so it survives within the session.
  useEffect(() => {
    const key = storageKeyFor(persistKey);
    if (!key || typeof localStorage === "undefined") return;
    try {
      const saved = localStorage.getItem(key);
      if (saved) {
        setAudioUrl(saved);
        setState("recorded");
        setKept(true);
        setPersisted(true);
      }
    } catch {
      /* ignore storage errors */
    }
    // Only on mount / key change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistKey]);

  // Master cleanup: never leave a mic hot or an object URL leaked.
  useEffect(() => {
    return () => {
      clearTimer();
      stopMeter();
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        try {
          recorderRef.current.stop();
        } catch {
          /* no-op */
        }
      }
      recorderRef.current = null;
      stopTracks();
      revokeObjectUrl(urlRef.current);
    };
  }, [clearTimer, stopMeter, stopTracks]);

  function startMeter(stream: MediaStream) {
    const Ctx: typeof AudioContext | undefined =
      typeof AudioContext !== "undefined"
        ? AudioContext
        : (typeof window !== "undefined" && (window as any).webkitAudioContext) || undefined;
    if (!Ctx || typeof requestAnimationFrame !== "function") return;
    try {
      const ctx = new Ctx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const level = Math.min(1, sum / data.length / 140);
        setLevels((prev) => {
          const next = prev.slice(1);
          next.push(level);
          return next;
        });
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      // Metering is a nice-to-have; recording proceeds without it.
      stopMeter();
    }
  }

  async function startRecording() {
    setError(null);
    // Clear any prior take before a fresh one.
    revokeObjectUrl(audioUrl);
    setAudioUrl(null);
    setKept(false);
    setPersisted(false);
    chunksRef.current = [];
    setLevels(new Array(BAR_COUNT).fill(0));

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err: any) {
      const name = err?.name ?? "";
      setError(name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError" ? "denied" : "failed");
      return;
    }

    streamRef.current = stream;
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream);
    } catch {
      stopTracks();
      setError("failed");
      return;
    }
    recorderRef.current = recorder;

    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      clearTimer();
      stopMeter();
      stopTracks();
      const type = chunksRef.current[0]?.type || "audio/webm";
      const blob = new Blob(chunksRef.current, { type });
      const url = createObjectUrl(blob);
      setAudioUrl(url);
      setState("recorded");
    };

    try {
      recorder.start();
    } catch {
      stopTracks();
      setError("failed");
      return;
    }

    setState("recording");
    setSeconds(0);
    setTakeSeconds(0);
    timerRef.current = setInterval(() => {
      setSeconds((s) => {
        const next = s + 1;
        setTakeSeconds(next);
        return next;
      });
    }, 1000);
    startMeter(stream);
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Fall back to finalizing manually.
        clearTimer();
        stopMeter();
        stopTracks();
        setState("recorded");
      }
    } else {
      clearTimer();
      stopMeter();
      stopTracks();
      setState("recorded");
    }
  }

  function reRecord() {
    revokeObjectUrl(audioUrl);
    setAudioUrl(null);
    setKept(false);
    setPersisted(false);
    setState("idle");
    setError(null);
    setSeconds(0);
    setTakeSeconds(0);
    setLevels(new Array(BAR_COUNT).fill(0));
    const key = storageKeyFor(persistKey);
    if (key && typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem(key);
      } catch {
        /* no-op */
      }
    }
  }

  function discard() {
    reRecord();
  }

  // Persistence budget. Base64 audio is ~1.4x blob size and localStorage is a
  // ~5 MB pool SHARED with the react-query persister and the offline review
  // outbox — and the outbox's safeStorage degrades to memory-only for the rest
  // of the session on its first quota throw. One oversized take must never be
  // what breaks offline drill grading, so takes above the cap stay in-memory.
  const MAX_PERSIST_BLOB_BYTES = 1_500_000;

  async function keepTake() {
    setKept(true);
    const key = storageKeyFor(persistKey);
    if (!key || !audioUrl || audioUrl.startsWith("data:") || typeof localStorage === "undefined") return;
    // Persist as a data URL so the take survives reload even though object
    // URLs do not. `persisted` is set ONLY on a successful write — the badge
    // must not claim durability the write never achieved.
    try {
      const blob = await fetch(audioUrl).then((r) => r.blob());
      if (blob.size > MAX_PERSIST_BLOB_BYTES) return;
      const reader = new FileReader();
      reader.onloadend = () => {
        try {
          if (typeof reader.result === "string") {
            // One take per device is the promise: evict other cards' takes so
            // pitch audio can never crowd the shared pool.
            for (let i = localStorage.length - 1; i >= 0; i--) {
              const k = localStorage.key(i);
              if (k && k !== key && k.startsWith(PERSIST_PREFIX)) localStorage.removeItem(k);
            }
            localStorage.setItem(key, reader.result);
            setPersisted(true);
          }
        } catch {
          /* storage full — the in-memory take still plays */
        }
      };
      reader.readAsDataURL(blob);
    } catch {
      /* no-op */
    }
  }

  if (!supported) return null;

  return (
    <div className="rounded-xl border border-primary/25 bg-primary/[0.06] p-4" data-testid="pitch-recorder">
      <div className="flex items-center gap-2">
        
        <SectionLabel className="text-primary">{title}</SectionLabel>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Read the pitch out loud, then play it back and listen to yourself. Nothing leaves this device.
      </p>

      {/* Script to read */}
      <div className="mt-3 rounded-lg border border-border bg-background p-3 text-sm leading-relaxed text-foreground" data-testid="pitch-prompt">
        {prompt}
      </div>

      {/* Live meter + timer while recording; take length after */}
      {(state === "recording" || (state === "recorded" && takeSeconds > 0)) && (
        <div className="mt-3 flex items-center gap-3">
          <div
            className="flex h-8 flex-1 items-center gap-[2px] overflow-hidden"
            data-testid="pitch-meter"
            aria-hidden="true"
          >
            {levels.map((lvl, i) => (
              <span
                key={i}
                className={cn("w-full rounded-full", state === "recording" ? "bg-primary" : "bg-border")}
                style={{ height: `${Math.max(6, Math.round(lvl * 100))}%` }}
              />
            ))}
          </div>
          <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground" data-testid="pitch-timer">
            {formatTime(state === "recording" ? seconds : takeSeconds)}
          </span>
        </div>
      )}

      {/* Permission / failure message */}
      {error && (
        <div
          className="mt-3 flex items-start gap-2 rounded-lg bg-destructive/[0.08] px-3 py-2 text-xs text-destructive"
          data-testid={error === "denied" ? "pitch-permission-denied" : "pitch-error"}
          role="alert"
        >
          
          <span>
            {error === "denied"
              ? "Microphone access was blocked. Allow the mic in your browser's site settings, then try again."
              : "Recording could not start on this device. Check that a microphone is connected and try again."}
          </span>
        </div>
      )}

      {/* Playback of the last take */}
      {state === "recorded" && audioUrl && (
        <audio
          controls
          src={audioUrl}
          className="mt-3 w-full"
          data-testid="pitch-playback"
        />
      )}

      {/* Controls */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {state === "idle" && (
          <button
            type="button"
            onClick={startRecording}
            data-testid="pitch-record"
            className={cn(
              "inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-5 text-sm font-semibold text-primary-foreground transition-transform active:scale-[.98]",
              FOCUS,
            )}
          >
            
            {error ? "Try again" : "Record"}
          </button>
        )}

        {state === "recording" && (
          <button
            type="button"
            onClick={stopRecording}
            data-testid="pitch-stop"
            className={cn(
              "inline-flex min-h-11 items-center gap-2 rounded-xl bg-destructive px-5 text-sm font-semibold text-white transition-transform active:scale-[.98]",
              FOCUS,
            )}
          >
             Stop
          </button>
        )}

        {state === "recorded" && (
          <>
            <button
              type="button"
              onClick={reRecord}
              data-testid="pitch-rerecord"
              className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded-xl border border-border bg-background px-4 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/60",
                FOCUS,
              )}
            >
               Re-record
            </button>
            {!kept ? (
              <button
                type="button"
                onClick={keepTake}
                data-testid="pitch-keep"
                className={cn(
                  "inline-flex min-h-11 items-center gap-2 rounded-xl bg-secondary px-4 text-sm font-semibold text-foreground transition-transform active:scale-[.98]",
                  FOCUS,
                )}
              >
                <Check className="h-4 w-4" aria-hidden="true" /> Keep this take
              </button>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 text-xs font-semibold text-success" data-testid="pitch-kept">
                {/* "Take kept" only when the write actually landed — a long
                    take or a full disk keeps it for this session only, and
                    saying otherwise is a lie the rep discovers after reload. */}
                <Check className="h-3.5 w-3.5" aria-hidden="true" /> {persisted ? "Take kept" : "Kept for this session"}
              </span>
            )}
            <button
              type="button"
              onClick={discard}
              data-testid="pitch-discard"
              className={cn(
                "inline-flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground",
                FOCUS,
              )}
            >
               Discard
            </button>
          </>
        )}
      </div>
    </div>
  );
}
