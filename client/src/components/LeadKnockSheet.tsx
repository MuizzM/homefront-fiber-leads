// ── Lead card (bottom sheet) ──────────────────────────────────────────────────
// Mobile-first card for the rep door-knocking flow. Deliberately NOT vaul/radix:
// no portal, no backdrop, no body scroll-lock — the map above must stay 100%
// interactive while the card is open. Snapping is pure transform (translateY)
// so the map never reflows, and dragging is confined to the handle/header
// regions so the status grid and body scroll are never hijacked.
//
// v4 — THREE progressive levels (Opus 5 compact-card directive), same features:
//   PEEK (collapsed): one-line truncated address, ONE status indicator (dot +
//     label in the status color), last-contact/freshness cue, ONE primary
//     action (Directions), close affordance.
//   QUICK ACTIONS (default open state, ~35–45% of screen): compact address
//     header (ONE status line: label · time · max one badge) → an icon-sized
//     utility row (Directions, Call — only with a valid phone —, Copy) → ONE
//     unified 2-column outcomes grid: the four most likely dispositions lead
//     (Not Home | Interested / Sold | Not Interested), the rest follow in the
//     same grid (Follow-up, Prospect) → recent-activity line → flat notes
//     composer. One action surface, one spacing scale, no nested cards.
//   DETAILS (expanded): premise facts, assignment (lead.assign only), admin
//     actions (manager central-mark/delete, gated Calling link), History with
//     scan evidence.
// Tapping a status saves immediately (one tap, existing optimistic+queue
// wiring), flashes a confirmation, recolors the pin upstream, and collapses
// the card to Peek. Nothing was removed — only reorganized into the levels.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Check, X, LocateFixed } from "lucide-react";
import { SHEET_PEEK_BASE_PX, setMeasuredPeekPx, setSheetDragActive } from "@/lib/mapPins";
import { copyText } from "@/lib/clipboard";
import { useTapAction } from "@/lib/tapAction";
import { mergeNotes, type NoteSaveResult } from "@/lib/leadNotes";
import { useCan } from "@/lib/capabilities";
import { apiRequest } from "@/lib/queryClient";
import { captureFieldFix } from "@/lib/geoFix";
import {
  OUTCOME_META, STATE_LABELS, pinDisplayState, isKnockOutcome,
  haversineMeters, distanceHint, todayISO, DS_TO_OUTCOME,
  type KnockOutcome,
} from "@shared/knock";
import { ICON_MAP } from "@/components/lead-sheet/OutcomeButton";
import { STATUS_CONFIG, toLeadMapStatus } from "@shared/statusConfig";
import { normalizeZip5 } from "@shared/addressKey";
import { LeadContacts } from "@/components/LeadContacts";
import { leadDisplayName, type TracedPhone } from "@shared/tracerfy";
import { PeekBar, circleBtn } from "@/components/lead-sheet/PeekBar";
import { StatusPinChip } from "@/components/lead-sheet/StatusPinChip";
import { QuickBody } from "@/components/lead-sheet/QuickBody";
import { DetailsBody } from "@/components/lead-sheet/DetailsBody";
import { ContactSection } from "@/components/lead-sheet/ContactSection";
import { QuickLinks } from "@/components/lead-sheet/QuickLinks";
import { SheetPhotos } from "@/components/lead-sheet/SheetPhotos";
import { relativeTime, prefersReducedMotion, shortRepName, MUTED, BODY_TEXT } from "@/components/lead-sheet/utils";
import { QuickSlotRow } from "@/components/lead-sheet/QuickSlots";
import { describeAppointment } from "@shared/schedule";
import { isFccReportedLead } from "@/lib/leadSourceFilter";
import { useToast } from "@/hooks/use-toast";
import type { HistoryRow, LeadDetail, TeamMember } from "@/components/lead-sheet/types";

/** How long after a tap the door can be put back with one more tap. */
export const UNDO_WINDOW_MS = 8000;

// The three snap levels. "quick" is the default open state.
export type SheetSnap = "peek" | "quick" | "details";

export interface SheetLead {
  id: number; lat?: number | null; lng?: number | null;
  address: string; city?: string | null; state?: string | null; zip?: string | null;
  leadStatus: string;
  assignedRepId?: number | null;  // shown/edited only for lead.assign holders
  visited?: boolean; lastOutcome?: string | null; lastKnockedAt?: string | null;
  leadTag?: string | null; freshConfidence?: string | null;
  /** Skip-trace results. The NAME belongs in Quick Actions — a knocker needs it
   *  BEFORE they knock — while the full number list sits in Details, because at
   *  the door you are talking, not dialling, and the outcome grid must not get
   *  pushed below the fold to make room for phones. */
  ownerName?: string | null;
  phones?: TracedPhone[];
  // Opt-in: present only when the caller is authorized to dial this lead. The
  // Field Map pins payload carries NO phone for ordinary reps, so Call stays
  // hidden for them; the separate Calling workspace remains the gated path.
  phone?: string | null;
  // Do-not-knock flag. The server is adding this to map pins in parallel —
  // code defensively: undefined/null/0 all mean "no flag", any truthy value
  // renders the prominent banner.
  doNotKnock?: boolean | number | null;
}

// Schedule payload a disposition can carry — the appointment composer sends
// the follow-up date/time WITH the knock so one tap persists both (the queue
// and the server's knock row already carry these columns).
export interface KnockScheduleOpts {
  callbackDate?: string | null; // "YYYY-MM-DD" (rep-local calendar date)
  callbackTime?: string | null; // "HH:mm"
}

export interface LeadKnockSheetProps {
  lead: SheetLead | null;                 // null → animate out then unmount after 200ms
  // Explicit false means the command was rejected before it could be queued.
  // Void remains accepted for backward-compatible non-map consumers.
  onKnock: (outcome: KnockOutcome, opts?: KnockScheduleOpts) => boolean | void;
  // Lead-level notes, persisted inline. Explicit leadId so a pending debounce
  // for the OUTGOING lead can flush during a card swap; returns the save
  // result so the card can render Saving/Saved and merge 409 conflicts.
  onSaveNote: (leadId: number, note: string, baseUpdatedAt: string | null) => Promise<NoteSaveResult>;
  onClose: () => void;                    // close button / escape / overdrag (map tap closes upstream)
  // Docked mode only: shift the card left by this many px so it never covers
  // a right-side rail (the leads panel) — a rail-row tap must keep the list
  // visible beside the card, or list-driven triage dies (review finding).
  dockOffsetPx?: number;
  // Published MEASURED visible height of the current collapsed level (peek bar
  // in Peek, quick-actions block in Quick) so MapView's camera bottom-padding
  // tracks the real sheet lip instead of a hardcoded constant.
  onPeekHeight?: (px: number) => void;
  // MANAGER ACTIONS (owner ask 2026-07-26): central marking (no rep credit) and
  // lead deletion, for manually-added pins that turn out not to be new fiber.
  canManage?: boolean;
  onCentralMark?: (outcome: KnockOutcome) => boolean | void | Promise<boolean | void>;
  onDelete?: () => void;
  // The nearest OPEN door from where the rep stands (MapView ranks it with the
  // same rule as the Nearest doors strip, excluding this door and the doors
  // just worked). Offered in the peek lip right after a mark so the rep flows
  // door to door without closing the card. Null when nothing honest is near.
  nextDoor?: NextDoor | null;
  onOpenLead?: (id: number) => void;
}

export interface NextDoor {
  id: number;
  address: string;
  meters: number;
  atDoor: boolean;
}

// Dispositions that mean "come back": the post-mark step is a time, not the
// next door.
const COME_BACK: ReadonlySet<KnockOutcome> = new Set<KnockOutcome>(["interested", "follow_up", "go_back"]);

// Tap-vs-drag threshold: header taps must still land.
const TAP_SLOP_PX = 6;
// A finger is not a mouse. A mouse click moves 0-1px; a thumb tap on a phone
// routinely drifts 6-10px, and every one of those pixels used to read as a
// deliberate drag - which cancelled the tap. Touch gets the slop browsers give
// their own tap recognizers.
const TOUCH_SLOP_PX = 14;
const slopFor = (pointerType: string | undefined): number =>
  pointerType === "touch" || pointerType === "pen" ? TOUCH_SLOP_PX : TAP_SLOP_PX;

// A press that lands on a CONTROL belongs to that control, never to the sheet.
//
// This is the fix for "the address does not copy on my phone". The Copy and
// Close discs live INSIDE the header drag region. A tap whose finger drifted
// past the slop promoted the press to a sheet drag, which armed suppressClick,
// which ate the click in the CAPTURE phase - so the copy handler never ran and
// the rep saw nothing happen. A mouse never drifts, so it only ever broke in
// the field. Reproduced at 8px of drift in tests/rtl/LeadKnockSheet.test.tsx.
//
// Deny-by-default: any control added inside a drag region later is protected
// without anyone remembering this comment. Only [data-drag-handle] opts back in
// - the handle is a button on purpose (a tap cycles the levels) AND is the
// primary drag affordance.
const INTERACTIVE_TARGET =
  "button, a, input, textarea, select, [role='button'], [contenteditable='true']";
const pressBelongsToAControl = (target: EventTarget | null): boolean => {
  const el = target as Element | null;
  if (!el?.closest) return false;
  const control = el.closest(INTERACTIVE_TARGET);
  return Boolean(control) && !control!.closest("[data-drag-handle]");
};
// Dragging further than this below the peek position dismisses the sheet.
const CLOSE_OVERDRAG_PX = 80;
// Flick faster than this decides snap direction regardless of position.
const FLICK_VELOCITY = 0.5; // px/ms
// A snap settles in the time the remaining travel takes at the release speed
// (floored so a 40px correction still reads as motion, capped so a 500px
// handle jump never lurches); the close path is capped by the unmount timer.
const SNAP_MS_MIN = 120;
const SNAP_MS_MAX = 280;

