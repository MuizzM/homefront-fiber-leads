// ── Lead knock sheet ──────────────────────────────────────────────────────────
// Mobile-first bottom sheet for the rep door-knocking flow. Deliberately NOT
// vaul/radix: no portal, no backdrop, no body scroll-lock — the map above must
// stay 100% interactive while the sheet is open. Snapping is pure transform
// (translateY) so the map never reflows, and dragging is confined to the
// handle/header region so the outcome grid and body scroll are never hijacked.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Check, CloudOff, Loader2, MessageSquare, Navigation, Phone, X } from "lucide-react";
import { SHEET_PEEK_BASE_PX } from "@/lib/mapPins";
import {
  OUTCOMES, OUTCOME_META, STATE_COLORS, pinDisplayState, isKnockOutcome,
  type KnockOutcome,
} from "@shared/knock";

export type SheetSnap = "peek" | "expanded";

export interface SheetLead {
  id: number; lat?: number | null; lng?: number | null;
  address: string; city?: string | null; state?: string | null; zip?: string | null;
  leadStatus: string; assignedRepId?: number | null;
  leadScore?: number | null; contactName?: string | null; contactPhone?: string | null;
  visited?: boolean; knockCount?: number;
  lastOutcome?: string | null; lastKnockedAt?: string | null;
  fiberStatus?: string | null;
}

export interface LeadKnockSheetProps {
  lead: SheetLead | null;                    // null → animate out then unmount after 300ms
  saveState: "idle" | "saving" | "saved" | "queued" | "error";
  savedOutcome: KnockOutcome | null;         // outcome already logged for THIS lead this session
  onKnock: (outcome: KnockOutcome, extra?: { callbackDate?: string; callbackTime?: string }) => void;
  onSaveNote: (note: string) => void;
  onRetrySave?: () => void;
  onClose: () => void;
  onNextDoor: () => void;
  onSkip: () => void;
  nextDoorHint?: string | null;              // "152 Maple St · 40m"
  hasNext?: boolean;                         // false → Next Door renders disabled "All done ✓"
  canAssign?: boolean;
  reps?: { id: number; name: string }[];
  onAssignRep?: (repId: number | null) => void;
}

type Phase = "pick" | "callback" | "done";

// Peek height: exactly what a rep needs on a porch, nothing below half-clipped
// (handle + header + 2-row outcome grid + directions/call/text strip).
// Imported from mapPins so the map's camera padding tracks the sheet lip.
const PEEK_BASE_PX = SHEET_PEEK_BASE_PX;
// Tap-vs-drag threshold: header buttons must still receive taps.
const TAP_SLOP_PX = 6;
// Dragging further than this below the peek position dismisses the sheet.
const CLOSE_OVERDRAG_PX = 80;
// Flick faster than this decides snap direction regardless of position.
const FLICK_VELOCITY = 0.5; // px/ms

// One shade lighter than OUTCOME_META colors — button text on 15% tints needs
// more luminance than the pin hex to pass contrast on the dark card.
const LIGHT: Record<KnockOutcome, string> = {
  not_home: "#22d3ee", interested: "#a78bfa", sold: "#34d399",
  not_interested: "#f87171", follow_up: "#fbbf24", callback: "#60a5fa",
  needs_verification: "#94a3b8",
};

// Reps get exactly 6 buttons (owner's rule: 4-6 max, porch-simple), in pure
// thumb-frequency order. needs_verification stays in shared/knock.ts for
// server + history back-compat but is not offered on the rep card.
const GRID_OUTCOMES = OUTCOMES.filter(o => o.key !== "needs_verification");

const pad2 = (n: number) => String(n).padStart(2, "0");
const toDateStr = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// env(safe-area-inset-bottom) is CSS-only; probe it once per mount/resize so
// drag math and snap positions can stay numeric. jsdom parses to 0.
function readSafeAreaBottom(): number {
  if (typeof document === "undefined") return 0;
  try {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;padding-bottom:env(safe-area-inset-bottom);";
    document.body.appendChild(probe);
    const v = parseFloat(getComputedStyle(probe).paddingBottom || "0") || 0;
    probe.remove();
    return v;
  } catch { return 0; }
}

