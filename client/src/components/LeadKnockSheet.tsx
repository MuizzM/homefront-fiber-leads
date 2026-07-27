// ── Lead card (bottom sheet) ──────────────────────────────────────────────────
// Mobile-first card for the rep door-knocking flow. Deliberately NOT vaul/radix:
// no portal, no backdrop, no body scroll-lock — the map above must stay 100%
// interactive while the card is open. Snapping is pure transform (translateY)
// so the map never reflows, and dragging is confined to the handle/header
// region so the status grid and body scroll are never hijacked.
//
// v3 layout (Mobbin-grounded): status-dot header (address hero + copy + close)
// → status line (label · relative time, in the status color) → compact action
// pills (Directions / optional link to the separate Calling workspace / Copy) →
// a FLEX-WRAP grid of all 7 status pills, no
// horizontal scroll, fixed order so a pill never moves under the finger →
// recent-activity line → collapsible Notes composer → History timeline.
// Tapping a status saves immediately (one tap, no confirm); the dot, status
// line, active pill, and map pin all update from the same optimistic lead data.

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Navigation, Phone, Copy, Check, Plus, X,
  DoorClosed, Star, DollarSign, Clock, ArrowDown, HelpCircle,
  type LucideIcon,
} from "lucide-react";
import { SHEET_PEEK_BASE_PX, setMeasuredPeekPx, setSheetDragActive } from "@/lib/mapPins";
import { mergeNotes, type NoteSaveResult } from "@/lib/leadNotes";
import { useCan } from "@/lib/capabilities";
import { apiRequest } from "@/lib/queryClient";
import { VerificationBadge, formatDistance, type VStatus } from "@/components/verification";
import {
  FIELD_OUTCOMES, OUTCOME_META, STATE_LABELS, pinDisplayState, isKnockOutcome,
  type KnockOutcome, type PinDisplayState,
} from "@shared/knock";
import { STATUS_CONFIG, toLeadMapStatus } from "@shared/statusConfig";
import { normalizeZip5 } from "@shared/addressKey";

export type SheetSnap = "peek" | "expanded";

export interface SheetLead {
  id: number; lat?: number | null; lng?: number | null;
  address: string; city?: string | null; state?: string | null; zip?: string | null;
  leadStatus: string;
  assignedRepId?: number | null;  // shown/edited only for lead.assign holders
  visited?: boolean; lastOutcome?: string | null; lastKnockedAt?: string | null;
  leadTag?: string | null; freshConfidence?: string | null;
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
  // Published MEASURED peek height (drag header + peek body) so MapView's camera
  // bottom-padding tracks the real content instead of a hardcoded constant.
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

// Muted secondary text per the card spec.
const MUTED = "#8A94A6";
// Slightly brighter than MUTED for note/preview body copy.
const BODY_TEXT = "#B9C2D0";

// Field actions are fixed and shared across every disposition surface.
// Order is stable per spec — pills never reshuffle under the finger.
const GRID_OUTCOMES = FIELD_OUTCOMES;

// The active pill mirrors the lead's CURRENT display state.
const DS_TO_OUTCOME: Partial<Record<PinDisplayState, KnockOutcome>> = {
  unworked: "prospect", not_home: "not_home", interested: "interested",
  follow_up: "follow_up", callback: "callback", sold: "sold",
  not_interested: "not_interested",
};

// "5m ago" / "2h ago" / "3d ago" / "Jul 8" — one compact relative-time helper
// for the header status line, recent-activity line, and History rows.
function relativeTime(iso?: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch { return false; }
}

// "Muizz Muhammad" → "M. Muhammad" (single names pass through).
function shortRepName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name.trim();
  return `${parts[0][0]}. ${parts.slice(1).join(" ")}`;
}

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

