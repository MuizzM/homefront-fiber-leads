import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LeadKnockSheet } from "@/components/LeadKnockSheet";
import { OUTCOMES } from "@shared/knock";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * CONTRACT (v2 lead card, client/src/components/LeadKnockSheet.tsx).
 * Props: { lead, onKnock, onSaveNote, onClose }
 * The card is PHASE-FREE: address → status chip + relative timestamp → one
 * horizontally-scrollable row of the 7 status pills → Directions → inline
 * always-editable Notes → History (colored dot · label · time · rep).
 * Requirements exercised here (testids are the API):
 *   - [knock-sheet] with the address; one [knock-outcome-{key}] per rep status
 *     (7 pills, needs_verification excluded), each ≥44px tall
 *   - tapping ANY pill — callback and prospect included — calls onKnock(key)
 *     immediately: one tap, no confirm, no sub-screen; the row never unmounts
 *   - the pill matching the lead's current display state is aria-pressed
 *   - NO status chip / clock row: the ACTIVE pill leads the status row (a
 *     just-tapped status is promoted to the front); History has every
 *     timestamped change
 *   - [action-directions] links to Google Maps turn-by-turn (NEVER mapbox —
 *     geocoding billing guardrail); it is the ONLY action button
 *   - [knock-note-input] is a COMPOSER: starts empty (saved notes live in
 *     History), commits on blur or the Add button, and CLEARS after commit
 *   - [knock-history-list] renders every change: outcome label, timestamp,
 *     shortened rep name ("M. Muhammad")
 *   - REMOVED chrome must not render: X close, Skip, Next Door, call, text
 *   - Escape fires onClose; lead null renders nothing
 * Drag physics are framer-motion's problem, not jsdom's — NOT tested here.
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

  it("renders the address and exactly the 7 one-tap pills — ACTIVE status leads the row", () => {
    renderSheet(); // fresh prospect → prospect pill is the current status, so it leads
    expect(screen.getByTestId("knock-sheet")).toHaveTextContent("148 Maple St");
    expect(pillOrder()).toEqual([
      "prospect", "not_home", "interested", "sold", "not_interested", "follow_up", "callback",
    ]);
    expect(pillOrder()).toHaveLength(GRID_KEYS.length);
    expect(screen.queryByTestId("knock-outcome-needs_verification")).not.toBeInTheDocument();
  });

  it("a sold door opens with the big Sold pill FIRST and filled", () => {
    renderSheet({
      lead: baseLead({ leadStatus: "sold", visited: true, lastOutcome: "sold", lastKnockedAt: new Date().toISOString() }),
    });
    expect(pillOrder()[0]).toBe("sold");
    expect(screen.getByTestId("knock-outcome-sold")).toHaveAttribute("aria-pressed", "true");
    // No chip/clock row — the leading pill IS the status readout.
    expect(screen.queryByTestId("knock-status-chip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("knock-status-time")).not.toBeInTheDocument();
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

  it("header block: street on line 1, city/state/ZIP on line 2", () => {
    renderSheet();
    expect(screen.getByTestId("knock-sheet")).toHaveTextContent("148 Maple St");
    expect(screen.getByTestId("knock-address-locality")).toHaveTextContent("Rockwell, NC 28138");
  });

  it("tapping a status promotes it to the front once the lead data reflects it", () => {
    // The row order derives from the lead's display state (optimistic upstream),
    // so simulate the post-tap lead: callback just logged → callback leads.
    renderSheet({
      lead: baseLead({
        leadStatus: "follow_up", visited: true, lastOutcome: "callback",
        lastKnockedAt: new Date().toISOString(),
      }),
    });
    expect(pillOrder()[0]).toBe("callback");
    expect(screen.getByTestId("knock-outcome-callback")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("<LeadKnockSheet /> — actions, notes, history", () => {
  it("Directions is the ONLY action: Google Maps turn-by-turn to the coords, never mapbox", () => {
    renderSheet();
    const a = screen.getByTestId("action-directions");
    expect(a).toHaveAttribute("href", expect.stringContaining("google.com/maps/dir"));
    expect(a.getAttribute("href")).toContain("34.9,-79.9");
    expect(a.getAttribute("href")).not.toMatch(/mapbox/i);
    expect(screen.queryByTestId("action-call")).not.toBeInTheDocument();
    expect(screen.queryByTestId("action-text")).not.toBeInTheDocument();
  });

  it("notes composer: starts EMPTY (saved notes live in History), commit clears the draft", async () => {
    const { props } = renderSheet();
    const input = screen.getByTestId("knock-note-input") as HTMLTextAreaElement;
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
    await waitFor(() => expect(input).toHaveValue(""));  // draft CLEARED after save
    await waitFor(() => expect(screen.getByTestId("note-save-state")).toHaveTextContent("Saved to history"));
  });

  it("the Add button commits without waiting for blur", async () => {
    const { props } = renderSheet();
    const input = screen.getByTestId("knock-note-input") as HTMLTextAreaElement;
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
    const input = screen.getByTestId("knock-note-input") as HTMLTextAreaElement;
    await userEvent.type(input, "extra detail");
    input.blur();
    await waitFor(() => expect(onSaveNote).toHaveBeenCalledTimes(2));
    // Second commit carried the MERGED text against the fresh base version.
    expect(onSaveNote.mock.calls[1][0]).toBe(7);
    expect(onSaveNote.mock.calls[1][1]).toContain("Server wrote this");
    expect(onSaveNote.mock.calls[1][1]).toContain("extra detail");
    expect(onSaveNote.mock.calls[1][2]).toBe("2026-07-08T19:30:00.000Z");
    await waitFor(() => expect(input).toHaveValue("")); // cleared once settled
  });

  it("history is ONE timeline: status changes, assignments (assigned by), and note events", async () => {
    renderSheet();
    const rows = await screen.findAllByTestId(/knock-history-item-/);
    expect(rows).toHaveLength(4);
    // status_change: label · time · actor
    expect(rows[0]).toHaveTextContent("Sold");
    expect(rows[0]).toHaveTextContent("Jul 8");
    expect(rows[0]).toHaveTextContent("M. Muhammad");
    // note event: title line + author/time meta line + wrapped preview text
    expect(rows[1]).toHaveTextContent("Note");
    expect(rows[1]).toHaveTextContent("Z. Muhammad");
    expect(rows[1]).toHaveTextContent("Gate code 4412, come back after 6pm");
    // assignment: to whom AND by whom
    expect(rows[2]).toHaveTextContent("Assigned to Z. Muhammad");
    expect(rows[2]).toHaveTextContent("by M. Muhammad");
    // status_change with no actor → no dangling separator
    expect(rows[3]).toHaveTextContent("Not Home");
  });
});

describe("<LeadKnockSheet /> — chrome and lifecycle", () => {
  it("the assign row is capability-gated OFF for reps (fail-closed without lead.assign)", () => {
    renderSheet(); // test auth context has no user → useCan fails closed
    expect(screen.queryByTestId("card-assign-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("card-assign-select")).not.toBeInTheDocument();
  });

  it("renders none of the removed chrome: no close, skip, next-door, or save-state chip", () => {
    renderSheet();
    for (const gone of [
      "knock-sheet-close", "knock-skip", "next-door-btn", "knock-save-state",
      "knock-change-outcome", "knock-hot-chip",
    ]) {
      expect(screen.queryByTestId(gone)).not.toBeInTheDocument();
    }
    expect(screen.getByTestId("knock-sheet").textContent).not.toMatch(/[✓✔🔥🎉]/u);
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