// ONE disposition surface, FIXED order (a control never moves under the
// finger): every field disposition as the same 44px disc, six per row, in
// FIELD_OUTCOMES order (the four most likely reads lead the first row). The
// active outcome mirrors the lead's CURRENT display state — DS_TO_OUTCOME
// lives in shared/knock.ts so every disposition surface reads one mirror.

// One responsive card, two homes: bottom sheet under ~1024px, docked right
// panel above it (same components, same behavior — no forked UI).
const DOCK_QUERY = "(min-width: 1024px)";
function useDocked(): boolean {
  const [docked, setDocked] = useState<boolean>(() => {
    try { return window.matchMedia(DOCK_QUERY).matches; } catch { return false; }
  });
  useEffect(() => {
    try {
      const mq = window.matchMedia(DOCK_QUERY);
      const on = (e: MediaQueryListEvent) => setDocked(e.matches);
      mq.addEventListener("change", on);
      return () => mq.removeEventListener("change", on);
    } catch { return undefined; } // jsdom stub — stays a bottom sheet
  }, []);
  return docked;
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

function LeadKnockSheetInner(props: LeadKnockSheetProps): JSX.Element | null {
  const { canManage = false, onCentralMark, onDelete, nextDoor = null, onOpenLead } = props;
  const { lead, onKnock, onSaveNote, onClose, dockOffsetPx = 0, onPeekHeight } = props;

  // Keep the last lead rendered while `lead: null` animates the sheet out.
  // 200ms matches the exit transition — the map is interactive the whole time
  // (pointer-events are dropped the instant close starts, below).
  const [renderedLead, setRenderedLead] = useState<SheetLead | null>(lead);
  const closing = lead === null;
  useEffect(() => {
    if (lead) { setRenderedLead(lead); return; }
    const t = setTimeout(() => setRenderedLead(null), 200);
    return () => clearTimeout(t);
  }, [lead]);

  const docked = useDocked();
  const [snap, setSnap] = useState<SheetSnap>("quick"); // QUICK is the default open state
  // ── Undo ─────────────────────────────────────────────────────────────────
  // A mark is one tap and saves silently (the map already shows it), so the
  // only honest mistake-fixer is a short window to put the door back. Undo
  // re-logs the disposition the door carried before the tap, through the
  // SAME knock path (so a wrong "sold" reverses its commission the normal
  // way); it never deletes history. Cleared on a card swap or after the window.
  const [undo, setUndo] = useState<{ prev: KnockOutcome; outcome: KnockOutcome; leadId: number } | null>(null);
  const undoTimer = useRef<number | null>(null);
  // Every short-lived UI timer the card arms (flash, copied, delete-arm, undo)
  // is tracked and cleared on unmount: a timer that fires after the sheet is
  // gone sets state on an unmounted component (and, in jsdom, after teardown).
  const uiTimers = useRef<Set<number>>(new Set());
  const armTimer = (fn: () => void, ms: number): number => {
    const id = window.setTimeout(() => { uiTimers.current.delete(id); fn(); }, ms);
    uiTimers.current.add(id);
    return id;
  };
  useEffect(() => () => {
    uiTimers.current.forEach(id => window.clearTimeout(id));
    uiTimers.current.clear();
    if (suppressClearTimer.current != null) window.clearTimeout(suppressClearTimer.current);
  }, []);
  const activeOutcomeRef = useRef<KnockOutcome | null>(null);
  const armUndo = (next: typeof undo) => {
    if (undoTimer.current != null) { window.clearTimeout(undoTimer.current); undoTimer.current = null; }
    setUndo(next);
    if (next) undoTimer.current = armTimer(() => setUndo(u => (u === next ? null : u)), UNDO_WINDOW_MS);
  };
  const [note, setNote] = useState("");                // composer DRAFT — clears once committed
  const [noteOpen, setNoteOpen] = useState(false);     // collapsed "+ Add note" chip → textarea on focus
  const [noteState, setNoteState] = useState<"idle" | "saving" | "saved" | "queued" | "conflict" | "rejected">("idle");
  const [lastCommittedNote, setLastCommittedNote] = useState<string | null>(null); // pinned "latest note"
  const [flashKey, setFlashKey] = useState<KnockOutcome | null>(null); // brief tap-confirm flash
  const [copiedAddr, setCopiedAddr] = useState<false | "ok" | "failed">(false); // copy disc feedback
  const copyFeedbackTimer = useRef<number | null>(null);
  // The last accepted rep mark on THIS card: drives the post-mark next step
  // (Set a time / Next door). Cleared on a card swap, an undo, or a scheduled
  // commit (the appointment IS the follow-through).
  const [marked, setMarked] = useState<{ leadId: number; outcome: KnockOutcome } | null>(null);
  const noteBaseRef = useRef<string | null>(null);     // lead.updatedAt we loaded — conflict base
  const liveNoteRef = useRef<{ leadId: number; value: string } | null>(null); // for outgoing-lead flush
  const committingRef = useRef(false);                 // one in-flight commit at a time
  const noteInputRef = useRef<HTMLTextAreaElement>(null);

  const sheetRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);      // drag handle (measured for both levels)
  const peekBarRef = useRef<HTMLDivElement>(null);     // peek content (measured; clipped when inactive)
  const headerRef = useRef<HTMLDivElement>(null);      // compact header (drag region + measured)
  const quickBodyRef = useRef<HTMLDivElement>(null);   // quick-actions body (measured)
  const mainRef = useRef<HTMLDivElement>(null);        // quick+details content (inert in peek)
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // ── Geometry: measure sheet + safe area + the two collapsed levels so snaps
  // are numeric AND the map camera padding tracks the real sheet lip ──────────
  const [sheetH, setSheetH] = useState(0);
  const [safeBottom, setSafeBottom] = useState(0);
  const [peekPx, setPeekPx] = useState<number | null>(null);   // handle + peek bar
  const [quickPx, setQuickPx] = useState<number | null>(null); // handle + header + quick body
  const lastPublished = useRef<{ snap: SheetSnap; px: number } | null>(null);
  const mounted = renderedLead != null;

  // Entrance: the FULL shell (header + grid + notes, from the pin payload the
  // caller already holds) mounts and paints on the open frame; only the slide
  // is animated — a one-frame flip from the off-screen transform to the snap
  // transform, riding the 200ms GPU transform transition below. Nothing waits
  // on a fetch. Reduced-motion users get it instant via the global CSS block.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    if (!mounted) { setEntered(false); return; }
    if (entered) return;
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);
  useLayoutEffect(() => {
    if (!mounted) {
      setMeasuredPeekPx(null);          // no sheet → camera padding falls back
      lastPublished.current = null;
      return;
    }
    lastPublished.current = null;       // new lead/layout/snap → force a fresh publish
    // offsetHeight is a pure layout read (transform- and scroll-independent):
    // the peek bar stays measurable even while clipped inside its h-0 wrapper,
    // so both levels are known in every snap/drag state.
    const publish = () => {
      const handle = handleRef.current?.offsetHeight ?? 0;
      const peekBar = peekBarRef.current?.offsetHeight ?? 0;
      const header = headerRef.current?.offsetHeight ?? 0;
      const quickBody = quickBodyRef.current?.offsetHeight ?? 0;
      const peek = handle + peekBar;
      const quick = handle + header + quickBody;
      if (peek > 0) setPeekPx(p => (p != null && Math.abs(p - peek) < 2 ? p : peek));
      if (quick > 0) setQuickPx(q => (q != null && Math.abs(q - quick) < 2 ? q : quick));
      // Publish the CURRENT collapsed level's visible height (peek bar in Peek,
      // quick block in Quick/Details) → camera padding + bottom-slot track the
      // sheet lip. The onPeekHeight contract is unchanged: measured px, never a
      // hardcoded constant.
      const px = snap === "peek" ? peek : quick;
      if (px <= 0) return;
      if (lastPublished.current && lastPublished.current.snap === snap
          && Math.abs(lastPublished.current.px - px) < 2) return;
      lastPublished.current = { snap, px };
      setMeasuredPeekPx(px);            // → sheetPeekPaddingPx() (mapPins)
      onPeekHeight?.(px);               // → MapView re-pads the camera
    };
    const measure = () => {
      if (sheetRef.current) setSheetH(sheetRef.current.offsetHeight);
      setSafeBottom(readSafeAreaBottom());
      publish();
    };
    measure();
    let ro: ResizeObserver | null = null;
    try {
      ro = new ResizeObserver(publish);        // catches note-composer expand
      for (const ref of [handleRef, peekBarRef, headerRef, quickBodyRef]) {
        if (ref.current) ro.observe(ref.current);
      }
    } catch { /* jsdom: no ResizeObserver */ }
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      try { ro?.disconnect(); } catch { /* noop */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, renderedLead?.id, docked, snap]);

  const peekVisiblePx = peekPx ?? SHEET_PEEK_BASE_PX;
  const quickVisiblePx = quickPx ?? SHEET_PEEK_BASE_PX;
  const peekY = Math.max(0, sheetH - (peekVisiblePx + safeBottom));
  const quickY = Math.max(0, sheetH - (quickVisiblePx + safeBottom));
  // Velocity-matched settle: the NEXT snap transition's duration, written by
  // whoever requests the snap (tap, flick, release, mark) from the distance
  // left to travel and the release speed. A ref, not state: it only matters
  // on the render that applies the new snap.
  const snapMsRef = useRef(200);
  // A drag-dismiss keeps its momentum out; a programmatic close (X, Escape,
  // map tap) accelerates away instead of reusing the entrance's decel curve.
  const closeByDragRef = useRef(false);
  const offsetOf = (s: SheetSnap) => (s === "details" ? 0 : s === "quick" ? quickY : peekY);
  const settleMs = (fromY: number, toY: number, vy = 0) =>
    Math.round(Math.min(SNAP_MS_MAX, Math.max(SNAP_MS_MIN, Math.abs(toY - fromY) / Math.max(Math.abs(vy), 1.1))));
  const snapTo = (next: SheetSnap, fromY?: number, vy = 0) => {
    snapMsRef.current = settleMs(fromY ?? offsetOf(snap), offsetOf(next), vy);
    setSnap(next);
  };

  // ── Drag (handle + peek bar + header only) ─────────────────────────────────
  // Per-frame drag position lives in a REF and is written straight to
  // sheetRef.style.transform — React renders exactly twice per drag (start: drop
  // the transition class; end: snap), never once per pointermove. A stray
  // re-render mid-drag is harmless: the render-time transform reads dragYRef.
  const [dragging, setDragging] = useState(false);
  const dragYRef = useRef(0);
  const dragRef = useRef<{
    pointerId: number; startClientY: number; startOffset: number;
    lastY: number; lastT: number; vy: number; moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const suppressClearTimer = useRef<number | null>(null); // disarms suppressClick after a touch drag
  // Never leave the pulse loop paused if the sheet unmounts mid-drag.
  useEffect(() => () => setSheetDragActive(false), []);

  const currentOffset = () => {
    if (closing) return sheetH;
    if (dragging) return dragYRef.current;
    return snap === "details" ? 0 : snap === "quick" ? quickY : peekY;
  };
  // The sheet's LIVE translateY, mid-transition included, so a grab during a
  // snap continues from where the sheet IS instead of teleporting by the
  // remaining travel on the first move. Falls back to the snap offset (jsdom
  // has no DOMMatrix and no computed transform).
  const liveOffset = () => {
    const el = sheetRef.current;
    if (!el || dragging || closing) return currentOffset();
    try {
      const t = getComputedStyle(el).transform;
      if (t && t !== "none") {
        const y = new DOMMatrix(t).m42;
        if (Number.isFinite(y)) return Math.max(0, y);
      }
    } catch { /* jsdom */ }
    return currentOffset();
  };

  // NO pointer capture on the press itself. Capturing here retargeted the
  // pointerup — and with it the compatibility click — to the drag region, so
  // the close / copy / handle buttons that live INSIDE the regions never
  // received their click from a mouse or trackpad (touch survived only because
  // the browser synthesizes a tap's click from the gesture, not the pointer
  // stream). Capture is taken the moment a press becomes a real drag, below.
  const handlePointerDown = (e: React.PointerEvent) => {
    if (closing || docked) return; // docked panel: nothing to drag
    // Primary button / first finger only: a right-click or a second finger
    // must never start (or overwrite) a press.
    if (e.button !== 0 || !e.isPrimary) return;
    // The press is a button's, not the sheet's: never start a drag from it.
    if (pressBelongsToAControl(e.target)) return;
    dragRef.current = {
      pointerId: e.pointerId, startClientY: e.clientY, startOffset: liveOffset(),
      lastY: e.clientY, lastT: e.timeStamp, vy: 0, moved: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    // With capture deferred until a real drag, a press that is released OFF
    // the region never reaches endDrag. A mouse move with no button held is
    // therefore a stale press, never a drag: drop it (and end a drag that was
    // somehow still live) instead of gluing the sheet to a hovering cursor.
    if (e.buttons === 0) { abandonPress(); return; }
    const total = e.clientY - d.startClientY;
    if (!d.moved && Math.abs(total) < slopFor(e.pointerType)) return; // still a tap
    if (!d.moved) {
      d.moved = true;
      // A real drag: own the pointer now so the sheet keeps following the
      // finger even once it leaves the region (and a stray click lands on
      // the region, where swallowDragClick eats it).
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* jsdom */ }
      dragYRef.current = Math.max(0, d.startOffset + total);
      setDragging(true); // ONE render: drops the transition class
      setSheetDragActive(true); // pauses the map pulse loop for the drag
      suppressClick.current = true;
    }
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.vy = (e.clientY - d.lastY) / dt;
    d.lastY = e.clientY;
    d.lastT = e.timeStamp;
    // Per-frame position: ref + direct style write, zero React work.
    dragYRef.current = Math.max(0, d.startOffset + total);
    if (sheetRef.current) sheetRef.current.style.transform = `translateY(${dragYRef.current}px)`;
  };

  // Snap order from top (fully open) to bottom (collapsed): details → quick → peek.
  const endDrag = (e: React.PointerEvent, cancelled: boolean) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragRef.current = null;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* jsdom */ }
    if (!d.moved) {
      // A tap — let the click reach its target. If a drag was somehow still
      // live (a phantom from an abandoned press), settle it now.
      if (dragging) { setDragging(false); setSheetDragActive(false); snapMsRef.current = 160; }
      return;
    }
    setDragging(false); // ONE render: restores the transition class + snap transform
    setSheetDragActive(false);
    if (suppressClearTimer.current != null) window.clearTimeout(suppressClearTimer.current);
    suppressClearTimer.current = window.setTimeout(() => { suppressClick.current = false; suppressClearTimer.current = null; }, 50);
    if (cancelled) { snapMsRef.current = 160; return; } // spring back to the current snap
    const y = Math.max(0, d.startOffset + (d.lastY - d.startClientY));
    // Swipe down past the peek lip dismisses the sheet, carrying its momentum
    // out (capped at the 200ms unmount timer).
    if (y > peekY + CLOSE_OVERDRAG_PX) {
      snapMsRef.current = Math.min(200, settleMs(y, sheetH, d.vy));
      closeByDragRef.current = true;
      onClose();
      return;
    }
    const ORDER: SheetSnap[] = ["details", "quick", "peek"];
    const OFFSETS = [0, quickY, peekY];
    if (Math.abs(d.vy) > FLICK_VELOCITY) {
      const idx = ORDER.indexOf(snap);
      // Flick up = open one level, flick down = collapse one level.
      snapTo(d.vy < 0 ? ORDER[Math.max(0, idx - 1)] : ORDER[Math.min(ORDER.length - 1, idx + 1)], y, d.vy);
    } else {
      // Settle on the nearest of the three snap points.
      let best = 0;
      for (let i = 1; i < OFFSETS.length; i++) {
        if (Math.abs(y - OFFSETS[i]) < Math.abs(y - OFFSETS[best])) best = i;
      }
      snapTo(ORDER[best], y, d.vy);
    }
  };

  // Forget a press that ended where we cannot see it (left the region before
  // the tap slop, lost capture to the browser, context menu ate the release).
  // If a drag was live, settle it like a cancel: spring back to the snap.
  const abandonPress = () => {
    const wasDragging = dragRef.current?.moved ?? false;
    dragRef.current = null;
    if (wasDragging || dragging) {
      snapMsRef.current = 160;
      setDragging(false);
      setSheetDragActive(false);
    }
  };

  // A real drag must not fire the click of whatever the pointer landed on.
  // A TOUCH drag produces no click at all, so the flag must not outlive the
  // gesture, or the rep's next tap on any region button is eaten: endDrag
  // disarms it right after the click a mouse release would have dispatched.
  const swallowDragClick = (e: React.MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // Shared drag-region wiring: handle, peek bar, and the compact header all
  // drag the sheet (buttons inside still tap — TAP_SLOP_PX disambiguates).
  const dragRegionProps = {
    "data-drag-region": true,
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: (e: React.PointerEvent) => endDrag(e, false),
    onPointerCancel: (e: React.PointerEvent) => endDrag(e, true),
    // A press that leaves the region before it became a drag is abandoned
    // (once it IS a drag, capture keeps the moves coming and leave never fires).
    onPointerLeave: () => { if (dragRef.current && !dragRef.current.moved) dragRef.current = null; },
    onLostPointerCapture: abandonPress,
    onClickCapture: swallowDragClick,
  } as const;

  // ── Per-lead reset ───────────────────────────────────────────────────────────
  const prevLeadId = useRef<number | null>(null);
  useEffect(() => {
    const id = renderedLead?.id ?? null;
    if (id === prevLeadId.current) return;
    const hadLead = prevLeadId.current != null;
    // Per-lead isolation: an uncommitted draft belongs to the OUTGOING lead —
    // a card swap is an implicit blur, so commit it before this card rebinds.
    const live = liveNoteRef.current;
    if (live && live.value.trim()) {
      void onSaveNote(live.leadId, live.value.trim(), noteBaseRef.current);
    }
    prevLeadId.current = id;
    if (id == null) return;
    setSnap("quick"); // default open state for a newly selected lead
    snapMsRef.current = 200;
    closeByDragRef.current = false;
    // A Next door "Open" unmounts the button under the keyboard; keep focus in
    // the dialog rather than letting it fall to the page body.
    if (hadLead && (document.activeElement === document.body || document.activeElement == null)) {
      sheetRef.current?.focus({ preventScroll: true });
    }
    setNote("");
    setNoteOpen(false);
    armUndo(null);
    setNoteState("idle");
    setLastCommittedNote(null);
    setFlashKey(null);
    setCopiedAddr(false);
    setMarked(null);
    noteBaseRef.current = null;
    liveNoteRef.current = null;
    setDragging(false);
    dragRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderedLead?.id]);

  // Escape closes (only while actually open).
  useEffect(() => {
    if (!lead) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lead, onClose]);

  // Keep this modeless so the map remains interactive, but establish a clear
  // keyboard/screen-reader entry and return path for pin and list selection.
  const sheetOpen = Boolean(lead);
  useEffect(() => {
    if (!sheetOpen) return;
    const active = document.activeElement;
    restoreFocusRef.current = active instanceof HTMLElement ? active : null;
    const raf = requestAnimationFrame(() => {
      // A fast user may already have moved into Notes or another control before
      // this frame. Never steal that newer focus just to announce the shell.
      if (document.activeElement === active || document.activeElement === document.body) {
        sheetRef.current?.focus({ preventScroll: true });
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      const trigger = restoreFocusRef.current;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      restoreFocusRef.current = null;
    };
  }, [sheetOpen]);

  // In Peek the quick/details content is translated off-screen: pull it out of
  // the tab order and the accessibility tree so focus never lands on invisible
  // controls (inert via DOM API — React 18 doesn't own the attribute yet).
  const peekShown = !docked && snap === "peek";
  const peekWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mainRef.current?.toggleAttribute("inert", peekShown);
    if (peekShown) mainRef.current?.setAttribute("aria-hidden", "true");
    else mainRef.current?.removeAttribute("aria-hidden");
    // The peek bar is the mirror image: laid out at zero height (so it stays
    // measurable) whenever another level is active, and its Directions /
    // Close / next-step buttons must not be reachable by keyboard from there.
    peekWrapRef.current?.toggleAttribute("inert", !peekShown);
    if (!peekShown) peekWrapRef.current?.setAttribute("aria-hidden", "true");
    else peekWrapRef.current?.removeAttribute("aria-hidden");
    // A keyboard mark collapses the card to peek and inerts the column that
    // held focus; park focus on the dialog so Tab continues inside the card
    // (the peek bar's controls are next), never on the page body.
    const active = document.activeElement;
    if (peekShown && active instanceof HTMLElement && mainRef.current?.contains(active)) {
      sheetRef.current?.focus({ preventScroll: true });
    }
  }, [peekShown]);
  // Screen-reader announcements for in-place feedback (copy result, note
  // save state): one always-mounted polite region, so the text change is
  // what gets announced, never a freshly mounted node.
  const [liveMessage, setLiveMessage] = useState("");

  // ── Lead detail (notes seed) + history — fetched per selected lead ──────────
  const leadId = renderedLead?.id ?? 0;
  // staleTime: swapping back to a recently-viewed door renders from cache with
  // zero refetch — note saves invalidate this key, so it can't go stale-wrong.
  const detailQuery = useQuery<LeadDetail>({
    queryKey: [`/api/leads/${leadId}`],
    enabled: !!lead && leadId > 0,
    staleTime: 60_000,
    // First open of a door: seed from the pin payload the caller already holds
    // so locality/status/tag render on the open frame instead of after the
    // fetch. Deliberately NO updatedAt/notes here — the note-conflict base must
    // only ever come from a real server response (the effect below re-runs when
    // the fetch replaces this placeholder). Never the previous lead's data: the
    // id guard keeps a card swap from wearing the outgoing door's facts.
    placeholderData: () => (renderedLead && renderedLead.id === leadId
      ? {
          id: renderedLead.id,
          city: renderedLead.city, state: renderedLead.state, zip: renderedLead.zip,
          leadStatus: renderedLead.leadStatus, leadTag: renderedLead.leadTag,
        }
      : undefined),
  });
  useEffect(() => {
    // Composer starts empty — committed notes are read from History. The
    // detail fetch only supplies the version base for conflict-safe saves.
    if (detailQuery.data) noteBaseRef.current = detailQuery.data.updatedAt ?? null;
  }, [detailQuery.data, leadId]);

  // ── Assignment (capability-gated; team list fetched only when permitted) ────
  const canAssignLead = useCan("lead.assign");
  const canOpenCalling = useCan("calling.lead.read");
  const qc = useQueryClient();
  const { toast } = useToast();
  const teamQuery = useQuery<TeamMember[]>({
    queryKey: ["/api/team"],
    enabled: canAssignLead && !!lead,
    staleTime: 5 * 60_000,
  });
  const assignLeadMutation = useMutation({
    mutationFn: ({ leadId, repId }: { leadId: number; repId: number | null }) =>
      apiRequest("POST", `/api/leads/${leadId}/assign`, { repId }),
    onMutate: ({ leadId, repId }) => {
      const pins = qc.getQueryData<any>(["/api/leads/map"])?.pins as Array<{ id: number; assignedRepId?: number | null }> | undefined;
      const previousAssignedRepId = pins?.find((pin) => pin.id === leadId)?.assignedRepId ?? null;
      qc.setQueryData(["/api/leads/map"], (old: any) => {
        if (!old?.pins) return old;
        return { ...old, pins: old.pins.map((p: any) => (p.id === leadId ? { ...p, assignedRepId: repId } : p)) };
      });
      return { previousAssignedRepId };
    },
    onSuccess: (_response, { leadId }) => {
      qc.invalidateQueries({ queryKey: [`/api/leads/${leadId}/history`] });
      qc.invalidateQueries({ queryKey: [`/api/leads/${leadId}`] });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
    },
    onError: (error: any, { leadId, repId }, context) => {
      qc.setQueryData(["/api/leads/map"], (old: any) => {
        if (!old?.pins) return old;
        return {
          ...old,
          pins: old.pins.map((p: any) => (
            p.id === leadId && p.assignedRepId === repId
              ? { ...p, assignedRepId: context?.previousAssignedRepId ?? null }
              : p
          )),
        };
      });
      qc.invalidateQueries({ queryKey: ["/api/leads/map"] });
      toast({
        title: "Assignment wasn't saved",
        description: String(error?.message ?? "Try again."),
        variant: "destructive",
      });
    },
  });
  const assignLead = (repId: number | null) => {
    const leadId = renderedLead?.id;
    if (!leadId || assignLeadMutation.isPending) return;
    assignLeadMutation.mutate({ leadId, repId });
  };

  const historyQuery = useQuery<HistoryRow[]>({
    queryKey: [`/api/leads/${leadId}/history`],
    enabled: !!lead && leadId > 0,
    staleTime: 30_000, // knock saves + note commits invalidate this key
  });
  const history = historyQuery.data ?? [];

  // ── One-tap disposition ──────────────────────────────────────────────────────
  const tapGuard = useRef(0); // absorbs accidental double-fires of the same tap
  const statusCommandPendingRef = useRef(false);
  // Manager modes: CENTRAL routes the next status tap to the central-team
  // endpoint (no rep credit); DELETE arms a two-tap inline confirm.
  const [centralMode, setCentralMode] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  useEffect(() => { setCentralMode(false); setDeleteArmed(false); }, [lead?.id]);

  // ── Appointment composer (SalesHub "Set Appointment" parity) ────────────────
  // A follow-up with a real date/time. Committing logs ONE knock through the
  // normal offline-queue path with callbackDate/Time attached — the columns,
  // the queue, and the Follow-ups read model all exist, so this is pure UI.
  const [apptOpen, setApptOpen] = useState(false);
  const [apptDate, setApptDate] = useState("");
  const [apptTime, setApptTime] = useState("");
  useEffect(() => { setApptOpen(false); setApptDate(""); setApptTime(""); }, [lead?.id]);

  // ── Live proximity (distance from the rep to THIS door) ────────────────────
  // One fresh fix per card open (captureFieldFix never rejects; ~instant when
  // the map's geolocate watch has a recent reading via maximumAge). Display
  // only — the server keeps verifying knock distance with its own evidence.
  const [repFix, setRepFix] = useState<{ lat: number; lng: number; accuracy: number | null } | null>(null);
  const [fixState, setFixState] = useState<"idle" | "locating">("idle");
  const fixLeadRef = useRef<number | null>(null);
  const requestFix = (id: number) => {
    fixLeadRef.current = id;
    setFixState("locating");
    void captureFieldFix(3500).then(f => {
      if (fixLeadRef.current !== id) return; // card swapped mid-fix
      setFixState("idle");
      setRepFix(f.repLat != null && f.repLng != null
        ? { lat: f.repLat, lng: f.repLng, accuracy: f.gpsAccuracy }
        : null);
    });
  };
  useEffect(() => {
    const id = lead?.id;
    if (!id) return;
    requestFix(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead?.id]);

  const handleStatusTap = async (key: KnockOutcome, opts?: KnockScheduleOpts, meta?: { undo?: boolean }): Promise<boolean> => {
    const now = Date.now();
    if (now - tapGuard.current < 350) return false; // double-submit guard
    tapGuard.current = now;
    // What the door showed BEFORE this tap — the disposition Undo returns to.
    // A legacy state with no button (contacted) falls back to the pool reset.
    const prevOutcome: KnockOutcome = activeOutcomeRef.current ?? "prospect";
    let accepted = false;
    if (centralMode && canManage && onCentralMark && !opts) {
      if (statusCommandPendingRef.current) return false;
      statusCommandPendingRef.current = true;
      // Wait for the server-authoritative command. A failure must not flash,
      // collapse, or disarm the manager workflow as though it had succeeded.
      try {
        accepted = (await onCentralMark(key)) !== false;
      } catch {
        accepted = false;
      } finally {
        statusCommandPendingRef.current = false;
      }
      if (!accepted) return false;
      // AUDIT FIX: disarm after one mark — the hint says "next status tap",
      // and an armed manager silently stripped rep credit on later doors.
      setCentralMode(false);
    } else {
      // A scheduled disposition (the appointment composer) always goes through
      // the rep knock path — the central endpoint carries no callback columns,
      // and an appointment is field work, not a central correction. Plain taps
      // keep the one-arg call shape every existing consumer was written for.
      accepted = (opts ? onKnock(key, opts) : onKnock(key)) !== false;
    }
    if (!accepted) return false;
    // Arm Undo for an ordinary rep tap that actually changed the door. Central
    // corrections, appointments and the undo itself never arm it.
    const leadId = renderedLead?.id;
    if (!meta?.undo && !opts && !(centralMode && canManage && onCentralMark) && leadId && prevOutcome !== key) {
      armUndo({ prev: prevOutcome, outcome: key, leadId });
    } else {
      armUndo(null);
    }
    // The next step after a plain rep mark; an undo or a scheduled commit
    // clears it (there is nothing left to suggest).
    setMarked(!meta?.undo && !opts && leadId ? { leadId, outcome: key } : null);
    try { navigator.vibrate?.(key === "sold" ? [12, 40, 12] : 10); } catch { /* unsupported */ }
    // Brief filled + check flash confirms only an accepted command. A rejected
    // manager/rep action stays open so the user can correct assignment/session.
    if (!prefersReducedMotion()) {
      setFlashKey(key);
      armTimer(() => setFlashKey(k => (k === key ? null : k)), 150);
    }
    // Marking is the moment of commitment: confirm, then collapse to Peek so the
    // map (and the freshly recolored pin) is back in view immediately.
    if (!docked) snapTo("peek");
    return true;
  };
  const undoLastTap = () => {
    const u = undo;
    if (!u || u.leadId !== renderedLead?.id) return;
    tapGuard.current = 0; // the undo is a deliberate second tap, never a double-submit
    armUndo(null);
    void handleStatusTap(u.prev, undefined, { undo: true });
  };
  const undoChip = (testid: string) => undo && undo.leadId === renderedLead?.id ? (
    <button
      type="button"
      data-testid={testid}
      onClick={undoLastTap}
      aria-label={`Undo, put the door back to ${OUTCOME_META[undo.prev].label}`}
      className="tap-expand relative ml-1 inline-flex h-7 shrink-0 items-center rounded-full border border-white/[0.14] bg-white/[0.06] px-2.5 text-[11px] font-bold uppercase tracking-wide text-white/85 tap-press"
    >
      Undo
    </button>
  ) : null;

  // ── Notes: composer model ────────────────────────────────────────────────────
  // Typing is pure local state (never touches the network). Committing — blur,
  // the Add button, or a card swap — sends ONE write, logs ONE history event,
  // and CLEARS the draft; the note is then read from History (and pinned as the
  // "latest note"). Offline commits stash durably and clear too.
  const commitNote = (value: string) => {
    const id = renderedLead?.id;
    const text = value.trim();
    if (!id || !text || committingRef.current) return;
    committingRef.current = true;
    setNoteState("saving");
    const finish = (state: "saved" | "queued" | "conflict") => {
      committingRef.current = false;
      setNoteState(state);
      setLastCommittedNote(text); // pin the just-committed note so it never feels lost
      // Clear ONLY what was committed — keep anything typed since.
      setNote(cur => {
        const rest = cur.startsWith(value) ? cur.slice(value.length) : cur === value ? "" : cur;
        liveNoteRef.current = rest.trim() ? { leadId: id, value: rest } : null;
        return rest.trimStart();
      });
    };
    void onSaveNote(id, text, noteBaseRef.current).then(r => {
      if (r.status === "saved") { noteBaseRef.current = r.updatedAt; finish("saved"); return; }
      if (r.status === "queued") { finish("queued"); return; }
      // DATA-LOSS FIX: a rejected save (400/403/404) must release the in-flight
      // lock, or committingRef stays true and every later note commit for the
      // life of this sheet is silently swallowed. Keep the draft (nothing
      // persisted) and show an honest, retryable state - "conflict" copy would
      // wrongly claim a newer note exists.
      if (r.status === "rejected") { committingRef.current = false; setNoteState("rejected"); return; }
      // Conflict: another device wrote since we loaded — merge and re-commit
      // once against the fresh version, never silently overwrite.
      const merged = mergeNotes(r.status === "conflict" ? r.serverNotes : "", text);
      void onSaveNote(id, merged, r.status === "conflict" ? r.updatedAt : noteBaseRef.current).then(r2 => {
        if (r2.status === "saved") { noteBaseRef.current = r2.updatedAt; finish("saved"); return; }
        if (r2.status === "queued") { finish("queued"); return; }
        // HONESTY FIX: a second conflict is NOT a save — the merged text never
        // persisted. Keep the draft and say so (was: chip read "Saved to
        // history" while nothing was written).
        finish("conflict");
      });
    });
  };

  useEffect(() => {
    if (noteState === "idle") return;
    setLiveMessage(
      noteState === "saving" ? "Saving note" : noteState === "queued" ? "Note saved offline"
      : noteState === "conflict" ? "Note not saved, a newer note exists" : noteState === "rejected" ? "Note not saved, tap Add to retry"
      : "Note saved to history",
    );
  }, [noteState]);

  const handleNoteChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setNote(v);
    if (noteState === "saved" || noteState === "rejected") setNoteState("idle"); // fresh draft — stale chip off
    const id = renderedLead?.id;
    liveNoteRef.current = id && v.trim() ? { leadId: id, value: v } : null;
  };

  // The Copy and Close discs live inside a `touch-action: none` drag region, so
  // a tap whose finger drifted past the browser's own slop produces NO click
  // and nothing happens at all. They act on pointerup instead; see
  // lib/tapAction.ts. Hooks, so they sit above the early return below.
  const copyAddressRef = useRef<() => void>(() => {});
  const copyTap = useTapAction(useCallback(() => { copyAddressRef.current(); }, []));
  const closeTap = useTapAction(onClose);

  if (!renderedLead) return null;

  // ── Derived display values ───────────────────────────────────────────────────
  const ds = pinDisplayState(renderedLead);
  const canonicalStatus = toLeadMapStatus(ds);
  const activeOutcome = DS_TO_OUTCOME[ds] ?? null;
  activeOutcomeRef.current = activeOutcome;
  // The card is dark, so it reads onDark where the pin colour is too dark to be
  // text (sold). Pins keep STATUS_CONFIG.color — the map contract is unchanged.
  const statusColor = STATUS_CONFIG[canonicalStatus].onDark ?? STATUS_CONFIG[canonicalStatus].color;
  const statusLabel = ds === "sold"
    ? "SOLD"
    : ds === "callback" || ds === "contacted"
    ? STATE_LABELS[ds]
    : STATUS_CONFIG[canonicalStatus].label;
  const lastKnockRel = relativeTime(renderedLead.lastKnockedAt);

  // Recent-activity line: newest history event, or the lead's own last knock
  // before history loads. Hidden for a fresh, never-touched door.
  const recent: { label: string; who: string | null; time: string } | null = (() => {
    const h0 = history[0];
    if (h0) {
      const label = h0.type === "status_change" && isKnockOutcome(h0.status) ? OUTCOME_META[h0.status].label
        : h0.type === "assignment" ? "Assigned"
        : h0.type === "note" ? "Note" : (h0.status ?? "Update");
      // Central/system status changes carry an explicit display actor — verbatim.
      const who0 = h0.type === "status_change" && (h0 as any).source
        ? (h0.actor ?? null)
        : (h0.actor ? shortRepName(h0.actor) : null);
      return { label, who: who0, time: relativeTime(h0.changedAt) };
    }
    if (renderedLead.lastOutcome || renderedLead.lastKnockedAt) {
      const label = isKnockOutcome(renderedLead.lastOutcome ?? "")
        ? OUTCOME_META[renderedLead.lastOutcome as KnockOutcome].label : "Knocked";
      return { label, who: null, time: relativeTime(renderedLead.lastKnockedAt) };
    }
    return null;
  })();

  // Pinned "latest note": this session's committed note, else the most recent
  // note from history — so the last note is always visible without expanding.
  const latestNote = lastCommittedNote ?? history.find(h => h.type === "note")?.notePreview ?? null;

  const fullAddress = [
    renderedLead.address,
    [renderedLead.city, [renderedLead.state, renderedLead.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
  ].filter(Boolean).join(", ");
  // One shared copy path (client/src/lib/clipboard.ts): Clipboard API first,
  // then a WebKit-correct execCommand fallback for plain http and in-app
  // browsers. The feedback stays honest - "Address copied" only when a path
  // reported success, "Could not copy" otherwise - and the failure branch holds
  // the message long enough to read, because a rep standing at a door needs to
  // know to read the address off the screen instead of pasting a stale one.
  const copyAddress = async () => {
    const ok = await copyText(fullAddress);
    setCopiedAddr(ok ? "ok" : "failed");
    setLiveMessage(ok ? "Address copied" : "Could not copy the address");
    // Cancel the previous confirmation's timer first. Two copies inside the
    // 1.2s window used to leave the FIRST timer running, so it cleared the
    // SECOND copy's tick a moment after it appeared and the rep saw a copy they
    // had just made report nothing.
    if (copyFeedbackTimer.current != null) window.clearTimeout(copyFeedbackTimer.current);
    copyFeedbackTimer.current = armTimer(() => setCopiedAddr(false), ok ? 1200 : 3000);
  };
  // Assigned during render so the tap handlers hoisted above the early return
  // always call the CURRENT copy, without the hooks depending on renderedLead.
  copyAddressRef.current = () => { void copyAddress(); };

  const destination = renderedLead.lat != null && renderedLead.lng != null
    ? `${renderedLead.lat},${renderedLead.lng}`
    : encodeURIComponent(
        [renderedLead.address, renderedLead.city, renderedLead.state, renderedLead.zip]
          .filter(Boolean).join(", "),
      );
  // Static deep link only — never a Mapbox API call (billing guardrail).
  const directionsHref = `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving`;

  const detailsShown = docked || snap === "details";

  // ONE status line carries everything: label · relative time · AT MOST ONE
  // badge (review beats fresh-fiber — a data problem outranks a good-news tag).
  // No stacked badge rows anywhere in the header.
  const needsReview = renderedLead.leadStatus === "address_review" || detailQuery.data?.leadStatus === "address_review";
  const freshFiber = renderedLead.leadTag === "fresh_fiber_confirmed";
  // FCC-reported fiber (fcc_fresh_block / fcc_fiber_d25): the tag is the
  // carrier's filing, not a door verification — the card warns the rep to
  // confirm serviceability at the door. One inline amber chip under the
  // status line; no new card section.
  const fccReported = isFccReportedLead(renderedLead);
  // Skip-trace contacts come from the per-lead fetch, not the pin payload —
  // MapPinRow has no phones/ownerName, so renderedLead's copies are always
  // undefined and the contact panel rendered from them never appeared.
  //
  // The id check is load-bearing, not defensive noise: the comment at the
  // placeholderData guard below claims to protect a card swap, but `leadId` is
  // derived from `renderedLead.id` one line above it, so that test is
  // unconditionally true. This one is the real thing standing between a future
  // `keepPreviousData` and a rep dialling the PREVIOUS house's number.
  const detailForLead = detailQuery.data?.id === renderedLead.id ? detailQuery.data : undefined;
  const contactPhones = detailForLead?.phones ?? renderedLead.phones;
  const contactOwnerName = detailForLead?.ownerName ?? renderedLead.ownerName;
  // "Ask for" prefers the name the RESIDENT gave the rep over the traced/GIS
  // owner — the door told us who answers it; the trace only guessed.
  const doorName = detailForLead?.contactName?.trim() || contactOwnerName;
  // Contact section renders only from a REAL server response — the seeded
  // placeholder has no contact columns, and an "Add contact" chip that
  // flickers into values a beat later reads as data loss.
  const detailSettled = Boolean(detailForLead) && !detailQuery.isPlaceholderData;
  const statusBadge: { text: string; className: string } | null = needsReview
    ? { text: "Needs review", className: "border-warning/35 bg-warning/[0.08] text-warning" }
    : freshFiber
      ? { text: "Fresh fiber", className: "border-success/35 bg-success/[0.08] text-success" }
      : null;

  const offscreen = closing || !entered;
  const programmaticClose = closing && !closeByDragRef.current;
  const transform = docked
    ? (offscreen ? "translateX(110%)" : "translateX(0)")
    : offscreen
      ? "translateY(100%)"
      : dragging
        ? `translateY(${dragYRef.current}px)`
        : snap === "details"
          ? "translateY(0px)"
          : snap === "quick"
            ? `translateY(${quickY}px)`
            : `translateY(${peekY}px)`;

  // ── Proximity chip — live distance from the rep to THIS door ───────────────
  // Rendered only when an honest number exists: door has coordinates, a GPS fix
  // arrived, and the fix isn't so loose the distance would be fiction. Tap
  // re-captures. "At door" under 60 m — inside typical lot-width GPS noise.
  const proximityChip = (() => {
    if (renderedLead.lat == null || renderedLead.lng == null) return null;
    if (!repFix) return null;
    if (repFix.accuracy != null && repFix.accuracy > 200) return null;
    const d = haversineMeters(
      { lat: repFix.lat, lng: repFix.lng },
      { lat: renderedLead.lat, lng: renderedLead.lng },
    );
    const atDoor = d <= 60;
    return (
      <button
        type="button"
        data-testid="knock-proximity"
        data-dist-m={Math.round(d)}
        onClick={() => requestFix(renderedLead.id)}
        aria-label={`${atDoor ? "You are at this door" : `${distanceHint(d)} from this door`}. Tap to refresh`}
        title="Distance from your location"
        className={[
          "relative ml-auto h-11 flex items-center gap-1.5 px-3.5 rounded-full border text-[12px] font-semibold whitespace-nowrap tap-press after:absolute after:-inset-1",
          atDoor
            ? "bg-success/[0.12] border-success/35 text-success"
            : "bg-white/[0.05] border-white/[0.10] text-white/65",
        ].join(" ")}
      >
        <LocateFixed aria-hidden="true" className={`w-[14px] h-[14px] ${fixState === "locating" ? "animate-pulse" : ""}`} />
        {atDoor ? "At door" : distanceHint(d)}
      </button>
    );
  })();

  // ── Appointment composer — a follow-up with a real date on it ──────────────
  // Collapsed trigger → date/time editor. Confirming logs ONE knock (Go Back
  // keeps its pink pin — it already persists as follow_up; everything else
  // becomes a Follow-up) with the schedule attached, through the exact
  // offline-queue path a plain status tap uses. Hidden entirely on
  // do-not-knock doors: an appointment IS a knock.
  const apptOutcome: KnockOutcome = activeOutcome === "go_back" ? "go_back" : "follow_up";
  const apptAvailable = !renderedLead.doNotKnock;
  const commitAppointment = async () => {
    if (!apptDate) return;
    const ok = await handleStatusTap(apptOutcome, { callbackDate: apptDate, callbackTime: apptTime || null });
    if (ok) { setApptOpen(false); setApptDate(""); setApptTime(""); }
  };
  const apptInput =
    "h-11 rounded-xl bg-white/[0.05] border border-white/[0.08] px-3 text-[16px] text-white focus:outline-none focus:border-primary/60";
  // The two follow-through triggers share one row as equal 44px buttons.
  const pairBtn =
    "flex-1 min-w-0 h-11 px-3 rounded-xl bg-white/[0.05] border border-white/[0.10] text-[13px] font-semibold text-white/90 whitespace-nowrap inline-flex items-center justify-center tap-press [--press-scale:0.97]";
  const appointmentEditor = (
    <div data-testid="appt-editor" className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: MUTED }}>
          Appointment
        </span>
        <button
          type="button"
          data-testid="appt-cancel"
          onClick={() => setApptOpen(false)}
          className="min-h-tap text-[12px] font-semibold text-white/65 hover:text-white/90 transition px-1 -mr-1 -my-2"
        >
          Cancel
        </button>
      </div>
      {/* One-tap times first; a tap fills the pickers below, Set still confirms. */}
      <QuickSlotRow
        date={apptDate}
        time={apptTime}
        onPick={(slot) => { setApptDate(slot.date); setApptTime(slot.time); }}
        surface="glass"
      />
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex-1 min-w-[150px]">
          <span className="block text-[11px] font-medium mb-1" style={{ color: MUTED }}>Date</span>
          <input
            type="date"
            data-testid="appt-date"
            value={apptDate}
            min={todayISO()}
            onChange={e => setApptDate(e.target.value)}
            className={`${apptInput} w-full`}
            style={{ colorScheme: "dark" }}
          />
        </label>
        {/* 132px: Chrome's 12-hour value ("06:30 PM" + clock icon) at the
            16px no-zoom size clips at anything narrower — measured. */}
        <label className="w-[132px]">
          <span className="block text-[11px] font-medium mb-1" style={{ color: MUTED }}>
            Time <span className="normal-case font-normal text-white/35">(optional)</span>
          </span>
          <input
            type="time"
            data-testid="appt-time"
            value={apptTime}
            onChange={e => setApptTime(e.target.value)}
            className={`${apptInput} w-full`}
            style={{ colorScheme: "dark" }}
          />
        </label>
        <button
          type="button"
          data-testid="appt-save"
          disabled={!apptDate}
          onClick={() => { void commitAppointment(); }}
          // ml-auto: on narrow phones the row wraps and the commit action
          // right-aligns on its own line instead of dangling bottom-left.
          className="ml-auto h-11 px-4 rounded-xl bg-primary text-primary-foreground text-[13px] font-semibold tap-press disabled:opacity-45 disabled:cursor-not-allowed"
        >
          {apptDate ? `Set for ${describeAppointment(apptDate, apptTime)}` : "Set"}
        </button>
      </div>
      <p className="mt-2 text-[11.5px] leading-snug" style={{ color: MUTED }}>
        Saves a {OUTCOME_META[apptOutcome].label} on this date. It lands on your Schedule, with a reminder 30 minutes before a timed visit.
      </p>
    </div>
  );

  // ── Post-mark next step ──────────────────────────────────────────────────
  // Right after a mark the card has collapsed to the peek lip (the map and the
  // recolored pin are back); this ONE row says what to do next. A "come back"
  // mark (Interested / Follow-up / Go Back) offers a time, which reopens the
  // card with the composer; anything else offers the nearest open door, the
  // same ranking the Nearest doors strip uses. Never both: one row, one step.
  const markedHere = marked && marked.leadId === renderedLead.id ? marked : null;
  const postMarkRow = (() => {
    if (!markedHere) return null;
    if (COME_BACK.has(markedHere.outcome) && apptAvailable) {
      if (apptOpen) return null;
      return (
        <div data-testid="knock-post-mark" data-kind="time" className={`mt-2.5 flex items-center gap-2 ${docked ? "card-swap-in" : "post-mark-in"}`}>
          <span className="min-w-0 flex-1 text-[12px] leading-snug" style={{ color: MUTED }}>
            Set a time to come back so it lands on your Schedule.
          </span>
          <button
            type="button"
            data-testid="knock-set-time"
            onClick={() => {
              setApptOpen(true);
              if (!docked) snapTo("quick");
              // This button unmounts itself; park focus on the dialog so the
              // next Tab lands in the composer, not on the page body.
              requestAnimationFrame(() => { if (document.activeElement === document.body) sheetRef.current?.focus({ preventScroll: true }); });
            }}
            className="relative shrink-0 h-9 px-3.5 rounded-full bg-primary text-primary-foreground text-[12.5px] font-semibold tap-press after:absolute after:-inset-1"
          >
            Set a time
          </button>
        </div>
      );
    }
    if (!nextDoor || !onOpenLead) return null;
    return (
      <div data-testid="knock-post-mark" data-kind="next" className={`mt-2.5 flex items-center gap-2 min-w-0 ${docked ? "card-swap-in" : "post-mark-in"}`}>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: MUTED }}>Next door</div>
          <div className="mt-0.5 text-[13px] font-semibold text-white truncate">
            {nextDoor.address}
            <span className="font-medium text-white/55"> · {nextDoor.atDoor ? "At door" : distanceHint(nextDoor.meters)}</span>
          </div>
        </div>
        <button
          type="button"
          data-testid="knock-next-door-open"
          onClick={() => onOpenLead(nextDoor.id)}
          aria-label={`Open ${nextDoor.address}`}
          className="relative shrink-0 h-9 px-3.5 rounded-full bg-primary text-primary-foreground text-[12.5px] font-semibold tap-press after:absolute after:-inset-1"
        >
          Open
        </button>
      </div>
    );
  })();

  // ── Follow-through: appointment + note as one equal pair ───────────────────
  // Two triggers side by side; whichever opens renders its editor below the
  // row. The note commit model is unchanged (Add / blur / card swap = one
  // write, one history event); the just-committed note is pinned as "latest
  // note" under the Last line.
  const noteEditorOpen = noteOpen || Boolean(note.trim());
  const followThrough = (
    <div className="mt-3" data-testid="knock-follow-through">
      {(apptAvailable && !apptOpen) || !noteEditorOpen ? (
        <div className="flex gap-2">
          {apptAvailable && !apptOpen && (
            <div data-testid="knock-appointment" className="flex-1 min-w-0 flex">
              <button
                type="button"
                data-testid="appt-open"
                onClick={() => setApptOpen(true)}
                className={pairBtn}
              >
                Set appointment
              </button>
            </div>
          )}
          {!noteEditorOpen && (
            <button
              type="button"
              data-testid="note-add-chip"
              onClick={() => { setNoteOpen(true); requestAnimationFrame(() => noteInputRef.current?.focus()); }}
              className={pairBtn}
            >
              Add note
            </button>
          )}
        </div>
      ) : null}
      {apptAvailable && apptOpen && (
        <div data-testid="knock-appointment" className="mt-2">{appointmentEditor}</div>
      )}
      {noteEditorOpen && (
        <div className="relative mt-2">
          <textarea
            ref={noteInputRef}
            data-testid="knock-note-input"
            placeholder="Add a note…"
            value={note}
            onChange={handleNoteChange}
            onBlur={() => { commitNote(note); setNoteOpen(false); }}
            rows={2}
            /* 16px, not 15: iOS Safari auto-zooms the whole viewport when a
               rep focuses any sub-16px input (we correctly do NOT block zoom),
               yanking the door sheet around mid-note. 16px reads identically
               and kills the zoom. */
            className="w-full min-h-[60px] text-[16px] leading-snug bg-white/[0.05] border border-white/[0.08] rounded-xl pl-3.5 pr-16 py-2.5 text-white placeholder:text-white/25 resize-none focus:outline-none focus:border-primary/60"
          />
          {note.trim() && (
            <button
              type="button"
              data-testid="note-add-btn"
              // Fires before blur (pointerdown) so this never double-commits.
              onPointerDown={(e) => { e.preventDefault(); commitNote(note); }}
              className="absolute right-2 bottom-2 h-11 px-4 rounded-full bg-primary text-primary-foreground text-[12px] font-semibold tap-press"
            >
              Add
            </button>
          )}
        </div>
      )}
      {noteState !== "idle" && (
        <div
          data-testid="note-save-state"
          data-state={noteState}
          className="mt-1.5 text-2xs font-medium"
          style={{ color: noteState === "saved" ? "#34d399" : (noteState === "conflict" || noteState === "rejected") ? "#f59e0b" : MUTED }}
        >
          {noteState === "saving" ? "Saving…" : noteState === "queued" ? "Saved offline" : noteState === "conflict" ? "Not saved - newer note exists" : noteState === "rejected" ? "Not saved - tap Add to retry" : "Saved to history"}
        </div>
      )}
      {docked && postMarkRow}
    </div>
  );

  // The pinned latest note: this session's committed note, else the most
  // recent note from history, as a quote under the Last line.
  const latestNoteBlock = latestNote ? (
    <div className="mt-2 flex gap-2.5 items-start min-w-0">
      <span aria-hidden="true" className="shrink-0 mt-1 w-[3px] h-7 rounded-full bg-white/[0.18]" />
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: MUTED }}>Latest note</div>
        <div data-testid="note-latest" className="mt-0.5 text-[12.5px] leading-snug line-clamp-2" style={{ color: BODY_TEXT }}>
          “{latestNote}”
        </div>
      </div>
    </div>
  ) : null;

  // ── Facts the scanner already holds, read BEFORE the knock ─────────────────
  // Competitor and occupancy are the two that change the pitch at the door.
  // At most two chips, only when known; the full fact list stays in Details.
  const factsRow = (() => {
    const d = detailForLead;
    if (!d) return null;
    const chips: Array<{ key: string; text: string }> = [];
    const competitor = [d.competitorName, d.competitorTech].filter(Boolean).join(" · ");
    if (competitor) chips.push({ key: "competitor", text: competitor });
    if (d.billingStatus === "N") chips.push({ key: "occupancy", text: "No current subscriber" });
    if (!chips.length) return null;
    return (
      <div data-testid="knock-facts" className="flex flex-wrap items-center gap-1.5 pb-2">
        {chips.map(c => (
          <span
            key={c.key}
            data-testid={`knock-fact-${c.key}`}
            className="inline-flex items-center h-6 px-2 rounded-full border border-white/[0.12] bg-white/[0.05] text-[11px] font-semibold text-white/75 whitespace-nowrap"
          >
            {c.text}
          </span>
        ))}
      </div>
    );
  })();

  return (
    <div
      ref={sheetRef}
      data-testid="knock-sheet"
      data-snap={docked ? "docked" : snap}
      role="dialog"
      aria-label={renderedLead.address}
      tabIndex={-1}
      className={[
        // glass-sheet: the liquid-glass bottom-sheet surface (18px blur budget,
        // ink fill, specular top hairline, token shadow) — see index.css. Solid
        // enough to stay readable over the satellite basemap.
        // glass-ink-scope: the card is dark in BOTH app themes, so every semantic
        // token it reads (success chips, primary buttons, the history diagram)
        // must resolve to the dark palette even under the light default.
        "glass-sheet glass-ink-scope fixed z-40 flex flex-col will-change-transform",
        docked
          ? "inset-y-0 right-0 w-[380px] rounded-l-[24px] border-l border-white/10"
          // Layout's persistent sidebar begins at Tailwind's md breakpoint,
          // while the card does not dock until lg. Keep the tablet sheet inside
          // the map workspace instead of hiding its address/actions underneath
          // the 264px sidebar.
          : "inset-x-0 bottom-0 h-[min(85dvh,640px)] rounded-t-[24px] border-t border-white/10 md:left-[264px] md:right-0",
        // 200ms transform-only (GPU) — never transition-all, never >=300ms.
        dragging ? "" : "transition-transform duration-200",
        // Close is instant for the MAP: the moment `lead` clears, the exit
        // animation keeps running but the sheet stops eating pointer events,
        // so the pin/map underneath responds on the very next tap.
        closing ? "pointer-events-none" : "",
      ].join(" ")}
      style={{
        transform,
        // Velocity-matched settle (snapMsRef) for snaps; exits are shorter than
        // entrances and accelerate away unless the rep threw the sheet out.
        transitionDuration: dragging ? undefined : programmaticClose ? "160ms" : `${snapMsRef.current}ms`,
        transitionTimingFunction: dragging ? undefined : programmaticClose ? "cubic-bezier(0.4,0,1,1)" : "cubic-bezier(0.32,0.72,0,1)",
        ...(docked && dockOffsetPx ? { right: dockOffsetPx } : null),
      }}
    >
      {/* Drag handle — one tap cycles the levels (peek → quick → details →
          peek), the one-hand alternative to the drag (swallowDragClick
          suppresses this after a real drag). touchAction none so the browser
          never steals the gesture for page scroll. */}
      <div
        ref={handleRef}
        {...dragRegionProps}
        className={docked ? "shrink-0" : "cursor-grab select-none shrink-0"}
        style={{ touchAction: "none" }}
      >
        {!docked ? (
          <button
            type="button"
            aria-label={
              snap === "peek" ? "Open quick actions"
              : snap === "quick" ? "Open details"
              : "Collapse card"
            }
            aria-expanded={snap !== "peek"}
            data-testid="knock-sheet-handle"
            data-drag-handle
            className="flex justify-center pt-2 pb-1 cursor-pointer bg-transparent border-0 w-full"
            onClick={() => snapTo(snap === "peek" ? "quick" : snap === "quick" ? "details" : "peek")}
          >
            {/* white/40 clears the 3:1 non-text floor over the 0.86 ink sheet
                on both basemap extremes (white/25 measured ~2.2:1). */}
            <div className="w-10 h-[5px] rounded-full bg-white/40" />
          </button>
        ) : (
          <div className="pt-4" />
        )}
      </div>

      <div role="status" aria-live="polite" className="sr-only">{liveMessage}</div>
      {/* PEEK level — clipped to zero height (but kept laid out, so its height
          stays measurable) whenever another level is active; inert there so
          its buttons are never keyboard-reachable through the clip. Draggable. */}
      <div
        ref={peekWrapRef}
        {...dragRegionProps}
        className={[
          docked ? "" : "cursor-grab select-none",
          peekShown ? "shrink-0" : "h-0 overflow-hidden shrink-0",
        ].join(" ")}
        style={{ touchAction: "none" }}
      >
        <div key={renderedLead.id} ref={peekBarRef} className="card-swap-in">
          <PeekBar
            address={renderedLead.address}
            pinColor={STATUS_CONFIG[canonicalStatus].color}
            statusIcon={ICON_MAP[STATUS_CONFIG[canonicalStatus].cardIcon]}
            statusColor={statusColor}
            statusLabel={statusLabel}
            lastKnockedAt={renderedLead.lastKnockedAt}
            freshFiber={renderedLead.leadTag === "fresh_fiber_confirmed"}
            directionsHref={directionsHref}
            onClose={onClose}
            undo={undoChip("knock-undo")}
            // The docked panel never collapses: its row renders under the grid
            // instead, never in the (clipped) peek bar.
            followThrough={docked ? null : postMarkRow}
            pop={markedHere ? markedHere.outcome : null}
          />
        </div>
      </div>

      {/* QUICK + DETAILS content — translated off-screen (and inert) in Peek. */}
      {/* The column fades as the sheet collapses to peek (the header would
          otherwise hop ~60px at t=0 when the peek wrapper lays out); guarded
          on !dragging so a drag UP from peek never shows an empty sheet. */}
      <div
        ref={mainRef}
        className={[
          "flex-1 min-h-0 flex flex-col transition-opacity duration-150 ease-out",
          peekShown && !dragging ? "opacity-0" : "opacity-100",
        ].join(" ")}
      >
        {/* Compact header: the status pin chip + address + the copy / close
            discs, the locality sub-line (which reads "Address copied" for a
            beat after a copy), and the ONE status line (label · relative time
            · at most one badge) in the status color. Draggable. */}
        <div
          ref={headerRef}
          {...dragRegionProps}
          className={docked ? "shrink-0" : "cursor-grab select-none shrink-0"}
          style={{ touchAction: "none" }}
        >
          <div key={renderedLead.id} className="card-swap-in px-4 pb-3 pt-0.5">
            <div className="flex items-start gap-3">
              <div key={markedHere?.outcome ?? "idle"} className={`shrink-0 pt-[2px] ${markedHere ? "status-pop" : ""}`}>
                <StatusPinChip
                  color={STATUS_CONFIG[canonicalStatus].color}
                  icon={ICON_MAP[STATUS_CONFIG[canonicalStatus].cardIcon]}
                />
              </div>
              <div className="min-w-0 flex-1">
                {/* Selectable on purpose. The drag region turns selection off
                    so a drag never paints a blue smear across the sheet, but
                    long-press-to-select is how everyone copies an address on a
                    phone, and switching it off left the Copy disc as the only
                    way. A native selection cancels the pointer stream, so the
                    sheet's own drag ends itself rather than fighting it. */}
                <h2
                  data-testid="knock-address"
                  style={{ userSelect: "text", WebkitUserSelect: "text", WebkitTouchCallout: "default" }}
                  className="min-w-0 text-[20px] leading-[1.15] font-semibold tracking-[-0.01em] text-white truncate"
                >
                  {renderedLead.address}
                </h2>
                {(() => {
                  const d = detailQuery.data;
                  const city = renderedLead.city ?? d?.city;
                  const state = renderedLead.state ?? d?.state;
                  const zip5 = normalizeZip5(renderedLead.zip ?? d?.zip);
                  const complete = !!(city && state && zip5);
                  if (copiedAddr) {
                    return copiedAddr === "ok" ? (
                      <div data-testid="knock-address-copied" className="text-[12.5px] truncate mt-0.5 font-semibold text-success">
                        Address copied
                      </div>
                    ) : (
                      <div data-testid="knock-address-copy-failed" className="text-[12.5px] truncate mt-0.5 font-semibold text-warning">
                        Could not copy
                      </div>
                    );
                  }
                  return complete ? (
                    <div data-testid="knock-address-locality" className="text-[12.5px] truncate mt-0.5" style={{ color: MUTED }}>
                      {[city, [state, zip5].filter(Boolean).join(" ")].filter(Boolean).join(", ")}
                    </div>
                  ) : (
                    <div data-testid="knock-address-review" className="text-[12.5px] truncate mt-0.5 font-semibold text-warning">
                      Address needs review{city || state ? ` · ${[city, state].filter(Boolean).join(", ")}` : ""}
                    </div>
                  );
                })()}
                {/* Who to ask for. Only when a real name exists (resident-
                    given first, traced second) — the "Resident at …"
                    fallback would just repeat the address line above it. */}
                {doorName && doorName.trim().length >= 2 && (
                  <p className="mt-0.5 truncate text-[13px] font-medium text-white/70" data-testid="knock-owner-name">
                    Ask for {leadDisplayName(doorName, renderedLead.address)}
                  </p>
                )}
                <div data-testid="knock-status-line" className="text-[12.5px] font-semibold truncate mt-1 flex items-center gap-1.5" style={{ color: statusColor }}>
                  <span className="truncate">{statusLabel}{lastKnockRel ? ` · ${lastKnockRel}` : ""}</span>
                  {undoChip("knock-undo-header")}
                  {statusBadge && (
                    <span
                      data-testid="knock-status-badge"
                      className={`shrink-0 inline-flex items-center rounded-full border px-1.5 py-px text-2xs font-bold uppercase tracking-wide ${statusBadge.className}`}
                    >
                      {statusBadge.text}
                    </span>
                  )}
                </div>
                {fccReported && (
                  <span
                    data-testid="fcc-fiber-chip"
                    className="mt-1 inline-flex w-fit items-center rounded-full border border-warning/35 bg-warning/[0.08] px-2 py-px text-2xs font-bold uppercase tracking-wide text-warning"
                  >
                    FCC-reported fiber - verify at door
                  </span>
                )}
              </div>
              {/* Copy and Close: two real discs, 36px visible, 44px hit areas,
                  8px apart. Copy is the card's ONE copy control. */}
              <div className="flex items-center gap-2 shrink-0 -mr-1 -mt-0.5">
                <button
                  type="button"
                  data-testid="knock-copy-address"
                  aria-label={copiedAddr === "ok" ? "Address copied" : "Copy address"}
                  {...copyTap}
                  className={copiedAddr === "ok"
                    ? `${circleBtn} !bg-success/[0.16] !border-success/40 !text-success`
                    : circleBtn}
                >
                  {copiedAddr === "ok" ? <Check className="w-[17px] h-[17px]" /> : <Copy className="w-4 h-4" />}
                </button>
                <button
                  type="button"
                  data-testid="knock-sheet-close"
                  aria-label="Close"
                  {...closeTap}
                  className={circleBtn}
                >
                  <X className="w-[17px] h-[17px]" />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Body — scrolls in details/docked, clipped otherwise. NOT keyed on
            lead id: only the quick block below crossfades, so History never
            remounts (and never flashes) on a card swap. */}
        <div
          data-testid="knock-sheet-body"
          className={[
            "flex-1 min-h-0 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
            // Quick content can exceed 85dvh on a short/landscape phone. The
            // drag regions live above this body, so scrolling keeps every
            // outcome and note reachable without stealing the sheet gesture.
            !peekShown ? "overflow-y-auto overscroll-contain" : "overflow-hidden",
          ].join(" ")}
        >
          {/* Quick Actions — the default working level. Keyed on lead id so it
              crossfades (opacity only) when the card swaps to another door. Also
              the measured body of the quick level. */}
          <div key={renderedLead.id} ref={quickBodyRef} className="card-swap-in">
            {/* Do-not-knock: the resident asked us not to return. Rendered at
                the top of the body (inside the measured quick block, so the
                quick snap height includes it) and announced as an alert. */}
            {Boolean(renderedLead.doNotKnock) && (
              <div
                role="alert"
                data-testid="dnk-banner"
                className="mb-3 flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-[13px] font-semibold leading-snug text-destructive"
              >
                
                <span>Do not knock - resident asked us not to return</span>
              </div>
            )}
            <QuickBody
              directionsHref={directionsHref}
              phone={renderedLead.phone}
              activeOutcome={activeOutcome}
              flashKey={flashKey}
              onStatusTap={handleStatusTap}
              outcomesDisabled={Boolean(renderedLead.doNotKnock)}
              proximity={proximityChip}
              facts={factsRow}
              followThrough={followThrough}
              recent={recent}
              latestNote={latestNoteBlock}
            />
          </div>

          {/* Traced numbers live at the DETAILS level, not Quick Actions. At a
              door the rep is talking, not dialling — putting the phone list up
              top would push the outcome grid below the fold to serve the rarer
              need. DNC rows render inert here exactly as on the map card. */}
          {(contactPhones?.length ?? 0) > 0 && (
            <div hidden={!detailsShown} className="px-4 pb-1" data-testid="knock-contacts">
              <LeadContacts
                ownerName={contactOwnerName}
                address={renderedLead.address}
                phones={contactPhones}
              />
            </div>
          )}

          {/* DETAILS level — premise facts, assignment (capability-gated),
              admin actions (manager-gated), and the full History timeline with
              scan evidence. */}
          <DetailsBody
            hidden={!detailsShown}
            docked={docked}
            detail={detailQuery.data}
            contact={
              <ContactSection
                leadId={renderedLead.id}
                contactName={detailForLead?.contactName}
                contactEmail={detailForLead?.contactEmail}
                ready={detailSettled}
              />
            }
            quickLinks={
              <QuickLinks
                address={renderedLead.address}
                city={renderedLead.city ?? detailForLead?.city}
                state={renderedLead.state ?? detailForLead?.state}
                zip={renderedLead.zip ?? detailForLead?.zip}
                lat={renderedLead.lat}
                lng={renderedLead.lng}
              />
            }
            photos={<SheetPhotos leadId={renderedLead.id} />}
            canAssignLead={canAssignLead}
            assignedRepId={renderedLead.assignedRepId}
            team={teamQuery.data ?? []}
            onAssign={assignLead}
            assigning={assignLeadMutation.isPending}
            canOpenCalling={canOpenCalling}
            leadId={renderedLead.id}
            canManage={canManage}
            onCentralMark={onCentralMark}
            onDelete={onDelete}
            centralMode={centralMode}
            deleteArmed={deleteArmed}
            onToggleCentral={() => { setCentralMode(v => !v); setDeleteArmed(false); }}
            onDeleteTap={() => {
              if (!deleteArmed) { setDeleteArmed(true); armTimer(() => setDeleteArmed(false), 4000); return; }
              onDelete?.();
            }}
            history={history}
            historyLoading={historyQuery.isLoading}
          />
        </div>
      </div>
    </div>
  );
}

// Memoized: MapView re-renders every scan-poll tick / queue event — with a
// stable lead identity (leadById) and stable callbacks, none of that touches
// the card. Props are shallow-compared; `lead` identity only changes when the
// pin payload actually changes.
export const LeadKnockSheet = memo(LeadKnockSheetInner);
export default LeadKnockSheet;
