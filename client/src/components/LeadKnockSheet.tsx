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

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy, Check, X, DoorClosed, Star, DollarSign, Clock, ArrowDown, HelpCircle, Phone, UserCheck,
  Flag, KeyRound, Truck, Ban, RotateCcw, CalendarPlus, LocateFixed, type LucideIcon,
} from "lucide-react";
import { SHEET_PEEK_BASE_PX, setMeasuredPeekPx, setSheetDragActive } from "@/lib/mapPins";
import { mergeNotes, type NoteSaveResult } from "@/lib/leadNotes";
import { useCan } from "@/lib/capabilities";
import { apiRequest } from "@/lib/queryClient";
import { captureFieldFix } from "@/lib/geoFix";
import {
  FIELD_OUTCOMES, OUTCOME_META, STATE_LABELS, pinDisplayState, isKnockOutcome,
  haversineMeters, distanceHint, todayISO,
  type KnockOutcome, type PinDisplayState,
} from "@shared/knock";
import { STATUS_CONFIG, toLeadMapStatus } from "@shared/statusConfig";
import { normalizeZip5 } from "@shared/addressKey";
import { LeadContacts } from "@/components/LeadContacts";
import { leadDisplayName, type TracedPhone } from "@shared/tracerfy";
import { PeekBar } from "@/components/lead-sheet/PeekBar";
import { QuickBody } from "@/components/lead-sheet/QuickBody";
import { DetailsBody } from "@/components/lead-sheet/DetailsBody";
import { relativeTime, prefersReducedMotion, shortRepName, MUTED, BODY_TEXT } from "@/components/lead-sheet/utils";
import { isFccReportedLead } from "@/lib/leadSourceFilter";
import { useToast } from "@/hooks/use-toast";
import type { HistoryRow, LeadDetail, TeamMember } from "@/components/lead-sheet/types";

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
}

// lucide icon NAME (from OutcomeDef.icon) → component. Pins and card share one
// palette; this is the one place a name string becomes a rendered glyph.
const ICON_MAP: Record<string, LucideIcon> = {
  DoorClosed, Star, DollarSign, X, Clock, Phone, ArrowDown, HelpCircle, UserCheck,
  Flag, KeyRound, Truck, Ban, RotateCcw,
};

// Tap-vs-drag threshold: header taps must still land.
const TAP_SLOP_PX = 6;
// Dragging further than this below the peek position dismisses the sheet.
const CLOSE_OVERDRAG_PX = 80;
// Flick faster than this decides snap direction regardless of position.
const FLICK_VELOCITY = 0.5; // px/ms

// ONE unified disposition surface, two tiers, FIXED order (a control never
// moves under the finger): the four most likely reads — Not Home | Interested /
// Sold | Not Interested — keep the big 2-col grid cells, and EVERY other field
// disposition renders as a compact status-coded disc in the strip beneath
// (FU · GB · ACTV · COMP · RENT · MOV · NOSO · LEAD). Both tiers are exactly
// FIELD_OUTCOMES split by PRIMARY_GRID_KEYS, so a disposition added to the
// shared list appears here without a sheet change.
const PRIMARY_GRID_KEYS: KnockOutcome[] = ["not_home", "interested", "sold", "not_interested"];
const PRIMARY_OUTCOMES = FIELD_OUTCOMES.filter(o => PRIMARY_GRID_KEYS.includes(o.key));
const STRIP_OUTCOMES = FIELD_OUTCOMES.filter(o => !PRIMARY_GRID_KEYS.includes(o.key));

