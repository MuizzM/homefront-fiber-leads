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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy, Check, Plus, X,
  DoorClosed, Star, DollarSign, Clock, ArrowDown, HelpCircle, Phone,
  type LucideIcon,
} from "lucide-react";
import { SHEET_PEEK_BASE_PX, setMeasuredPeekPx, setSheetDragActive } from "@/lib/mapPins";
import { mergeNotes, type NoteSaveResult } from "@/lib/leadNotes";
import { useCan } from "@/lib/capabilities";
import { apiRequest } from "@/lib/queryClient";
import {
  FIELD_OUTCOMES, OUTCOME_META, STATE_LABELS, pinDisplayState, isKnockOutcome,
  type KnockOutcome, type PinDisplayState,
} from "@shared/knock";
import { STATUS_CONFIG, toLeadMapStatus } from "@shared/statusConfig";
import { normalizeZip5 } from "@shared/addressKey";
import { PeekBar } from "@/components/lead-sheet/PeekBar";
import { QuickBody } from "@/components/lead-sheet/QuickBody";
import { DetailsBody } from "@/components/lead-sheet/DetailsBody";
import { relativeTime, prefersReducedMotion, shortRepName, MUTED, BODY_TEXT } from "@/components/lead-sheet/utils";
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
  // Opt-in: present only when the caller is authorized to dial this lead. The
  // Field Map pins payload carries NO phone for ordinary reps, so Call stays
  // hidden for them; the separate Calling workspace remains the gated path.
  phone?: string | null;
}

export interface LeadKnockSheetProps {
  lead: SheetLead | null;                 // null → animate out then unmount after 300ms
  onKnock: (outcome: KnockOutcome) => void;
  // Lead-level notes, persisted inline. Explicit leadId so a pending debounce
  // for the OUTGOING lead can flush during a card swap; returns the save
  // result so the card can render Saving/Saved and merge 409 conflicts.
  onSaveNote: (leadId: number, note: string, baseUpdatedAt: string | null) => Promise<NoteSaveResult>;
  onClose: () => void;                    // ✕ button / escape / overdrag (map tap closes upstream)
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
  onCentralMark?: (outcome: KnockOutcome) => void;
  onDelete?: () => void;
}

// lucide icon NAME (from OutcomeDef.icon) → component. Pins and card share one
// palette; this is the one place a name string becomes a rendered glyph.
const ICON_MAP: Record<string, LucideIcon> = {
  DoorClosed, Star, DollarSign, X, Clock, Phone, ArrowDown, HelpCircle,
};

// Tap-vs-drag threshold: header taps must still land.
const TAP_SLOP_PX = 6;
// Dragging further than this below the peek position dismisses the sheet.
const CLOSE_OVERDRAG_PX = 80;
// Flick faster than this decides snap direction regardless of position.
const FLICK_VELOCITY = 0.5; // px/ms

// ONE unified outcomes grid: every field disposition in a single 2-col grid,
// FIXED order (a button never moves under the finger) with the four most
// likely leading — Not Home | Interested / Sold | Not Interested — and the
// remaining outcomes (Follow-up, Prospect) following in the same grid. This is
// exactly FIELD_OUTCOMES, primary-four-first even if the shared list reorders.
const PRIMARY_GRID_KEYS: KnockOutcome[] = ["not_home", "interested", "sold", "not_interested"];
const GRID_OUTCOMES = [
  ...FIELD_OUTCOMES.filter(o => PRIMARY_GRID_KEYS.includes(o.key)),
  ...FIELD_OUTCOMES.filter(o => !PRIMARY_GRID_KEYS.includes(o.key)),
];