interface HistoryRow {
  id: string;
  type: "status_change" | "assignment" | "note";
  actor: string | null;
  changedAt: string;
  status?: string;
  assignedTo?: string;
  assignedBy?: string;
  notePreview?: string;
  // Location verification (status_change rows only) — distance WHEN MARKED.
  verification?: VStatus;
  distanceM?: number | null;
  gpsAccuracyM?: number | null;
  reviewReason?: string | null;
}
interface LeadDetail {
  id: number;
  notes?: string | null;
  updatedAt?: string | null;
  // Verified-premise facts (GET /api/leads/:id returns the full lead; the
  // sheet previously discarded everything but notes). All optional — older
  // records may lack them, and the card renders honest fallbacks.
  city?: string | null; state?: string | null; zip?: string | null;
  fiberStatus?: string | null; householdSegmentType?: string | null;
  billingStatus?: string | null;
  competitorName?: string | null; competitorTech?: string | null;
  freshConfirmedAt?: string | null; leadTag?: string | null;
  leadStatus?: string | null;
}

// Verified-premise facts under the header: what the scanner actually proved
// at this address. Rendered only when a fact exists — no guessed fields; the
// review banner covers the incomplete case.
function VerifiedPremiseFacts({ detail }: { detail: LeadDetail | undefined }): JSX.Element | null {
  if (!detail) return null;
  const facts: Array<[string, string]> = [];
  if (detail.householdSegmentType) facts.push(["Segment", detail.householdSegmentType]);
  if (detail.billingStatus) {
    facts.push(["Occupancy", detail.billingStatus === "N" ? "No current subscriber" : `Billing ${detail.billingStatus}`]);
  }
  if (detail.competitorName || detail.competitorTech) {
    facts.push(["Competitor", [detail.competitorName, detail.competitorTech].filter(Boolean).join(" · ")]);
  }
  if (detail.freshConfirmedAt) {
    facts.push(["Verified", relativeTime(detail.freshConfirmedAt) || detail.freshConfirmedAt]);
  }
  if (!facts.length) return null;
  return (
    <div data-testid="knock-premise-facts" className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
      {facts.map(([label, value]) => (
        <span key={label} className="text-[11px] leading-tight" style={{ color: "rgba(255,255,255,0.55)" }}>
          <span className="uppercase tracking-wide text-[9.5px] mr-1" style={{ color: "rgba(255,255,255,0.35)" }}>{label}</span>
          {value}
        </span>
      ))}
    </div>
  );
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
  const [snap, setSnap] = useState<SheetSnap>("peek");
  const [note, setNote] = useState("");                // composer DRAFT — clears once committed
  const [noteOpen, setNoteOpen] = useState(false);     // collapsed "+ Add note" chip → textarea on focus
  const [noteState, setNoteState] = useState<"idle" | "saving" | "saved" | "queued">("idle");
  const [lastCommittedNote, setLastCommittedNote] = useState<string | null>(null); // pinned "latest note"
  const [flashKey, setFlashKey] = useState<KnockOutcome | null>(null); // brief tap-confirm flash
  const [copiedAddr, setCopiedAddr] = useState(false);                 // copy-glyph → check feedback
  const noteBaseRef = useRef<string | null>(null);     // lead.updatedAt we loaded — conflict base
  const liveNoteRef = useRef<{ leadId: number; value: string } | null>(null); // for outgoing-lead flush
  const committingRef = useRef(false);                 // one in-flight commit at a time
  const noteInputRef = useRef<HTMLTextAreaElement>(null);

  const sheetRef = useRef<HTMLDivElement>(null);
  const dragRegionRef = useRef<HTMLDivElement>(null);  // handle + header (measured for peek height)
  const peekBodyRef = useRef<HTMLDivElement>(null);    // above-the-fold body (measured for peek height)

  // ── Geometry: measure sheet + safe area + peek content so snaps are numeric
  // AND the map camera padding tracks the real peek height (never a constant) ──
  const [sheetH, setSheetH] = useState(0);
  const [safeBottom, setSafeBottom] = useState(0);
  const [peekContentPx, setPeekContentPx] = useState<number | null>(null);
  const lastPublishedPeek = useRef<number | null>(null);
  const mounted = renderedLead != null;
  useLayoutEffect(() => {
    if (!mounted) {
      setMeasuredPeekPx(null);          // no sheet → camera padding falls back
      lastPublishedPeek.current = null;
      return;
    }
    lastPublishedPeek.current = null;   // new lead/layout → force a fresh publish
    // Peek height = drag header + the above-the-fold body block. offsetHeight is
    // a pure layout read (transform- and scroll-independent), so this stays
    // correct in every snap/drag state.
    const publish = () => {
      const dr = dragRegionRef.current, pb = peekBodyRef.current;
      if (!dr || !pb) return;
      const px = Math.round(dr.offsetHeight + pb.offsetHeight);
      if (px <= 0) return;
      if (lastPublishedPeek.current != null && Math.abs(lastPublishedPeek.current - px) < 2) return;
      lastPublishedPeek.current = px;
      setPeekContentPx(px);
      setMeasuredPeekPx(px);            // → sheetPeekPaddingPx() (mapPins)
      onPeekHeight?.(px);              // → MapView re-pads the camera
    };
    const measure = () => {
      if (sheetRef.current) setSheetH(sheetRef.current.offsetHeight);
      setSafeBottom(readSafeAreaBottom());
      publish();
    };
    measure();
    let ro: ResizeObserver | null = null;
    try {
      ro = new ResizeObserver(publish);        // catches note expand / pill wrap
      if (dragRegionRef.current) ro.observe(dragRegionRef.current);
      if (peekBodyRef.current) ro.observe(peekBodyRef.current);
    } catch { /* jsdom: no ResizeObserver */ }
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("resize", measure);
      try { ro?.disconnect(); } catch { /* noop */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, renderedLead?.id, docked]);

  const peekBasePx = peekContentPx ?? SHEET_PEEK_BASE_PX;
  const peekY = Math.max(0, sheetH - (peekBasePx + safeBottom));

  // ── Drag (handle + header only) ──────────────────────────────────────────────
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
    return snap === "expanded" ? 0 : peekY;
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
    if (id === prevLeadId.current) return;
    // Per-lead isolation: an uncommitted draft belongs to the OUTGOING lead —
    // a card swap is an implicit blur, so commit it before this card rebinds.
    const live = liveNoteRef.current;
    if (live && live.value.trim()) {
      void onSaveNote(live.leadId, live.value.trim(), noteBaseRef.current);
    }
    prevLeadId.current = id;
    if (id == null) return;
    setSnap("peek");
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
  const teamQuery = useQuery<{ id: number; name: string; active: boolean }[]>({
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
    if (now - tapGuard.current < 350) return;
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
      onKnock(key); // optimistic upstream: dot, status line, pill, and pin recolor together
    }
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
    const finish = (state: "saved" | "queued") => {
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
      // Conflict: another device wrote since we loaded — merge and re-commit
      // once against the fresh version, never silently overwrite.
      const merged = mergeNotes(r.serverNotes, text);
      void onSaveNote(id, merged, r.updatedAt).then(r2 => {
        if (r2.status === "saved") noteBaseRef.current = r2.updatedAt;
        finish(r2.status === "queued" ? "queued" : "saved");
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
  const statusColor = STATUS_CONFIG[canonicalStatus].color;
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

  const transform = docked
    ? (closing ? "translateX(110%)" : "translateX(0)")
    : closing
      ? "translateY(100%)"
      : dragging
        ? `translateY(${dragYRef.current}px)`
        : snap === "expanded"
          ? "translateY(0px)"
          : `translateY(${peekY}px)`;

  const ghostPill = "h-11 rounded-full bg-white/[0.05] border border-white/[0.08] flex items-center justify-center gap-1.5 text-[13px] font-semibold text-white active:scale-[0.97] transition";

  return (
    <div
      ref={sheetRef}
      data-testid="knock-sheet"
      role="dialog"
      aria-label={renderedLead.address}
      className={[
        // glass-sheet: the liquid-glass bottom-sheet surface (18px blur budget,
        // ink fill, specular top hairline, token shadow) — see index.css.
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
      {/* Drag region: handle + header only. touchAction none so the browser
          never steals the gesture for page scroll. Also the measured "header"
          half of the peek height. */}
      <div
        ref={dragRegionRef}
        data-drag-region
        className="cursor-grab select-none shrink-0"
        style={{ touchAction: "none" }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(e) => endDrag(e, false)}
        onPointerCancel={(e) => endDrag(e, true)}
        onClickCapture={swallowDragClick}
      >
        {/* Tap the handle to toggle peek/expanded — one-hand alternative to the
            drag (swallowDragClick suppresses this after a real drag). */}
        {!docked ? (
          <button
            type="button"
            aria-label="Expand or collapse card"
            data-testid="knock-sheet-handle"
            className="flex justify-center pt-2 pb-1 cursor-pointer bg-transparent border-0 w-full"
            onClick={() => setSnap(s => (s === "peek" ? "expanded" : "peek"))}
          >
            {/* white/40 clears the 3:1 non-text floor over the 0.86 ink sheet
                on both basemap extremes (white/25 measured ~2.2:1). */}
            <div className="w-10 h-[5px] rounded-full bg-white/40" />
          </button>
        ) : (
          <div className="pt-4" />
        )}

        {/* Header: status dot + address hero (with copy glyph) + ✕ close, then
            the locality sub-line and a status line (label · relative time) in
            the status color — a rep sees where the door stands at a glance. */}
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
                <h2 className="min-w-0 flex-1 text-[21px] leading-[1.15] font-semibold text-white truncate">
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
              <div data-testid="knock-status-line" className="text-[12.5px] font-semibold truncate mt-1" style={{ color: statusColor }}>
                {statusLabel}{lastKnockRel ? ` · ${lastKnockRel}` : ""}
              </div>
              {renderedLead.leadTag === "fresh_fiber_confirmed" && (
                <div className="mt-1 inline-flex items-center rounded-full border border-emerald-400/35 bg-emerald-400/10 px-2 py-0.5 text-2xs font-bold uppercase tracking-wide text-emerald-300">
                  Confirmed fresh fiber
                </div>
              )}
              {(renderedLead.leadStatus === "address_review" || detailQuery.data?.leadStatus === "address_review") && (
                <div data-testid="knock-review-banner" className="mt-1 inline-flex items-center rounded-full border border-amber-400/35 bg-amber-400/10 px-2 py-0.5 text-2xs font-bold uppercase tracking-wide text-amber-300">
                  Address needs review
                </div>
              )}
              <VerifiedPremiseFacts detail={detailQuery.data} />
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

      {/* Body — scrolls in expanded/docked, clipped in peek. NOT keyed on lead
          id: only the peek block below crossfades, so History never remounts
          (and never flashes) on a card swap. */}
      <div
        className={[
          "flex-1 min-h-0 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
          docked || snap === "expanded" ? "overflow-y-auto overscroll-contain" : "overflow-hidden",
        ].join(" ")}
      >
        {/* Peek block — everything above the fold. Keyed on lead id so it
            crossfades (opacity only) when the card swaps to another door. Also
            the measured half of the peek height. */}
        <div key={renderedLead.id} ref={peekBodyRef} className="card-swap-in">
          {/* Field Map never receives or renders a phone. Authorized callers
              enter the separate Calling workspace, where server gates run. */}
          <div data-testid="knock-action-row" className="flex items-center gap-2 pt-1">
            <a
              data-testid="action-directions"
              href={directionsHref}
              target="_blank"
              rel="noopener"
              className={`${ghostPill} flex-1 min-w-0`}
            >
              <Navigation className="w-4 h-4 opacity-80" />
              Directions
            </a>
            {canOpenCalling && (
              <Link
                data-testid="action-open-calling"
                href={`/calling/lead/${renderedLead.id}`}
                className={`${ghostPill} flex-1 min-w-0`}
              >
                <Phone className="w-4 h-4 opacity-80" />
                Calling
              </Link>
            )}
            <button
              type="button"
              data-testid="action-copy"
              onClick={copyAddress}
              className={`${ghostPill} px-4 shrink-0`}
            >
              {copiedAddr ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4 opacity-80" />}
              Copy
            </button>
          </div>

          {/* MANAGER ACTIONS (owner ask 2026-07-26): central-mark toggle +
              delete with inline two-tap confirm, for manually-added pins. */}
          {canManage && (onCentralMark || onDelete) ? (
            <div className="mt-3 flex items-center gap-2" data-testid="knock-manager-row">
              {onCentralMark ? (
                <button
                  type="button"
                  data-testid="knock-central-toggle"
                  aria-pressed={centralMode}
                  onClick={() => { setCentralMode(v => !v); setDeleteArmed(false); }}
                  className={`h-10 px-3.5 rounded-full border text-[12.5px] font-semibold whitespace-nowrap inline-flex items-center gap-1.5 active:scale-95 transition ${
                    centralMode
                      ? "bg-teal-500/30 border-teal-300/60 text-teal-100"
                      : "bg-white/[0.06] border-white/15 text-white/70"
                  }`}
                  title="Mark this door on behalf of the central team — no rep credit"
                >
                  🏢 {centralMode ? "Central: ON" : "Central mark"}
                </button>
              ) : null}
              {onDelete ? (
                <button
                  type="button"
                  data-testid="knock-delete"
                  onClick={() => {
                    if (!deleteArmed) { setDeleteArmed(true); window.setTimeout(() => setDeleteArmed(false), 4000); return; }
                    onDelete();
                  }}
                  className={`h-10 px-3.5 rounded-full border text-[12.5px] font-semibold whitespace-nowrap inline-flex items-center gap-1.5 active:scale-95 transition ${
                    deleteArmed
                      ? "bg-red-500/80 border-red-400 text-white"
                      : "bg-white/[0.06] border-red-400/40 text-red-300"
                  }`}
                  title={deleteArmed ? "Tap again to confirm delete" : "Remove this lead"}
                >
                  {deleteArmed ? "⚠️ Confirm delete?" : "🗑 Delete"}
                </button>
              ) : null}
              {centralMode ? (
                <span className="text-[11px] text-teal-200/80 leading-tight">Next status tap marks centrally (no rep)</span>
              ) : null}
            </div>
          ) : null}

          {/* Primary interaction: all 7 status pills, flex-wrap so every one is
              visible at once (no horizontal scroll, no fade mask), FIXED order so
              a pill never moves under the finger. Active = filled in its color; a
              tap briefly flashes filled + a check. */}
          <div data-testid="knock-status-row" className="mt-3 flex flex-wrap gap-2">
            {GRID_OUTCOMES.map(o => {
              const active = activeOutcome === o.key;
              const flashing = flashKey === o.key;
              const filled = active || flashing;
              const Icon = ICON_MAP[o.icon];
              return (
                <button
                  key={o.key}
                  type="button"
                  data-testid={`knock-outcome-${o.key}`}
                  aria-pressed={active}
                  onClick={() => handleStatusTap(o.key)}
                  className="h-11 px-3.5 rounded-full border text-[13px] font-semibold whitespace-nowrap inline-flex items-center gap-1.5 active:scale-95 transition"
                  style={filled
                    ? { background: o.color, borderColor: o.color, color: "#ffffff", boxShadow: `0 2px 12px ${o.color}55` }
                    : { background: `${o.color}14`, borderColor: `${o.color}55`, color: o.color }}
                >
                  {flashing ? <Check className="w-4 h-4" /> : Icon ? <Icon className="w-4 h-4" /> : null}
                  {o.label}
                </button>
              );
            })}
          </div>

          {/* Recent-activity line: the last thing that happened at this door. */}
          {recent && (
            <div data-testid="knock-recent" className="mt-3 text-[12px] truncate" style={{ color: MUTED }}>
              <span className="font-semibold" style={{ color: BODY_TEXT }}>Last:</span>{" "}
              {[recent.label, recent.who, recent.time].filter(Boolean).join(" · ")}
            </div>
          )}

          {/* Notes — a distinct inset card. Default is a slim "+ Add note" chip
              (reclaims peek height); it expands to the textarea on focus. The
              commit model is unchanged (Add / blur / card swap = one write, one
              history event); the just-committed note is pinned as "latest note". */}
          <div className="mt-4 rounded-2xl bg-white/[0.03] border border-white/[0.07] p-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: MUTED }}>
                Notes
              </span>
              {noteState !== "idle" && (
                <span data-testid="note-save-state" data-state={noteState} className="text-2xs font-medium"
                  style={{ color: noteState === "saved" ? "#34d399" : MUTED }}>
                  {noteState === "saving" ? "Saving…" : noteState === "queued" ? "Saved offline" : "Saved to history"}
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

          {/* Assignment — the ONE role difference on the shared card. Rendered
              only for lead.assign holders (team lead+); reps never see it. The
              same server capability gate enforces it, so this is display parity,
              not security. */}
          {canAssignLead && (
            <div className="mt-3 flex items-center gap-2.5" data-testid="card-assign-row">
              <span className="text-[11px] font-semibold uppercase tracking-[0.08em] shrink-0" style={{ color: MUTED }}>
                Assigned to
              </span>
              <select
                value={renderedLead.assignedRepId ?? ""}
                onChange={e => assignLead(e.target.value ? Number(e.target.value) : null)}
                data-testid="card-assign-select"
                className="flex-1 h-11 min-w-0 rounded-xl bg-white/[0.04] border border-white/[0.08] px-2.5 text-[13px] text-white focus:outline-none focus:border-primary/60"
              >
                <option value="" className="text-slate-900">Unassigned</option>
                {(teamQuery.data ?? []).filter(m => m.active).map(m => (
                  <option key={m.id} value={m.id} className="text-slate-900">{m.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* History — below the fold, newest first. Left-rail dot + bold
            actor+verb + right-aligned relative time; three event kinds keep
            VerificationBadge/distance. NOT keyed on lead id → no remount flash
            while a swap refetches. */}
        <div className="mt-5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] mb-2.5" style={{ color: MUTED }}>
            History
          </div>
          <div data-testid="knock-history-list" className={`${docked ? "max-h-[42vh]" : "max-h-56"} overflow-y-auto overscroll-contain pr-1 pb-2`}>
            {historyQuery.isLoading ? (
              <div className="space-y-3">
                <div className="h-4 rounded bg-white/[0.06] animate-pulse" />
                <div className="h-4 rounded bg-white/[0.06] animate-pulse w-2/3" />
              </div>
            ) : history.length === 0 ? (
              <div className="text-xs italic" style={{ color: MUTED }}>No changes yet</div>
            ) : (
              // One unified timeline, three event kinds. Left-rail dot colored by
              // the event (status hue, teal for assignments, slate for notes); a
              // hairline connects rows. React escapes all text — note previews
              // render as plain text, never markup.
              history.map((h, i) => {
                const meta = h.type === "status_change" && isKnockOutcome(h.status) ? OUTCOME_META[h.status] : null;
                const dot = h.type === "status_change" ? (meta?.color ?? "#64748b")
                  : h.type === "assignment" ? "#3EA394" : "#94a3b8";
                const who = h.type === "assignment"
                  ? (h.assignedBy ? shortRepName(h.assignedBy) : null)
                  : (h.actor ? shortRepName(h.actor) : null);
                const verb = h.type === "status_change" ? `marked ${meta?.label ?? h.status}`
                  : h.type === "assignment" ? `assigned to ${h.assignedTo ? shortRepName(h.assignedTo) : "—"}`
                  : "added a note";
                const isLast = i === history.length - 1;
                return (
                  <div
                    key={h.id}
                    data-testid={`knock-history-item-${i}`}
                    data-type={h.type}
                    className="flex gap-3 min-w-0"
                  >
                    {/* Left rail: dot aligned to the title line + a hairline down
                        to the next event (dropped on the last row). */}
                    <div className="relative flex flex-col items-center shrink-0">
                      <span className="w-2.5 h-2.5 rounded-full mt-[3px]" style={{ background: dot }} />
                      {!isLast && <span className="w-px flex-1 mt-1 -mb-3 bg-white/10" />}
                    </div>
                    <div className="min-w-0 flex-1 leading-tight pb-3">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[13px] truncate">
                          {who && <span className="font-semibold text-white">{who} </span>}
                          <span className={who ? "text-white/65" : "font-semibold text-white"}>
                            {who ? verb : (meta?.label ?? verb)}
                          </span>
                        </span>
                        <span className="text-[11px] shrink-0" style={{ color: MUTED }}>{relativeTime(h.changedAt)}</span>
                      </div>
                      {h.type === "note" && h.notePreview && (
                        <div className="text-[12px] mt-0.5 line-clamp-2" style={{ color: BODY_TEXT }}>
                          “{h.notePreview}”
                        </div>
                      )}
                      {/* Location verification — distance the rep was from the lead
                          WHEN MARKED (never recomputed against a current position). */}
                      {h.type === "status_change" && h.verification != null && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" style={{ color: BODY_TEXT }}>
                          <VerificationBadge status={h.verification} />
                          <span data-testid="history-distance">{formatDistance(h.distanceM)}</span>
                          {h.gpsAccuracyM != null && <span>· GPS ±{Math.round(h.gpsAccuracyM)} m</span>}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
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
