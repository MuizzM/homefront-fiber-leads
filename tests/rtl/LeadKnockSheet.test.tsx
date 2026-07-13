import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LeadKnockSheet } from "@/components/LeadKnockSheet";
import { OUTCOMES } from "@shared/knock";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * CONTRACT (v3 lead card, client/src/components/LeadKnockSheet.tsx).
 * Props: { lead, onKnock, onSaveNote, onClose, onPeekHeight? }
 * The card is PHASE-FREE: status-dot header (address hero + copy + ✕ close) →
 * status line (label · relative time) → compact action pills (Directions /
 * Call / Copy) → a FLEX-WRAP grid of the 7 status pills in FIXED order (no
 * horizontal scroll, no reshuffle) → recent-activity line → collapsible Notes
 * composer → History timeline.
 * Requirements exercised here (testids are the API):
 *   - [knock-sheet] with the address; one [knock-outcome-{key}] per rep status
 *     (7 pills, needs_verification excluded), each ≥44px tall
 *   - the 7 pills render in FIXED OUTCOMES order and NEVER reshuffle — the
 *     active pill is filled/aria-pressed in place, not promoted to the front
 *   - tapping ANY pill — callback and prospect included — calls onKnock(key)
 *     immediately: one tap, no confirm, no sub-screen; the row never unmounts
 *   - the pill matching the lead's current display state is aria-pressed
 *   - a [knock-status-line] shows the current STATE_LABELS status + relative
 *     time in the status color; a [knock-sheet-close] ✕ fires onClose
 *   - [action-directions] links to Google Maps turn-by-turn (NEVER mapbox —
 *     geocoding billing guardrail); [action-call] renders ONLY with a phone
 *   - Notes default to a [note-add-chip] that expands to a [knock-note-input]
 *     COMPOSER: starts empty (saved notes live in History), commits on blur or
 *     the Add button, and CLEARS after commit
 *   - [knock-history-list] renders every change: actor+verb, relative time,
 *     shortened rep name ("M. Muhammad")
 *   - REMOVED chrome must not render: Skip, Next Door, text
 *   - Escape fires onClose; lead null renders nothing
 * Drag physics are pointer-math the jsdom stubs don't exercise — NOT tested here.
 * ────────────────────────────────────────────────────────────────────────────
 */

// jsdom lacks the pointer-capture API framer-motion's drag listeners touch,
// and Radix-style widgets call scrollIntoView — stub both as no-ops.
beforeAll(() => {
  const proto = Element.prototype as any;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  }
  if (!window.matchMedia) {
    // framer-motion checks prefers-reduced-motion lazily.
    (window as any).matchMedia = () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    });
  }
});

const GRID_KEYS = OUTCOMES.filter(o => o.key !== "needs_verification").map(o => o.key);

// Unified timeline: status changes, assignments ("assigned by"), note events.
const HISTORY = [
  { id: "k12", type: "status_change", actor: "Muizz Muhammad", changedAt: "2026-07-08T19:12:00.000Z", status: "sold" },
  { id: "e5", type: "note", actor: "Zargham Muhammad", changedAt: "2026-07-08T19:15:00.000Z", notePreview: "Gate code 4412, come back after 6pm" },
  { id: "e4", type: "assignment", actor: "Muizz Muhammad", changedAt: "2026-07-08T13:02:00.000Z", assignedTo: "Zargham Muhammad", assignedBy: "Muizz Muhammad" },
  { id: "k10", type: "status_change", actor: null, changedAt: "2026-07-06T14:00:00.000Z", status: "not_home" },
];

function baseLead(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    address: "148 Maple St",
    city: "Rockwell",
    state: "NC",
    zip: "28138",
    leadStatus: "prospect",
    lat: 34.9,
    lng: -79.9,
    ...overrides,
  };
}