// The active outcome mirrors the lead's CURRENT display state.
const DS_TO_OUTCOME: Partial<Record<PinDisplayState, KnockOutcome>> = {
  unworked: "prospect", not_home: "not_home", interested: "interested",
  follow_up: "follow_up", callback: "callback", sold: "sold",
  not_interested: "not_interested",
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
  const [renderedLead, setRenderedLead] = useState<SheetLead | null>(lead);
  const closing = lead === null;
  useEffect(() => {
    if (lead) { setRenderedLead(lead); return; }
    const t = setTimeout(() => setRenderedLead(null), 300);
    return () => clearTimeout(t);
  }, [lead]);

  const docked = useDocked();
  const [snap, setSnap] = useState<SheetSnap>("quick"); // QUICK is the default open state
  const [note, setNote] = useState("");                // composer DRAFT — clears once committed
  const [noteOpen, setNoteOpen] = useState(false);     // collapsed "+ Add note" chip → textarea on focus
  const [noteState, setNoteState] = useState<"idle" | "saving" | "saved" | "queued" | "conflict">("idle");
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

  // ── Geometry: measure sheet + safe area + the two collapsed levels so snaps
  // are numeric AND the map camera padding tracks the real sheet lip ──────────
  const [sheetH, setSheetH] = useState(0);
  const [safeBottom, setSafeBottom] = useState(0);
  const [peekPx, setPeekPx] = useState<number | null>(null);   // handle + peek bar
  const [quickPx, setQuickPx] = useState<number | null>(null); // handle + header + quick body
  const lastPublished = useRef<{ snap: SheetSnap; px: number } | null>(null);
  const mounted = renderedLead != null;
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
  const teamQuery = useQuery<TeamMember[]>({
    queryKey: ["/api/team"],
    enabled: canAssignLead && !!lead,
    staleTime: 5 * 60_000,
  });
  const assignLead = (repId: number | null) => {
    const id = renderedLead?.id;
    if (!id) return;
    // Optimistic pin/card update, then the capability-gated endpoint.
    qc.setQueryData(["/api/leads/map"], (old: any) => {
      if (!old?.pins) return old;
      return { ...old, pins: old.pins.map((p: any) => (p.id === id ? { ...p, assignedRepId: repId } : p)) };
    });
    apiRequest("POST", `/api/leads/${id}/assign`, { repId })
      .then(() => {
        qc.invalidateQueries({ queryKey: [`/api/leads/${id}/history`] }); // assignment event
        qc.invalidateQueries({ queryKey: ["/api/leads"] });
      })
      .catch(() => { qc.invalidateQueries({ queryKey: ["/api/leads/map"] }); });
  };

  const historyQuery = useQuery<HistoryRow[]>({
    queryKey: [`/api/leads/${leadId}/history`],
    enabled: !!lead && leadId > 0,
    staleTime: 30_000, // knock saves + note commits invalidate this key
  });
  const history = historyQuery.data ?? [];

  // ── One-tap disposition ──────────────────────────────────────────────────────
  const tapGuard = useRef(0); // absorbs accidental double-fires of the same tap
  // Manager modes: CENTRAL routes the next status tap to the central-team
  // endpoint (no rep credit); DELETE arms a two-tap inline confirm.
  const [centralMode, setCentralMode] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  useEffect(() => { setCentralMode(false); setDeleteArmed(false); }, [lead?.id]);

  const handleStatusTap = (key: KnockOutcome) => {
    const now = Date.now();
    if (now - tapGuard.current < 350) return; // double-submit guard
    tapGuard.current = now;
    try { navigator.vibrate?.(key === "sold" ? [12, 40, 12] : 10); } catch { /* unsupported */ }
    // Brief filled + check flash confirms the tap even before the optimistic
    // lead data round-trips. No-op under reduced motion.
    if (!prefersReducedMotion()) {
      setFlashKey(key);
      window.setTimeout(() => setFlashKey(k => (k === key ? null : k)), 150);
    }
    if (centralMode && canManage && onCentralMark) {
      onCentralMark(key); // central-team mark: no rep credit, no commission
      // AUDIT FIX: disarm after one mark — the hint says "next status tap",
      // and an armed manager silently stripped rep credit on later doors.
      setCentralMode(false);
    } else {
      onKnock(key); // optimistic upstream: dot, status line, active outcome, and pin recolor together
    }
    // Marking is the moment of commitment: confirm, then collapse to Peek so the
    // map (and the freshly recolored pin) is back in view immediately.
    if (!docked) setSnap("peek");
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
      if (r.status === "rejected") { setNoteState("conflict"); return; }
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
    if (noteState === "saved") setNoteState("idle"); // fresh draft — stale "Saved" off
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
      return { label, who: h0.actor ? shortRepName(h0.actor) : null, time: relativeTime(h0.changedAt) };
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
  const statusBadge: { text: string; className: string } | null = needsReview
    ? { text: "Needs review", className: "border-amber-400/35 bg-amber-400/10 text-amber-300" }
    : freshFiber
      ? { text: "Fresh fiber", className: "border-emerald-400/35 bg-emerald-400/10 text-emerald-300" }
      : null;

  const transform = docked
    ? (closing ? "translateX(110%)" : "translateX(0)")
    : closing
      ? "translateY(100%)"
      : dragging
        ? `translateY(${dragYRef.current}px)`
        : snap === "details"
          ? "translateY(0px)"
          : snap === "quick"
            ? `translateY(${quickY}px)`
            : `translateY(${peekY}px)`;

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
            style={{ color: noteState === "saved" ? "#34d399" : noteState === "conflict" ? "#f59e0b" : MUTED }}>
            {noteState === "saving" ? "Saving…" : noteState === "queued" ? "Saved offline" : noteState === "conflict" ? "Not saved — newer note exists" : "Saved to history"}
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
          <Plus className="w-4 h-4" /> Add note
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
            className="w-full min-h-[60px] text-[15px] leading-snug bg-white/[0.05] border border-white/[0.08] rounded-xl pl-3.5 pr-16 py-2.5 text-white placeholder:text-white/25 resize-none focus:outline-none focus:border-primary/60"
          />
          {note.trim() && (
            <button
              type="button"
              data-testid="note-add-btn"
              // Fires before blur (pointerdown) so this never double-commits.
              onPointerDown={(e) => { e.preventDefault(); commitNote(note); }}
              className="absolute right-2 bottom-2 h-11 px-4 rounded-full bg-primary text-white text-[12px] font-semibold active:scale-95 transition"
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
      className={[
        // glass-sheet: the liquid-glass bottom-sheet surface (18px blur budget,
        // ink fill, specular top hairline, token shadow) — see index.css. Solid
        // enough to stay readable over the satellite basemap.
        "glass-sheet fixed z-40 flex flex-col will-change-transform",
        docked
          ? "inset-y-0 right-0 w-[380px] rounded-l-[24px] border-l border-white/10"
          : "inset-x-0 bottom-0 h-[min(85dvh,640px)] rounded-t-[24px] border-t border-white/10",
        dragging ? "" : "transition-transform duration-300",
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
        {/* Compact header: status dot + address (with copy glyph) + ✕ close, the
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
                  <h2 className="min-w-0 flex-1 text-[19px] leading-[1.15] font-semibold text-white truncate">
                    {renderedLead.address}
                  </h2>
                  <button
                    type="button"
                    data-testid="knock-copy-address"
                    aria-label="Copy address"
                    onClick={copyAddress}
                    className="relative shrink-0 mt-[2px] h-7 w-7 flex items-center justify-center rounded-md text-white/45 hover:text-white active:scale-90 transition after:absolute after:-inset-2"
                  >
                    {copiedAddr ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-[15px] h-[15px]" />}
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
                    <div data-testid="knock-address-review" className="text-[12px] truncate mt-0.5 font-semibold text-amber-400">
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
          className={[
            "flex-1 min-h-0 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
            detailsShown ? "overflow-y-auto overscroll-contain" : "overflow-hidden",
          ].join(" ")}
        >
          {/* Quick Actions — the default working level. Keyed on lead id so it
              crossfades (opacity only) when the card swaps to another door. Also
              the measured body of the quick level. */}
          <div key={renderedLead.id} ref={quickBodyRef} className="card-swap-in">
            <QuickBody
              directionsHref={directionsHref}
              phone={renderedLead.phone}
              copiedAddr={copiedAddr}
              onCopyAddress={copyAddress}
              outcomes={GRID_OUTCOMES}
              iconMap={ICON_MAP}
              activeOutcome={activeOutcome}
              flashKey={flashKey}
              onStatusTap={handleStatusTap}
              recent={recent}
              notes={notesCard}
            />
          </div>

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
