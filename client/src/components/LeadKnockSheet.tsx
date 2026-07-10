// ── Lead card (bottom sheet) ──────────────────────────────────────────────────
// Mobile-first card for the rep door-knocking flow. Deliberately NOT vaul/radix:
// no portal, no backdrop, no body scroll-lock — the map above must stay 100%
// interactive while the card is open. Snapping is pure transform (translateY)
// so the map never reflows, and dragging is confined to the handle/header
// region so the status row and body scroll are never hijacked.
//
// The card is phase-free: address → status chip + timestamp → one row of
// one-tap status pills → Directions → inline Notes → History. Tapping a status
// saves immediately (no confirm, no done-screen); the chip, timestamp, active
// pill, and map pin all update from the same optimistic lead data.

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Navigation } from "lucide-react";
import { SHEET_PEEK_BASE_PX } from "@/lib/mapPins";
import { mergeNotes, type NoteSaveResult } from "@/lib/leadNotes";
import { useCan } from "@/lib/capabilities";
import { apiRequest } from "@/lib/queryClient";
import { VerificationBadge, formatDistance, type VStatus } from "@/components/verification";
import {
  OUTCOMES, OUTCOME_META, pinDisplayState, isKnockOutcome,
  type KnockOutcome, type PinDisplayState,
} from "@shared/knock";

export type SheetSnap = "peek" | "expanded";

export interface SheetLead {
  id: number; lat?: number | null; lng?: number | null;
  address: string; city?: string | null; state?: string | null; zip?: string | null;
  leadStatus: string;
  assignedRepId?: number | null;  // shown/edited only for lead.assign holders
  visited?: boolean; lastOutcome?: string | null; lastKnockedAt?: string | null;
}

export interface LeadKnockSheetProps {
  lead: SheetLead | null;                 // null → animate out then unmount after 300ms
  onKnock: (outcome: KnockOutcome) => void;
  // Lead-level notes, persisted inline. Explicit leadId so a pending debounce
  // for the OUTGOING lead can flush during a card swap; returns the save
  // result so the card can render Saving/Saved and merge 409 conflicts.
  onSaveNote: (leadId: number, note: string, baseUpdatedAt: string | null) => Promise<NoteSaveResult>;
  onClose: () => void;                    // escape key / overdrag (map tap closes upstream)
  // Docked mode only: shift the card left by this many px so it never covers
  // a right-side rail (the leads panel) — a rail-row tap must keep the list
  // visible beside the card, or list-driven triage dies (review finding).
  dockOffsetPx?: number;
}

// Peek height: everything a rep needs on a porch — address, chip, status row,
// Directions, and the Notes field, nothing half-clipped below the fold.
// Imported from mapPins so the map's camera padding tracks the sheet lip.
const PEEK_BASE_PX = SHEET_PEEK_BASE_PX;
// Tap-vs-drag threshold: header taps must still land.
const TAP_SLOP_PX = 6;
// Dragging further than this below the peek position dismisses the sheet.
const CLOSE_OVERDRAG_PX = 80;
// Flick faster than this decides snap direction regardless of position.
const FLICK_VELOCITY = 0.5; // px/ms

// Muted secondary text per the card spec.
const MUTED = "#8A94A6";

// The rep card offers exactly the 7 spec statuses, in spec order (OUTCOMES
// order minus needs_verification, which is server/history back-compat only).
const GRID_OUTCOMES = OUTCOMES.filter(o => o.key !== "needs_verification");

// The active pill mirrors the lead's CURRENT display state.
const DS_TO_OUTCOME: Partial<Record<PinDisplayState, KnockOutcome>> = {
  unworked: "prospect", not_home: "not_home", interested: "interested",
  follow_up: "follow_up", callback: "callback", sold: "sold",
  not_interested: "not_interested",
};