function renderSheet(overrides: Record<string, any> = {}) {
  // The card fetches lead detail (notes seed) and knock history itself; the
  // test client answers both from one key-aware queryFn.
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        queryFn: async ({ queryKey }) => {
          const key = String(queryKey[0] ?? "");
          if (key.endsWith("/history")) return HISTORY;
          return { id: 7, notes: "Gate code 4411", updatedAt: "2026-07-08T19:00:00.000Z" };
        },
      },
    },
  });
  const props = {
    lead: baseLead(),
    onKnock: vi.fn(),
    onSaveNote: vi.fn().mockResolvedValue({ status: "saved", updatedAt: "2026-07-08T19:20:00.000Z" }),
    onClose: vi.fn(),
    ...overrides,
  };
  const view = render(
    <QueryClientProvider client={qc}>
      <LeadKnockSheet {...(props as any)} />
    </QueryClientProvider>,
  );
  return { ...view, props };
}

describe("<LeadKnockSheet /> — status row", () => {
  const pillOrder = () =>
    [...screen.getByTestId("knock-status-row").querySelectorAll("[data-testid^='knock-outcome-']")]
      .map(b => (b as HTMLElement).dataset.testid!.replace("knock-outcome-", ""));

  it("renders the address and exactly the 7 one-tap pills in FIXED order", () => {
    renderSheet();
    expect(screen.getByTestId("knock-sheet")).toHaveTextContent("148 Maple St");
    // Fixed OUTCOMES order (minus needs_verification) — pills NEVER reshuffle.
    expect(pillOrder()).toEqual([
      "not_home", "interested", "sold", "not_interested", "follow_up", "callback", "prospect",
    ]);
    expect(pillOrder()).toEqual(GRID_KEYS);
    expect(pillOrder()).toHaveLength(GRID_KEYS.length);
    expect(screen.queryByTestId("knock-outcome-needs_verification")).not.toBeInTheDocument();
  });

  it("a sold door: the Sold pill is filled/pressed IN PLACE (order never changes)", () => {
    renderSheet({
      lead: baseLead({ leadStatus: "sold", visited: true, lastOutcome: "sold", lastKnockedAt: new Date().toISOString() }),
    });
    // Sold stays at its fixed index, just aria-pressed — no promotion to front.
    expect(pillOrder()).toEqual(GRID_KEYS);
    expect(screen.getByTestId("knock-outcome-sold")).toHaveAttribute("aria-pressed", "true");
    // The status LINE (not a floating chip) is the always-visible status readout.
    expect(screen.getByTestId("knock-status-line")).toHaveTextContent("SOLD");
  });

  it("every pill is a one-handed tap target (≥44px)", () => {
    renderSheet();
    for (const key of GRID_KEYS) {
      // h-11 = 44px; jsdom has no layout, so assert the class contract.
      expect(screen.getByTestId(`knock-outcome-${key}`).className).toMatch(/\bh-11\b/);
    }
  });

  it("tapping any pill — callback and prospect included — fires onKnock immediately, no sub-screen", async () => {
    for (const key of ["callback", "prospect", "sold"] as const) {
      const { props, unmount } = renderSheet();
      await userEvent.click(screen.getByTestId(`knock-outcome-${key}`));
      expect(props.onKnock).toHaveBeenCalledTimes(1);
      expect(props.onKnock).toHaveBeenCalledWith(key);
      // The row never unmounts — no done phase, no scheduling form.
      expect(screen.getByTestId("knock-status-row")).toBeInTheDocument();
      expect(screen.queryByTestId("callback-quick-row")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("the pill matching the lead's current state is pressed; a prospect reset re-arms the Prospect pill", () => {
    const first = renderSheet({
      lead: baseLead({ leadStatus: "interested", visited: true, lastOutcome: "interested", lastKnockedAt: new Date().toISOString() }),
    });
    expect(screen.getByTestId("knock-outcome-interested")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("knock-outcome-sold")).toHaveAttribute("aria-pressed", "false");
    first.unmount();

    renderSheet({
      lead: baseLead({ leadStatus: "prospect", visited: true, lastOutcome: "prospect", lastKnockedAt: new Date().toISOString() }),
    });
    expect(screen.getByTestId("knock-outcome-prospect")).toHaveAttribute("aria-pressed", "true");
  });

  it("header block: street on line 1, city/state/ZIP on line 2, status line in the status color", () => {
    renderSheet();
    expect(screen.getByTestId("knock-sheet")).toHaveTextContent("148 Maple St");
    expect(screen.getByTestId("knock-address-locality")).toHaveTextContent("Rockwell, NC 28138");
    // A fresh prospect reads "Prospect" on the status line (no last-knock time yet).
    expect(screen.getByTestId("knock-status-line")).toHaveTextContent("Prospect");
  });

  it("a callback door: the Callback pill is aria-pressed in its FIXED slot (no reshuffle)", () => {
    renderSheet({
      lead: baseLead({
        leadStatus: "follow_up", visited: true, lastOutcome: "callback",
        lastKnockedAt: new Date().toISOString(),
      }),
    });
    expect(pillOrder()).toEqual(GRID_KEYS); // order is invariant of the active status
    expect(screen.getByTestId("knock-outcome-callback")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("knock-status-line")).toHaveTextContent("Callback");
  });
});

describe("<LeadKnockSheet /> — actions, notes, history", () => {
  it("Directions: Google Maps turn-by-turn to the coords, never mapbox; Copy present", () => {
    renderSheet();
    const a = screen.getByTestId("action-directions");
    expect(a).toHaveAttribute("href", expect.stringContaining("google.com/maps/dir"));
    expect(a.getAttribute("href")).toContain("34.9,-79.9");
    expect(a.getAttribute("href")).not.toMatch(/mapbox/i);
    // Copy is always in the action row; there is never a "text" action.
    expect(screen.getByTestId("action-copy")).toBeInTheDocument();
    expect(screen.queryByTestId("action-text")).not.toBeInTheDocument();
  });

  it("Call renders ONLY when the lead has a contactPhone (tel: deep link)", () => {
    const { unmount } = renderSheet(); // no phone on baseLead
    expect(screen.queryByTestId("action-call")).not.toBeInTheDocument();
    unmount();

    renderSheet({ lead: baseLead({ contactPhone: "+1 555 867 5309" }) });
    const call = screen.getByTestId("action-call");
    expect(call).toHaveAttribute("href", "tel:+1 555 867 5309");
  });

  // Notes default to a slim "+ Add note" chip; the textarea appears on focus.
  async function openComposer(): Promise<HTMLTextAreaElement> {
    await userEvent.click(screen.getByTestId("note-add-chip"));
    return (await screen.findByTestId("knock-note-input")) as HTMLTextAreaElement;
  }

  it("notes composer: collapsed by default, starts EMPTY, commit clears the draft", async () => {
    const { props } = renderSheet();
    // Collapsed: the textarea is not mounted until the chip is tapped.
    expect(screen.queryByTestId("knock-note-input")).not.toBeInTheDocument();
    const input = await openComposer();
    // Never seeded from the lead — the box is for writing, History is for reading.
    expect(input).toHaveValue("");
    expect(screen.queryByTestId("note-add-btn")).not.toBeInTheDocument(); // Add hides while empty

    await userEvent.type(input, "dog in yard");
    expect(props.onSaveNote).not.toHaveBeenCalled(); // typing is local-only
    expect(screen.getByTestId("note-add-btn")).toBeInTheDocument();

    input.blur(); // tap-away commits
    await waitFor(() =>
      expect(props.onSaveNote).toHaveBeenCalledWith(7, "dog in yard", "2026-07-08T19:00:00.000Z"),
    );
    expect(props.onSaveNote).toHaveBeenCalledTimes(1); // one commit = one history event
    await waitFor(() => expect(screen.getByTestId("note-save-state")).toHaveTextContent("Saved to history"));
    // The committed note is pinned as the "latest note" so it never feels lost.
    await waitFor(() => expect(screen.getByTestId("note-latest")).toHaveTextContent("dog in yard"));
  });

  it("the Add button commits without waiting for blur", async () => {
    const { props } = renderSheet();
    const input = await openComposer();
    await userEvent.type(input, "gate code 4412");
    await userEvent.pointer({ keys: "[MouseLeft]", target: screen.getByTestId("note-add-btn") });
    await waitFor(() => expect(props.onSaveNote).toHaveBeenCalledTimes(1));
    expect(props.onSaveNote).toHaveBeenCalledWith(7, "gate code 4412", "2026-07-08T19:00:00.000Z");
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("a conflict (409) merges with the server copy, re-commits once, then clears", async () => {
    const onSaveNote = vi.fn()
      .mockResolvedValueOnce({ status: "conflict", serverNotes: "Server wrote this", updatedAt: "2026-07-08T19:30:00.000Z" })
      .mockResolvedValueOnce({ status: "saved", updatedAt: "2026-07-08T19:31:00.000Z" });
    renderSheet({ onSaveNote });
    const input = await openComposer();
    await userEvent.type(input, "extra detail");
    input.blur();
    await waitFor(() => expect(onSaveNote).toHaveBeenCalledTimes(2));
    // Second commit carried the MERGED text against the fresh base version.
    expect(onSaveNote.mock.calls[1][0]).toBe(7);
    expect(onSaveNote.mock.calls[1][1]).toContain("Server wrote this");
    expect(onSaveNote.mock.calls[1][1]).toContain("extra detail");
    expect(onSaveNote.mock.calls[1][2]).toBe("2026-07-08T19:30:00.000Z");
    // Draft cleared once settled: the blur-commit collapses the composer back to
    // the "+ Add note" chip and pins the committed note.
    await waitFor(() => expect(screen.getByTestId("note-add-chip")).toBeInTheDocument());
    expect(screen.getByTestId("note-latest")).toHaveTextContent("extra detail");
  });

  it("history is ONE timeline: actor+verb + right-aligned RELATIVE time, three kinds", async () => {
    // Deterministic "now" so relative times are stable (event fixtures are dated
    // 2026-07-06..08). Spy Date.now only — new Date(iso) parsing stays real.
    const NOW = new Date("2026-07-08T20:00:00.000Z").getTime();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(NOW);
    try {
      renderSheet();
      const rows = await screen.findAllByTestId(/knock-history-item-/);
      expect(rows).toHaveLength(4);
      // status_change: bold actor + "marked {label}" + relative time
      expect(rows[0]).toHaveTextContent("M. Muhammad");
      expect(rows[0]).toHaveTextContent("marked Sold");
      expect(rows[0]).toHaveTextContent("48m ago");
      // note event: actor + "added a note" + the wrapped preview text
      expect(rows[1]).toHaveTextContent("Z. Muhammad");
      expect(rows[1]).toHaveTextContent("added a note");
      expect(rows[1]).toHaveTextContent("Gate code 4412, come back after 6pm");
      // assignment: assigned-by actor + "assigned to {assignee}"
      expect(rows[2]).toHaveTextContent("M. Muhammad");
      expect(rows[2]).toHaveTextContent("assigned to Z. Muhammad");
      expect(rows[2]).toHaveTextContent("6h ago");
      // status_change with no actor → just the bold label, then relative time
      expect(rows[3]).toHaveTextContent("Not Home");
      expect(rows[3]).toHaveTextContent("2d ago");
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("<LeadKnockSheet /> — chrome and lifecycle", () => {
  it("the assign row is capability-gated OFF for reps (fail-closed without lead.assign)", () => {
    renderSheet(); // test auth context has no user → useCan fails closed
    expect(screen.queryByTestId("card-assign-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("card-assign-select")).not.toBeInTheDocument();
  });

  it("renders none of the removed chrome: no skip, next-door, or legacy save-state chip", () => {
    renderSheet();
    for (const gone of [
      "knock-skip", "next-door-btn", "knock-save-state",
      "knock-change-outcome", "knock-hot-chip",
    ]) {
      expect(screen.queryByTestId(gone)).not.toBeInTheDocument();
    }
    expect(screen.getByTestId("knock-sheet").textContent).not.toMatch(/[🔥🎉]/u);
  });

  it("the ✕ close button fires onClose (essential in docked mode with no drag)", async () => {
    const { props } = renderSheet();
    await userEvent.click(screen.getByTestId("knock-sheet-close"));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape fires onClose (map tap and overdrag close upstream)", async () => {
    const { props } = renderSheet();
    await userEvent.keyboard("{Escape}");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing when lead is null", () => {
    renderSheet({ lead: null });
    expect(screen.queryByTestId("knock-sheet")).not.toBeInTheDocument();
  });
});