function SaveStateChip({ state, onRetry }: {
  state: LeadKnockSheetProps["saveState"]; onRetry?: () => void;
}) {
  if (state === "idle") return null;
  const base = "inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] font-semibold whitespace-nowrap";
  if (state === "saving") return (
    <span data-testid="knock-save-state" data-state="saving" className={`${base} bg-secondary text-muted-foreground`}>
      <Loader2 className="w-3 h-3 animate-spin" />Saving…
    </span>
  );
  if (state === "saved") return (
    <span data-testid="knock-save-state" data-state="saved" className={`${base} bg-emerald-500/15 text-emerald-400`}>
      Saved ✓
    </span>
  );
  // Queued copy says the thing the rep needs to hear — it's safe, keep walking.
  // The cloud-off icon + amber carry the "offline" part without scary words,
  // and the chip stays the same width as "Saved ✓" so the header never reflows.
  if (state === "queued") return (
    <span data-testid="knock-save-state" data-state="queued" aria-label="Saved offline — will sync"
      className={`${base} bg-amber-500/15 text-amber-400`}>
      <CloudOff className="w-3 h-3" />Saved ✓
    </span>
  );
  return (
    <button
      type="button" data-testid="knock-save-state" data-state="error" onClick={onRetry}
      className={`${base} bg-red-500/15 text-red-400 active:scale-95 transition`}
    >
      Tap to retry
    </button>
  );
}

interface KnockHistoryRow { id: number; outcome: string; knockedAt: string; notes?: string | null }