// "Jul 8, 3:12 PM" — history rows carry the absolute time of each change.
function historyTime(iso: string): string {
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return "";
  return t.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
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
interface LeadDetail { id: number; notes?: string | null; updatedAt?: string | null }

function LeadKnockSheetInner(props: LeadKnockSheetProps): JSX.Element | null {
  const { lead, onKnock, onSaveNote, onClose, dockOffsetPx = 0 } = props;

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
  const [noteState, setNoteState] = useState<"idle" | "saving" | "saved" | "queued">("idle");
  const noteBaseRef = useRef<string | null>(null);     // lead.updatedAt we loaded — conflict base
  const liveNoteRef = useRef<{ leadId: number; value: string } | null>(null); // for outgoing-lead flush
  const committingRef = useRef(false);                 // one in-flight commit at a time

  const sheetRef = useRef<HTMLDivElement>(null);
  const statusRowRef = useRef<HTMLDivElement>(null);

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
    setNoteState("idle");
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

  // Promoted pill must be visible: snap the row's scroll back to the start
  // whenever the leader changes (new selection or a fresh tap).
  const dsForScroll = pinDisplayState(renderedLead ?? { leadStatus: "prospect" });
  useEffect(() => {
    if (statusRowRef.current) statusRowRef.current.scrollLeft = 0; // plain write — no smooth-scroll API needed
  }, [dsForScroll, renderedLead?.id]);

  // ── One-tap disposition ──────────────────────────────────────────────────────
  const tapGuard = useRef(0); // absorbs accidental double-fires of the same tap
  const handleStatusTap = (key: KnockOutcome) => {
    const now = Date.now();
    if (now - tapGuard.current < 350) return;
    tapGuard.current = now;
    try { navigator.vibrate?.(key === "sold" ? [12, 40, 12] : 10); } catch { /* unsupported */ }
    onKnock(key); // optimistic upstream: chip, timestamp, pill, and pin recolor together
  };

  // ── Notes: composer model ────────────────────────────────────────────────────
  // Typing is pure local state (never touches the network). Committing — blur,
  // the Add button, or a card swap — sends ONE write, logs ONE history event,
  // and CLEARS the draft; the note is then read from History. Offline commits
  // stash durably and clear too (they flush when connectivity returns).
  const commitNote = (value: string) => {
    const id = renderedLead?.id;
    const text = value.trim();
    if (!id || !text || committingRef.current) return;
    committingRef.current = true;
    setNoteState("saving");
    const finish = (state: "saved" | "queued") => {
      committingRef.current = false;
      setNoteState(state);
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
  const activeOutcome = DS_TO_OUTCOME[ds] ?? null;
  // The current status pill LEADS the row — opening the card answers "where
  // does this door stand?" with the first, filled pill. Tapping a different
  // status promotes it to the front. O(n) over 7 items, no sort.
  const orderedOutcomes = activeOutcome
    ? [OUTCOME_META[activeOutcome], ...GRID_OUTCOMES.filter(o => o.key !== activeOutcome)]
    : GRID_OUTCOMES;

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
        ? `translateY(${dragY}px)`
        : snap === "expanded"
          ? "translateY(0px)"
          : `translateY(${peekY}px)`;

  return (
    <div
      ref={sheetRef}
      data-testid="knock-sheet"
      role="dialog"
      aria-label={renderedLead.address}
      className={[
        // glass-sheet: the liquid-glass bottom-sheet surface (18px blur budget,
        // ink fill, specular top hairline, token shadow) — see index.css.
        "glass-sheet fixed z-40 will-change-transform",
        docked
          ? "inset-y-0 right-0 w-[380px] rounded-l-[24px] border-l border-white/10"
          : "inset-x-0 bottom-0 h-[min(85dvh,640px)] rounded-t-[24px] border-t border-white/10",
        dragging ? "" : "transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
      ].join(" ")}
      style={{ transform, ...(docked && dockOffsetPx ? { right: dockOffsetPx } : null) }}
    >
      {/* Drag region: handle + header + chip row. touchAction none so the
          browser never steals the gesture for page scroll. */}
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
        {!docked ? (
          <div
            data-testid="knock-sheet-handle"
            className="flex justify-center pt-2 pb-1 cursor-pointer"
            onClick={() => setSnap(s => (s === "peek" ? "expanded" : "peek"))}
          >
            {/* white/40 clears the 3:1 non-text floor over the 0.86 ink sheet
                on both basemap extremes (white/25 measured ~2.2:1). */}
            <div className="w-10 h-[5px] rounded-full bg-white/40" />
          </div>
        ) : (
          <div className="pt-4" />
        )}

        <div className="px-4 pb-3">
          {/* Header block: street + city/state/ZIP, nothing else. No status
              chip or clock — the ACTIVE pill leads the status row below, and
              History carries every timestamped change. */}
          <h2 className="min-w-0 text-[17px] font-bold text-white truncate">{renderedLead.address}</h2>
          {(renderedLead.city || renderedLead.state || renderedLead.zip) && (
            <div data-testid="knock-address-locality" className="text-[12px] truncate mt-0.5" style={{ color: MUTED }}>
              {[renderedLead.city, [renderedLead.state, renderedLead.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")}
            </div>
          )}
        </div>
      </div>

      {/* Body — springs in when the card swaps to a different lead. Pure CSS
          (keyed remount restarts the animation): framer-motion was this file's
          only consumer, so dropping it cuts the whole library from the bundle. */}
      <div
        key={renderedLead.id}
        className={[
          "card-swap-in px-4 h-[calc(100%-88px)] pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
          docked || snap === "expanded" ? "overflow-y-auto overscroll-contain" : "overflow-hidden",
        ].join(" ")}
      >
        {/* One-tap status row — single horizontally scrollable line of pills.
            Active = filled in its status color; the rest are outlined. */}
        <div
          data-testid="knock-status-row"
          ref={statusRowRef}
          className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden pill-row-fade"
        >
          {orderedOutcomes.map(o => {
            const active = activeOutcome === o.key;
            return (
              <button
                key={o.key}
                type="button"
                data-testid={`knock-outcome-${o.key}`}
                aria-pressed={active}
                onClick={() => handleStatusTap(o.key)}
                className="h-11 px-4 shrink-0 rounded-full border text-[13px] font-semibold whitespace-nowrap active:scale-95 transition"
                style={active
                  ? { background: o.color, borderColor: o.color, color: "#ffffff", boxShadow: `0 2px 12px ${o.color}55` }
                  : { background: `${o.color}14`, borderColor: `${o.color}55`, color: o.color }}
              >
                {o.label}
              </button>
            );
          })}
        </div>

        {/* Action row: Directions only. */}
        <a
          data-testid="action-directions"
          href={directionsHref}
          target="_blank"
          rel="noopener"
          className="mt-4 h-12 w-full rounded-2xl bg-white/[0.05] border border-white/[0.08] flex items-center justify-center gap-2 text-[14px] font-semibold text-white active:scale-[0.98] transition"
        >
          <Navigation className="w-4 h-4 opacity-80" />
          Directions
        </a>

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
              className="flex-1 h-9 min-w-0 rounded-xl bg-white/[0.04] border border-white/[0.08] px-2.5 text-[13px] text-white focus:outline-none focus:border-primary/60"
            >
              <option value="" className="text-slate-900">Unassigned</option>
              {(teamQuery.data ?? []).filter(m => m.active).map(m => (
                <option key={m.id} value={m.id} className="text-slate-900">{m.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Notes — a quick composer. Committing (Add / tap away / card swap)
            saves once, logs the history event, and CLEARS the draft: History
            is where saved notes are read, the box is only for writing. */}
        <div className="mt-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: MUTED }}>
              Notes
            </span>
            {noteState !== "idle" && (
              <span data-testid="note-save-state" data-state={noteState} className="text-[10px] font-medium"
                style={{ color: noteState === "saved" ? "#34d399" : MUTED }}>
                {noteState === "saving" ? "Saving…" : noteState === "queued" ? "Saved offline" : "Saved to history"}
              </span>
            )}
          </div>
          <div className="relative">
            <textarea
              data-testid="knock-note-input"
              placeholder="Add a note…"
              value={note}
              onChange={handleNoteChange}
              onBlur={() => commitNote(note)}
              rows={2}
              className="w-full min-h-[60px] text-[15px] leading-snug bg-white/[0.04] border border-white/[0.08] rounded-2xl pl-3.5 pr-16 py-2.5 text-white placeholder:text-white/25 resize-none focus:outline-none focus:border-primary/60"
            />
            {note.trim() && (
              <button
                type="button"
                data-testid="note-add-btn"
                // Fires before blur (pointerdown) so this never double-commits.
                onPointerDown={(e) => { e.preventDefault(); commitNote(note); }}
                className="absolute right-2 bottom-2.5 h-9 px-3.5 rounded-full bg-primary text-white text-[12px] font-semibold active:scale-95 transition"
              >
                Add
              </button>
            )}
          </div>
        </div>

        {/* History — every past change, newest first, scrolling independently
            so the status row above stays reachable. */}
        <div className="mt-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] mb-2" style={{ color: MUTED }}>
            History
          </div>
          <div data-testid="knock-history-list" className={`${docked ? "max-h-[42vh]" : "max-h-56"} overflow-y-auto overscroll-contain space-y-3 pr-1 pb-2`}>
            {historyQuery.isLoading ? (
              <>
                <div className="h-4 rounded bg-white/[0.06] animate-pulse" />
                <div className="h-4 rounded bg-white/[0.06] animate-pulse w-2/3" />
              </>
            ) : history.length === 0 ? (
              <div className="text-xs italic" style={{ color: MUTED }}>No changes yet</div>
            ) : (
              // One unified timeline, three event kinds. Colored dot = the
              // event: status hue for dispositions, teal for assignments,
              // slate for notes. React escapes all text — note previews render
              // as plain text, never markup.
              history.map((h, i) => {
                const meta = h.type === "status_change" && isKnockOutcome(h.status) ? OUTCOME_META[h.status] : null;
                const dot = h.type === "status_change" ? (meta?.color ?? "#64748b")
                  : h.type === "assignment" ? "#3EA394" : "#94a3b8";
                const title = h.type === "status_change" ? (meta?.label ?? h.status)
                  : h.type === "assignment" ? `Assigned to ${h.assignedTo ? shortRepName(h.assignedTo) : "—"}`
                  : "Note";
                const metaLine = [
                  h.type === "assignment" && h.assignedBy ? `by ${shortRepName(h.assignedBy)}` : null,
                  h.type !== "assignment" && h.actor ? shortRepName(h.actor) : null,
                  historyTime(h.changedAt),
                ].filter(Boolean).join(" · ");
                return (
                  <div
                    key={h.id}
                    data-testid={`knock-history-item-${i}`}
                    data-type={h.type}
                    className="flex gap-2.5 min-w-0"
                  >
                    {/* Dot aligned to the title line; a hairline ties multi-line rows together */}
                    <span className="w-2 h-2 rounded-full shrink-0 mt-[5px]" style={{ background: dot }} />
                    <div className="min-w-0 flex-1 leading-tight">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-[13px] font-medium text-white truncate">{title}</span>
                        <span className="text-[11px] shrink-0" style={{ color: MUTED }}>{metaLine}</span>
                      </div>
                      {h.type === "note" && h.notePreview && (
                        <div className="text-[12px] mt-0.5 line-clamp-2" style={{ color: "#B9C2D0" }}>
                          “{h.notePreview}”
                        </div>
                      )}
                      {/* Location verification — distance the rep was from the lead
                          WHEN MARKED (never recomputed against a current position). */}
                      {h.type === "status_change" && h.verification != null && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]" style={{ color: "#B9C2D0" }}>
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