// The active outcome mirrors the lead's CURRENT display state.
const DS_TO_OUTCOME: Partial<Record<PinDisplayState, KnockOutcome>> = {
  unworked: "prospect", not_home: "not_home", interested: "interested",
  follow_up: "follow_up", callback: "callback", sold: "sold",
  not_interested: "not_interested", already_customer: "already_customer",
  competitor: "competitor", renter: "renter", moving: "moving",
  no_soliciting: "no_soliciting", go_back: "go_back",
};

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
  const { canManage = false, onCentralMark, onDelete } = props;
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
  const [note, setNote] = useState("");                // composer DRAFT — clears once committed
  const [noteOpen, setNoteOpen] = useState(false);     // collapsed "+ Add note" chip → textarea on focus
  const [noteState, setNoteState] = useState<"idle" | "saving" | "saved" | "queued" | "conflict" | "rejected">("idle");
  const [lastCommittedNote, setLastCommittedNote] = useState<string | null>(null); // pinned "latest note"
  const [flashKey, setFlashKey] = useState<KnockOutcome | null>(null); // brief tap-confirm flash
  const [copiedAddr, setCopiedAddr] = useState(false);                 // copy-glyph → check feedback
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
  // Never leave the pulse loop paused if the sheet unmounts mid-drag.
  useEffect(() => () => setSheetDragActive(false), []);

  const currentOffset = () => {
    if (closing) return sheetH;
    if (dragging) return dragYRef.current;
    return snap === "details" ? 0 : snap === "quick" ? quickY : peekY;
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (closing || docked) return; // docked panel: nothing to drag
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
    if (!d.moved) {
      d.moved = true;
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
    if (!d.moved) return; // tap — let the click reach its target
    setDragging(false); // ONE render: restores the transition class + snap transform
    setSheetDragActive(false);
    if (cancelled) return; // spring back to the current snap
    const y = Math.max(0, d.startOffset + (d.lastY - d.startClientY));
    // Swipe down past the peek lip dismisses the sheet.
    if (y > peekY + CLOSE_OVERDRAG_PX) { onClose(); return; }
    const ORDER: SheetSnap[] = ["details", "quick", "peek"];
    const OFFSETS = [0, quickY, peekY];
    if (Math.abs(d.vy) > FLICK_VELOCITY) {
      const idx = ORDER.indexOf(snap);
      // Flick up = open one level, flick down = collapse one level.
      setSnap(d.vy < 0 ? ORDER[Math.max(0, idx - 1)] : ORDER[Math.min(ORDER.length - 1, idx + 1)]);
    } else {
      // Settle on the nearest of the three snap points.
      let best = 0;
      for (let i = 1; i < OFFSETS.length; i++) {
        if (Math.abs(y - OFFSETS[i]) < Math.abs(y - OFFSETS[best])) best = i;
      }
      setSnap(ORDER[best]);
    }
  };

  // A real drag must not fire the click of whatever the pointer landed on.
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
    onClickCapture: swallowDragClick,
  } as const;

  // ── Per-lead reset ───────────────────────────────────────────────────────────
  const prevLeadId = useRef<number | null>(null);
  useEffect(() => {
    const id = renderedLead?.id ?? null;
    if (id === prevLeadId.current) return;
    // Per-lead isolation: an uncommitted draft belongs to the OUTGOING lead —
    // a card swap is an implicit blur, so commit it before this card rebinds.
    const live = liveNoteRef.current;
    if (live && live.value.trim()) {
      void onSaveNote(live.leadId, live.value.trim(), noteBaseRef.current);
    }
    prevLeadId.current = id;
    if (id == null) return;
    setSnap("quick"); // default open state for a newly selected lead
    setNote("");
    setNoteOpen(false);
    setNoteState("idle");
    setLastCommittedNote(null);
    setFlashKey(null);
    setCopiedAddr(false);
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
  useEffect(() => {
    mainRef.current?.toggleAttribute("inert", peekShown);
    if (peekShown) mainRef.current?.setAttribute("aria-hidden", "true");
    else mainRef.current?.removeAttribute("aria-hidden");
  }, [peekShown]);

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

  const handleStatusTap = async (key: KnockOutcome, opts?: KnockScheduleOpts): Promise<boolean> => {
    const now = Date.now();
    if (now - tapGuard.current < 350) return false; // double-submit guard
    tapGuard.current = now;
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
    try { navigator.vibrate?.(key === "sold" ? [12, 40, 12] : 10); } catch { /* unsupported */ }
    // Brief filled + check flash confirms only an accepted command. A rejected
    // manager/rep action stays open so the user can correct assignment/session.
    if (!prefersReducedMotion()) {
      setFlashKey(key);
      window.setTimeout(() => setFlashKey(k => (k === key ? null : k)), 150);
    }
    // Marking is the moment of commitment: confirm, then collapse to Peek so the
    // map (and the freshly recolored pin) is back in view immediately.
    if (!docked) setSnap("peek");
    return true;
  };

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

  const handleNoteChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setNote(v);
    if (noteState === "saved" || noteState === "rejected") setNoteState("idle"); // fresh draft — stale chip off
    const id = renderedLead?.id;
    liveNoteRef.current = id && v.trim() ? { leadId: id, value: v } : null;
  };

  if (!renderedLead) return null;

  // ── Derived display values ───────────────────────────────────────────────────
  const ds = pinDisplayState(renderedLead);
  const canonicalStatus = toLeadMapStatus(ds);
  const activeOutcome = DS_TO_OUTCOME[ds] ?? null;
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
  const copyAddress = () => {
    try { navigator.clipboard?.writeText(fullAddress); } catch { /* clipboard blocked */ }
    setCopiedAddr(true);
    window.setTimeout(() => setCopiedAddr(false), 1200);
  };

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
  const statusBadge: { text: string; className: string } | null = needsReview
    ? { text: "Needs review", className: "border-warning/35 bg-warning/[0.08] text-warning" }
    : freshFiber
      ? { text: "Fresh fiber", className: "border-success/35 bg-success/[0.08] text-success" }
      : null;

  const offscreen = closing || !entered;
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
        aria-label={`${atDoor ? "You are at this door" : `${distanceHint(d)} from this door`} — tap to refresh`}
        title="Distance from your location"
        className={[
          "relative ml-auto h-10 flex items-center gap-1.5 px-3 rounded-full border text-[12px] font-semibold whitespace-nowrap active:scale-95 transition after:absolute after:-inset-1",
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
  // Collapsed chip → date/time editor. Confirming logs ONE knock (Go Back keeps
  // its pink pin — it already persists as follow_up; everything else becomes a
  // Follow-up) with the schedule attached, through the exact offline-queue path
  // a plain status tap uses. Hidden entirely on do-not-knock doors: an
  // appointment IS a knock.
  const apptOutcome: KnockOutcome = activeOutcome === "go_back" ? "go_back" : "follow_up";
  const commitAppointment = async () => {
    if (!apptDate) return;
    const ok = await handleStatusTap(apptOutcome, { callbackDate: apptDate, callbackTime: apptTime || null });
    if (ok) { setApptOpen(false); setApptDate(""); setApptTime(""); }
  };
  const apptInput =
    "h-11 rounded-xl bg-white/[0.05] border border-white/[0.08] px-3 text-[16px] text-white focus:outline-none focus:border-primary/60";
  const appointmentCard = Boolean(renderedLead.doNotKnock) ? null : (
    <div className="mt-3" data-testid="knock-appointment">
      {!apptOpen ? (
        <button
          type="button"
          data-testid="appt-open"
          onClick={() => setApptOpen(true)}
          className="h-11 inline-flex items-center gap-1.5 pl-3 pr-4 rounded-full bg-white/[0.05] border border-white/[0.08] text-[13px] font-semibold text-white/85 active:scale-95 transition"
        >
          <CalendarPlus aria-hidden="true" className="w-4 h-4 text-white/60" />
          Set appointment
        </button>
      ) : (
        <div data-testid="appt-editor" className="rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: MUTED }}>
              Appointment
            </span>
            <button
              type="button"
              data-testid="appt-cancel"
              onClick={() => setApptOpen(false)}
              className="text-[12px] font-semibold text-white/50 hover:text-white/80 transition px-1 -mr-1"
            >
              Cancel
            </button>
          </div>
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
              className="ml-auto h-11 px-4 rounded-xl bg-primary text-primary-foreground text-[13px] font-semibold active:scale-95 transition disabled:opacity-45 disabled:cursor-not-allowed"
            >
              Set
            </button>
          </div>
          <p className="mt-2 text-[11.5px] leading-snug" style={{ color: MUTED }}>
            Saves a {OUTCOME_META[apptOutcome].label} with this date — it lands on your Follow-ups.
          </p>
        </div>
      )}
    </div>
  );

  // Notes — a FLAT section on the one card surface (no nested card): a slim
  // "+ Add note" chip by default; it expands to the textarea on focus. The
  // commit model is unchanged (Add / blur / card swap = one write, one history
  // event); the just-committed note is pinned as "latest note".
  const notesCard = (
    <div className="mt-3 pt-3 border-t border-white/[0.06]">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: MUTED }}>
          Notes
        </span>
        {noteState !== "idle" && (
          <span data-testid="note-save-state" data-state={noteState} className="text-2xs font-medium"
            style={{ color: noteState === "saved" ? "#34d399" : (noteState === "conflict" || noteState === "rejected") ? "#f59e0b" : MUTED }}>
            {noteState === "saving" ? "Saving…" : noteState === "queued" ? "Saved offline" : noteState === "conflict" ? "Not saved - newer note exists" : noteState === "rejected" ? "Not saved - tap Add to retry" : "Saved to history"}
          </span>
        )}
      </div>
      {latestNote && (
        <div data-testid="note-latest" className="text-[12.5px] leading-snug mb-2 line-clamp-2" style={{ color: BODY_TEXT }}>
          “{latestNote}”
        </div>
      )}
      {!noteOpen && !note.trim() ? (
        <button
          type="button"
          data-testid="note-add-chip"
          onClick={() => { setNoteOpen(true); requestAnimationFrame(() => noteInputRef.current?.focus()); }}
          className="h-11 inline-flex items-center gap-1.5 pl-3 pr-4 rounded-full bg-white/[0.05] border border-white/[0.08] text-[13px] font-semibold text-white/85 active:scale-95 transition"
        >
           Add note
        </button>
      ) : (
        <div className="relative">
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
              className="absolute right-2 bottom-2 h-11 px-4 rounded-full bg-primary text-primary-foreground text-[12px] font-semibold active:scale-95 transition"
            >
              Add
            </button>
          )}
        </div>
      )}
    </div>
  );

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
        "glass-sheet fixed z-40 flex flex-col will-change-transform",
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
        transitionTimingFunction: dragging ? undefined : "cubic-bezier(0.32,0.72,0,1)",
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
            className="flex justify-center pt-2 pb-1 cursor-pointer bg-transparent border-0 w-full"
            onClick={() => setSnap(s => (s === "peek" ? "quick" : s === "quick" ? "details" : "peek"))}
          >
            {/* white/40 clears the 3:1 non-text floor over the 0.86 ink sheet
                on both basemap extremes (white/25 measured ~2.2:1). */}
            <div className="w-10 h-[5px] rounded-full bg-white/40" />
          </button>
        ) : (
          <div className="pt-4" />
        )}
      </div>

      {/* PEEK level — clipped to zero height (but kept laid out, so its height
          stays measurable) whenever another level is active. Draggable. */}
      <div
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
            statusColor={statusColor}
            statusLabel={statusLabel}
            lastKnockedAt={renderedLead.lastKnockedAt}
            freshFiber={renderedLead.leadTag === "fresh_fiber_confirmed"}
            directionsHref={directionsHref}
            onClose={onClose}
          />
        </div>
      </div>

      {/* QUICK + DETAILS content — translated off-screen (and inert) in Peek. */}
      <div ref={mainRef} className="flex-1 min-h-0 flex flex-col">
        {/* Compact header: status dot + address (with copy glyph) + close button, the
            locality sub-line, and the ONE status line (label · relative time) in
            the status color. Draggable. */}
        <div
          ref={headerRef}
          {...dragRegionProps}
          className={docked ? "shrink-0" : "cursor-grab select-none shrink-0"}
          style={{ touchAction: "none" }}
        >
          <div className="px-4 pb-3 pt-0.5">
            <div className="flex items-start gap-2.5">
              <span
                data-testid="knock-status-dot"
                aria-hidden
                className="w-2.5 h-2.5 rounded-full shrink-0 mt-[9px]"
                style={{ background: statusColor }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-start gap-1 min-w-0">
                  <div className="min-w-0 flex-1">
                    <h2 className="min-w-0 text-[19px] leading-[1.15] font-semibold text-white truncate">
                      {renderedLead.address}
                    </h2>
                    {/* Who to ask for. Only when the trace actually returned a
                        name — the "Resident at …" fallback would just repeat
                        the address line above it. */}
                    {contactOwnerName && contactOwnerName.trim().length >= 2 && (
                      <p className="mt-0.5 truncate text-[13px] font-medium text-white/70" data-testid="knock-owner-name">
                        Ask for {leadDisplayName(contactOwnerName, renderedLead.address)}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    data-testid="knock-copy-address"
                    aria-label="Copy address"
                    onClick={copyAddress}
                    className="relative shrink-0 mt-[2px] h-7 w-7 flex items-center justify-center rounded-md text-white/45 hover:text-white active:scale-90 transition after:absolute after:-inset-2"
                  >
                    {copiedAddr ? <Check className="w-4 h-4 text-success" /> : <Copy className="w-[15px] h-[15px]" />}
                  </button>
                </div>
                {(() => {
                  const d = detailQuery.data;
                  const city = renderedLead.city ?? d?.city;
                  const state = renderedLead.state ?? d?.state;
                  const zip5 = normalizeZip5(renderedLead.zip ?? d?.zip);
                  const complete = !!(city && state && zip5);
                  return complete ? (
                    <div data-testid="knock-address-locality" className="text-[12px] truncate mt-0.5" style={{ color: MUTED }}>
                      {[city, [state, zip5].filter(Boolean).join(" ")].filter(Boolean).join(", ")}
                    </div>
                  ) : (
                    <div data-testid="knock-address-review" className="text-[12px] truncate mt-0.5 font-semibold text-warning">
                      Address needs review{city || state ? ` · ${[city, state].filter(Boolean).join(", ")}` : ""}
                    </div>
                  );
                })()}
                <div data-testid="knock-status-line" className="text-[12.5px] font-semibold truncate mt-1 flex items-center gap-1.5" style={{ color: statusColor }}>
                  {(() => {
                    // Same glyph the pin carries, so the card and the map agree at
                    // a glance: $ for sold, star for interested, door for not home.
                    const StatusIcon = ICON_MAP[STATUS_CONFIG[canonicalStatus].cardIcon];
                    return StatusIcon ? <StatusIcon data-testid="knock-status-icon" className="w-[14px] h-[14px] shrink-0" /> : null;
                  })()}
                  <span className="truncate">{statusLabel}{lastKnockRel ? ` · ${lastKnockRel}` : ""}</span>
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
              <button
                type="button"
                data-testid="knock-sheet-close"
                aria-label="Close"
                onClick={onClose}
                className="relative shrink-0 -mr-1 -mt-0.5 h-8 w-8 flex items-center justify-center rounded-full text-white/50 hover:text-white hover:bg-white/10 active:scale-90 transition after:absolute after:-inset-2"
              >
                <X className="w-[18px] h-[18px]" />
              </button>
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
              copiedAddr={copiedAddr}
              onCopyAddress={copyAddress}
              primaryOutcomes={PRIMARY_OUTCOMES}
              stripOutcomes={STRIP_OUTCOMES}
              iconMap={ICON_MAP}
              activeOutcome={activeOutcome}
              flashKey={flashKey}
              onStatusTap={handleStatusTap}
              outcomesDisabled={Boolean(renderedLead.doNotKnock)}
              proximity={proximityChip}
              appointment={appointmentCard}
              recent={recent}
              notes={notesCard}
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
              if (!deleteArmed) { setDeleteArmed(true); window.setTimeout(() => setDeleteArmed(false), 4000); return; }
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