export function LeadKnockSheet(props: LeadKnockSheetProps): JSX.Element | null {
  const {
    lead, saveState, savedOutcome, onKnock, onSaveNote, onRetrySave, onClose,
    onNextDoor, onSkip, nextDoorHint, hasNext, canAssign, reps, onAssignRep,
  } = props;

  // Keep the last lead rendered while `lead: null` animates the sheet out.
  const [renderedLead, setRenderedLead] = useState<SheetLead | null>(lead);
  const closing = lead === null;
  useEffect(() => {
    if (lead) { setRenderedLead(lead); return; }
    const t = setTimeout(() => setRenderedLead(null), 300);
    return () => clearTimeout(t);
  }, [lead]);

  const [snap, setSnap] = useState<SheetSnap>("peek");
  const [phase, setPhase] = useState<Phase>(() => (savedOutcome ? "done" : "pick"));
  const [localPick, setLocalPick] = useState<KnockOutcome | null>(null);
  const [locked, setLocked] = useState(false);          // 1s double-tap guard
  const [showCustom, setShowCustom] = useState(false);  // native callback picker
  const [customDate, setCustomDate] = useState("");
  const [customTime, setCustomTime] = useState("");
  const [note, setNote] = useState("");
  const [noteSaved, setNoteSaved] = useState(false);

  const sheetRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedNote = useRef("");

  // ── Geometry: measure sheet height + safe area so snaps are numeric ─────────
  const [sheetH, setSheetH] = useState(0);
  const [safeBottom, setSafeBottom] = useState(0);
  const mounted = renderedLead != null;
  useLayoutEffect(() => {
    if (!mounted) return;
    const measure = () => {
      if (sheetRef.current) setSheetH(sheetRef.current.offsetHeight);
      setSafeBottom(readSafeAreaBottom());
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [mounted]);

  const peekY = Math.max(0, sheetH - (PEEK_BASE_PX + safeBottom));

  // ── Drag (handle + header only) ──────────────────────────────────────────────
  const [dragging, setDragging] = useState(false);
  const [dragY, setDragY] = useState(0);
  const dragRef = useRef<{
    pointerId: number; startClientY: number; startOffset: number;
    lastY: number; lastT: number; vy: number; moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);

  const currentOffset = () => {
    if (closing) return sheetH;
    if (dragging) return dragY;
    return snap === "expanded" ? 0 : peekY;
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (closing) return;
    // No preventDefault — taps on Skip / X / retry chip must still land.
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* jsdom */ }
    dragRef.current = {
      pointerId: e.pointerId, startClientY: e.clientY, startOffset: currentOffset(),
      lastY: e.clientY, lastT: e.timeStamp, vy: 0, moved: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const total = e.clientY - d.startClientY;
    if (!d.moved && Math.abs(total) < TAP_SLOP_PX) return; // still a tap
    if (!d.moved) { d.moved = true; setDragging(true); suppressClick.current = true; }
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.vy = (e.clientY - d.lastY) / dt;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    setDragY(Math.max(0, d.startOffset + total));
  };

  const endDrag = (e: React.PointerEvent, cancelled: boolean) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* jsdom */ }
    if (!d.moved) return; // tap — let the click reach its target
    setDragging(false);
    if (cancelled) return; // spring back to the current snap
    const y = Math.max(0, d.startOffset + (d.lastY - d.startClientY));
    if (y > peekY + CLOSE_OVERDRAG_PX) { onClose(); return; }
    if (Math.abs(d.vy) > FLICK_VELOCITY) setSnap(d.vy > 0 ? "peek" : "expanded");
    else setSnap(y < peekY / 2 ? "expanded" : "peek");
  };

  // A real drag must not fire the click of whatever the pointer landed on.
  const swallowDragClick = (e: React.MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ── Per-lead reset ───────────────────────────────────────────────────────────
  const prevLeadId = useRef<number | null>(null);
  useEffect(() => {
    const id = renderedLead?.id ?? null;
    if (id === prevLeadId.current) return; // savedOutcome changes alone never reset
    prevLeadId.current = id;
    if (id == null) return;
    setSnap("peek");
    setPhase(savedOutcome ? "done" : "pick");
    setLocalPick(null);
    setShowCustom(false);
    setCustomDate("");
    setCustomTime("");
    setNote("");
    setNoteSaved(false);
    setLocked(false);
    setDragging(false);
    lastSavedNote.current = "";
    dragRef.current = null;
    if (lockTimer.current) { clearTimeout(lockTimer.current); lockTimer.current = null; }
    if (noteTimer.current) { clearTimeout(noteTimer.current); noteTimer.current = null; }
  }, [renderedLead?.id, savedOutcome]);

  // Escape closes (only while actually open).
  useEffect(() => {
    if (!lead) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lead, onClose]);

  useEffect(() => () => {
    if (lockTimer.current) clearTimeout(lockTimer.current);
    if (noteTimer.current) clearTimeout(noteTimer.current);
  }, []);

  // ── Outcome taps ─────────────────────────────────────────────────────────────
  const armDoubleTapGuard = () => {
    setLocked(true);
    if (lockTimer.current) clearTimeout(lockTimer.current);
    lockTimer.current = setTimeout(() => setLocked(false), 1000);
  };

  const handleOutcomeTap = (key: KnockOutcome) => {
    if (locked) return;
    // A sale gets a double-tick buzz — every sold should feel different in the hand.
    try { navigator.vibrate?.(key === "sold" ? [12, 40, 12] : 10); } catch { /* unsupported */ }
    if (key === "callback") { setPhase("callback"); return; } // date first, knock second
    armDoubleTapGuard();
    setLocalPick(key);
    onKnock(key);
    setPhase("done");
  };

  const fireCallback = (date: string, time: string) => {
    if (locked) return;
    try { navigator.vibrate?.(10); } catch { /* unsupported */ }
    armDoubleTapGuard();
    setLocalPick("callback");
    onKnock("callback", { callbackDate: date, callbackTime: time });
    setShowCustom(false);
    setPhase("done");
  };

  // ONE Date snapshot per entry into the callback phase — all chips agree on "now".
  const callbackOptions = useMemo(() => {
    const now = new Date();
    const todayPm = new Date(now);
    todayPm.setHours(17, 0, 0, 0);
    if (now.getTime() >= todayPm.getTime()) todayPm.setDate(todayPm.getDate() + 1); // 5pm passed → tomorrow 5pm
    const tmrw = new Date(now);
    tmrw.setDate(tmrw.getDate() + 1);
    return {
      todayPm: { date: toDateStr(todayPm), time: "17:00" },
      tomorrowAm: { date: toDateStr(tmrw), time: "09:00" },
      tomorrowPm: { date: toDateStr(tmrw), time: "17:00" },
    };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePickCustom = () => {
    if (!customDate) setCustomDate(toDateStr(new Date()));
    if (!customTime) setCustomTime("17:00");
    setSnap("expanded");
    setShowCustom(true);
  };

  // ── Note autosave: blur = immediate, typing = 800ms debounce ────────────────
  const commitNote = (value: string) => {
    if (noteTimer.current) { clearTimeout(noteTimer.current); noteTimer.current = null; }
    if (value === lastSavedNote.current) return;
    lastSavedNote.current = value;
    onSaveNote(value);
    setNoteSaved(true);
  };

  const handleNoteChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setNote(v);
    setNoteSaved(false);
    if (noteTimer.current) clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => commitNote(v), 800);
  };

  const handleAddNote = () => {
    setSnap("expanded");
    // Focus after the snap transform kicks in so iOS doesn't scroll a hidden field.
    setTimeout(() => noteRef.current?.focus(), 50);
  };

  // ── Knock history (fetched lazily — only once expanded) ─────────────────────
  const historyQuery = useQuery<KnockHistoryRow[]>({
    queryKey: [`/api/leads/${renderedLead?.id ?? 0}/knocks`],
    enabled: snap === "expanded" && !!lead && renderedLead != null,
  });
  const recentKnocks = useMemo(() => {
    if (!historyQuery.data) return [];
    return [...historyQuery.data]
      .sort((a, b) => (a.knockedAt < b.knockedAt ? 1 : -1))
      .slice(0, 3);
  }, [historyQuery.data]);

  if (!renderedLead) return null;

  // ── Derived display values ───────────────────────────────────────────────────
  const stateKey = pinDisplayState(renderedLead);
  const stateColor = STATE_COLORS[stateKey];
  const stateLabel = stateKey.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

  const knocked = !!(renderedLead.lastOutcome && renderedLead.lastKnockedAt);
  const lastLabel = isKnockOutcome(renderedLead.lastOutcome)
    ? OUTCOME_META[renderedLead.lastOutcome].label
    : renderedLead.lastOutcome ?? "";
  const knockN = renderedLead.knockCount && renderedLead.knockCount > 0 ? renderedLead.knockCount : 1;

  const selected = localPick ?? savedOutcome;
  const doneMeta = selected ? OUTCOME_META[selected] : null;

  const phone = renderedLead.contactPhone?.trim() || null;
  const destination = renderedLead.lat != null && renderedLead.lng != null
    ? `${renderedLead.lat},${renderedLead.lng}`
    : encodeURIComponent(
        [renderedLead.address, renderedLead.city, renderedLead.state, renderedLead.zip]
          .filter(Boolean).join(", "),
      );
  const directionsHref = `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=walking`;

  const transform = closing
    ? "translateY(100%)"
    : dragging
      ? `translateY(${dragY}px)`
      : snap === "expanded"
        ? "translateY(0px)"
        : `translateY(${peekY}px)`;

  const iconBtn = "w-12 h-12 rounded-xl bg-secondary border border-border flex items-center justify-center text-foreground active:scale-95 transition";
  const chipBtn = "h-12 flex-1 rounded-xl border text-[13px] font-semibold whitespace-nowrap active:scale-95 transition";

  // Rendered in every phase (compact strip pre-save, next-action row post-save).
  // Static deep links only — never a Mapbox API call. Disabled contact actions
  // stay rendered so the layout never jumps.
  const actionIcons = (
    <>
      <a
        data-testid="action-directions"
        href={directionsHref}
        target="_blank"
        rel="noopener"
        aria-label="Directions"
        className={iconBtn}
      >
        <Navigation className="w-5 h-5" />
      </a>
      <a
        data-testid="action-call"
        href={phone ? `tel:${phone}` : undefined}
        aria-disabled={phone ? undefined : "true"}
        aria-label="Call"
        className={`${iconBtn} ${phone ? "" : "opacity-40 pointer-events-none"}`}
      >
        <Phone className="w-5 h-5" />
      </a>
      <a
        data-testid="action-text"
        href={phone ? `sms:${phone}` : undefined}
        aria-disabled={phone ? undefined : "true"}
        aria-label="Text"
        className={`${iconBtn} ${phone ? "" : "opacity-40 pointer-events-none"}`}
      >
        <MessageSquare className="w-5 h-5" />
      </a>
    </>
  );

  return (
    <div
      ref={sheetRef}
      data-testid="knock-sheet"
      role="dialog"
      aria-label={renderedLead.address}
      className={[
        "fixed inset-x-0 bottom-0 z-40 h-[min(85dvh,640px)] rounded-t-2xl",
        "bg-card/95 backdrop-blur-md border-t border-border",
        "shadow-[0_-8px_30px_rgba(0,0,0,0.35)] will-change-transform",
        dragging ? "" : "transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
      ].join(" ")}
      style={{ transform }}
    >
      {/* Drag region: handle + header. touchAction none so the browser never
          steals the gesture for page scroll. */}
      <div
        data-drag-region
        className="cursor-grab select-none"
        style={{ touchAction: "none" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => endDrag(e, false)}
        onPointerCancel={(e) => endDrag(e, true)}
        onClickCapture={swallowDragClick}
      >
        {/* Tap the handle to toggle peek/expanded — one-hand alternative to the
            drag (swallowDragClick suppresses this after a real drag). */}
        <div
          data-testid="knock-sheet-handle"
          className="flex justify-center pt-2 pb-1 cursor-pointer"
          onClick={() => setSnap(s => (s === "peek" ? "expanded" : "peek"))}
        >
          <div className="w-10 h-1.5 rounded-full bg-muted-foreground/30" />
        </div>

        {/* Two-row header: the address owns row 1 (~20 chars even with every
            control visible); status context lives quietly on row 2. */}
        <div className="px-4 pb-2">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="min-w-0 flex-1 text-[15px] font-semibold text-foreground truncate">{renderedLead.address}</h2>
            {(renderedLead.leadScore ?? 0) >= 80 && (
              <span data-testid="knock-hot-chip" aria-label="Hot lead" title={`Hot lead - score ${renderedLead.leadScore}`}
                className="shrink-0 h-5 px-1.5 rounded-full bg-orange-500/15 text-[11px] leading-5">🔥</span>
            )}
            <SaveStateChip state={saveState} onRetry={onRetrySave} />
            <button
              type="button"
              data-testid="knock-skip"
              onClick={onSkip}
              className="h-11 px-3 shrink-0 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
            >
              Skip
            </button>
            <button
              type="button"
              data-testid="knock-sheet-close"
              onClick={onClose}
              aria-label="Close"
              className="w-11 h-11 -mr-2 shrink-0 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          {/* Row 2: what happened last ("✓ Not Home · 2h ago · 2×"), or where this
              door is when fresh. The word "Unworked" never appears: a green pin
              plus a grid of buttons already says "this one's fresh". */}
          <div className="flex items-center gap-1.5 mt-0.5 min-w-0 text-xs text-muted-foreground">
            {knocked ? (
              <>
                <span
                  data-testid="knock-status-chip"
                  className="shrink-0 h-[18px] px-2 rounded-full text-[10px] font-semibold uppercase tracking-wide leading-[18px]"
                  style={{ background: `${stateColor}26`, color: stateColor }}
                >
                  ✓ {lastLabel}
                </span>
                <span className="truncate">
                  {relTime(renderedLead.lastKnockedAt!)}{knockN >= 2 ? ` · ${knockN}×` : ""}
                </span>
              </>
            ) : (
              <span className="truncate">
                {[renderedLead.city, [renderedLead.state, renderedLead.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Body: clipped in peek, scrollable when expanded. */}
      <div
        className={[
          "px-4 h-[calc(100%-96px)] pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
          snap === "expanded" ? "overflow-y-auto overscroll-contain" : "overflow-hidden",
        ].join(" ")}
      >
        {phase === "pick" && (
          <div className={`grid grid-cols-3 gap-2 ${locked ? "pointer-events-none" : ""}`}>
            {GRID_OUTCOMES.map(o => {
              const sel = selected === o.key;
              return (
                <button
                  key={o.key}
                  type="button"
                  data-testid={`knock-outcome-${o.key}`}
                  onClick={() => handleOutcomeTap(o.key)}
                  className="h-12 rounded-xl border text-[13px] font-semibold whitespace-nowrap active:scale-95 transition flex items-center justify-center gap-1"
                  style={sel
                    ? { background: o.color, borderColor: o.color, color: "#ffffff" }
                    : { background: `${o.color}26`, borderColor: `${o.color}66`, color: LIGHT[o.key] }}
                >
                  {sel && <Check className="w-4 h-4 shrink-0" />}
                  {o.label}
                </button>
              );
            })}
          </div>
        )}

        {phase === "callback" && (
          <div>
            <div data-testid="callback-quick-row" className={`flex gap-2 ${locked ? "pointer-events-none" : ""}`}>
              <button
                type="button"
                data-testid="callback-back"
                aria-label="Back"
                onClick={() => setPhase("pick")}
                className="h-12 w-12 shrink-0 rounded-xl border border-border bg-secondary text-foreground text-lg active:scale-95 transition"
              >
                ←
              </button>
              <button
                type="button"
                data-testid="callback-chip-today-pm"
                onClick={() => fireCallback(callbackOptions.todayPm.date, callbackOptions.todayPm.time)}
                className={chipBtn}
                style={{ background: "#3b82f626", borderColor: "#3b82f666", color: "#60a5fa" }}
              >
                Today PM
              </button>
              <button
                type="button"
                data-testid="callback-chip-tomorrow-am"
                onClick={() => fireCallback(callbackOptions.tomorrowAm.date, callbackOptions.tomorrowAm.time)}
                className={chipBtn}
                style={{ background: "#3b82f626", borderColor: "#3b82f666", color: "#60a5fa" }}
              >
                Tmrw AM
              </button>
              <button
                type="button"
                data-testid="callback-chip-tomorrow-pm"
                onClick={() => fireCallback(callbackOptions.tomorrowPm.date, callbackOptions.tomorrowPm.time)}
                className={chipBtn}
                style={{ background: "#3b82f626", borderColor: "#3b82f666", color: "#60a5fa" }}
              >
                Tmrw PM
              </button>
              <button
                type="button"
                data-testid="callback-chip-custom"
                onClick={handlePickCustom}
                className={chipBtn}
                style={{ background: "#3b82f626", borderColor: "#3b82f666", color: "#60a5fa" }}
              >
                Pick…
              </button>
            </div>

            {showCustom && (
              <div className="mt-3 flex items-end gap-2">
                <input
                  type="date"
                  data-testid="callback-date-input"
                  value={customDate}
                  onChange={(e) => setCustomDate(e.target.value)}
                  className="h-10 flex-1 min-w-0 bg-secondary border border-border rounded-md px-2 text-sm text-foreground"
                />
                <input
                  type="time"
                  data-testid="callback-time-input"
                  value={customTime}
                  onChange={(e) => setCustomTime(e.target.value)}
                  className="h-10 w-28 bg-secondary border border-border rounded-md px-2 text-sm text-foreground"
                />
                <button
                  type="button"
                  data-testid="callback-save"
                  onClick={() => fireCallback(customDate, customTime)}
                  disabled={!customDate || !customTime}
                  className="h-10 px-4 rounded-md bg-primary text-primary-foreground text-sm font-semibold active:scale-95 transition disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            )}
          </div>
        )}

        {phase === "done" && (
          <div>
            <div className="flex items-center gap-2">
              {/* A sale physically feels different: one-time pop + emerald glow.
                  Half a second, zero libraries, no confetti. */}
              <motion.span
                data-testid="knock-done-chip"
                className="inline-flex items-center gap-1.5 h-10 px-3 rounded-xl text-sm font-bold text-white"
                style={{ background: doneMeta?.color ?? "#64748b" }}
                {...(savedOutcome === "sold" ? {
                  initial: { scale: 0.6 },
                  animate: {
                    scale: [0.6, 1.1, 1],
                    boxShadow: [
                      "0 0 0 0 rgba(16,185,129,0)",
                      "0 0 28px 6px rgba(16,185,129,0.45)",
                      "0 0 0 0 rgba(16,185,129,0)",
                    ],
                  },
                  transition: { duration: 0.5, times: [0, 0.6, 1], ease: "easeOut" as const },
                } : {})}
              >
                <Check className="w-4 h-4" />
                {savedOutcome === "sold" ? "Sold 🎉" : (doneMeta?.label ?? "Logged")}
              </motion.span>
              <button
                type="button"
                data-testid="knock-change-outcome"
                onClick={() => setPhase("pick")}
                className="h-10 px-3 rounded-xl border border-border text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors"
              >
                Change
              </button>
              <button
                type="button"
                data-testid="knock-add-note"
                onClick={handleAddNote}
                className="h-10 px-3 rounded-xl border border-border text-sm font-semibold text-muted-foreground hover:text-foreground transition-colors"
              >
                + Note
              </button>
            </div>

            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: 0.15 }}
              className="mt-3 flex items-stretch gap-2"
            >
              <button
                type="button"
                data-testid="next-door-btn"
                onClick={onNextDoor}
                disabled={hasNext === false}
                className={[
                  "flex-1 h-12 rounded-xl font-bold text-[15px] active:scale-95 transition",
                  hasNext === false
                    ? "bg-secondary text-muted-foreground"
                    : "bg-primary text-primary-foreground",
                ].join(" ")}
              >
                {hasNext === false ? (
                  "All done — nice work ✓"
                ) : (
                  <span className="flex flex-col items-center leading-tight">
                    <span>Next Door</span>
                    {nextDoorHint && (
                      <span className="text-[11px] font-medium opacity-80">{nextDoorHint}</span>
                    )}
                  </span>
                )}
              </button>
              {actionIcons}
            </motion.div>
          </div>
        )}

        {/* Directions/Call/Text stay reachable BEFORE the knock too — a rep
            navigating to the door needs directions first, not after. */}
        {phase !== "done" && (
          <div className="mt-2 flex justify-end gap-2">{actionIcons}</div>
        )}

        {/* ── Expanded extras — NEVER visible at peek. A half-clipped textarea
               peeking above the fold reads as a form; the peek card must stay
               calm: address, six buttons, actions, done. ── */}
        {snap === "expanded" && (
        <div className="mt-4 space-y-4">
          {/* Notes attach to the knock just logged — before that there's nothing
              to attach to, so no dead disabled form control: it simply isn't there. */}
          {savedOutcome && (
          <div>
            <textarea
              ref={noteRef}
              data-testid="knock-note-input"
              placeholder="Note for next time (optional)"
              value={note}
              onChange={handleNoteChange}
              onBlur={() => commitNote(note)}
              className="w-full min-h-[72px] text-base bg-secondary border border-border rounded-lg px-3 py-2 text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-1 focus:ring-primary"
            />
            {noteSaved && (
              <motion.span
                data-testid="knock-note-saved"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.2 }}
                className="text-[11px] text-emerald-400"
              >
                Note saved
              </motion.span>
            )}
          </div>
          )}

          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
              Knock history
            </div>
            <div data-testid="knock-history-list" className="space-y-1.5">
              {historyQuery.isLoading ? (
                <>
                  <div className="h-5 rounded bg-secondary animate-pulse" />
                  <div className="h-5 rounded bg-secondary animate-pulse w-2/3" />
                </>
              ) : recentKnocks.length === 0 ? (
                <div className="text-xs text-muted-foreground italic">No knocks yet</div>
              ) : (
                recentKnocks.map((k, i) => {
                  const meta = isKnockOutcome(k.outcome) ? OUTCOME_META[k.outcome] : null;
                  return (
                    <div
                      key={k.id}
                      data-testid={`knock-history-item-${i}`}
                      className="flex items-center gap-2 text-xs min-w-0"
                    >
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ background: meta?.color ?? "#64748b" }}
                      />
                      <span className="font-medium text-foreground shrink-0">{meta?.label ?? k.outcome}</span>
                      <span className="text-muted-foreground shrink-0">{relTime(k.knockedAt)}</span>
                      {k.notes && <span className="text-muted-foreground truncate">· {k.notes}</span>}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {renderedLead.fiberStatus === "new_fiber" && (
              <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 text-[10px] font-bold uppercase tracking-wide">
                New Fiber
              </span>
            )}
            {renderedLead.leadScore != null && renderedLead.leadScore >= 80 && (
              <span className="px-2 py-0.5 rounded-full bg-orange-500/15 text-orange-400 text-[10px] font-bold">
                🔥 Hot lead
              </span>
            )}
            {renderedLead.contactName && (
              <span className="font-medium text-foreground">{renderedLead.contactName}</span>
            )}
            {(renderedLead.city || renderedLead.zip) && (
              <span>{[renderedLead.city, renderedLead.zip].filter(Boolean).join(" ")}</span>
            )}
          </div>

          {canAssign && (
            <select
              data-testid="assign-rep-select"
              value={renderedLead.assignedRepId ?? ""}
              onChange={(e) => onAssignRep?.(Number(e.target.value) || null)}
              className="h-10 w-full bg-secondary border border-border rounded-md text-sm text-foreground px-2"
            >
              <option value="">Unassigned</option>
              {(reps ?? []).map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

export default LeadKnockSheet;
