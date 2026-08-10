import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LeadKnockSheet } from "@/components/LeadKnockSheet";
import { FIELD_OUTCOMES } from "@shared/knock";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * CONTRACT (v4b lead card, client/src/components/LeadKnockSheet.tsx).
 * Props: { lead, onKnock, onSaveNote, onClose, dockOffsetPx?, onPeekHeight?,
 *          canManage?, onCentralMark?, onDelete? }  — unchanged from v3.
 * THREE progressive levels (data-snap on [knock-sheet]):
 *   PEEK   — [knock-peek-bar]: one-line address, one status indicator,
 *            freshness cue, ONE primary action (Directions), close.
 *   QUICK  — the default open state, ONE unified action surface: compact
 *            header (ONE status line: label · time · max ONE badge) →
 *            icon-sized utility row [action-directions, action-call (ONLY
 *            with a valid phone), action-copy] → ONE 2-column outcomes grid
 *            [knock-status-grid] with EVERY field disposition in fixed order,
 *            primary four leading (Not Home | Interested / Sold |
 *            Not Interested, then Follow-up, Prospect) → recent line →
 *            flat notes composer. No More section, no nested cards.
 *   DETAILS— [knock-details-body]: premise facts, assignment (lead.assign
 *            only), admin actions (manager central-mark/delete, gated Calling
 *            link), History with scan evidence.
 * Requirements exercised here (testids are the API):
 *   - default open state is QUICK; the handle cycles quick → details → peek;
 *     a status tap saves immediately AND collapses to peek; a prop-driven
 *     status update for the SAME lead never reopens/jumps the card
 *   - the unified grid shows exactly FIELD_OUTCOMES in fixed order with the
 *     primary four leading; the More chrome is gone entirely
 *   - Call renders ONLY when a valid phone exists (tel: link); no phone →
 *     hidden; raw numbers never render
 *   - manager row lives in DETAILS only — hidden for reps everywhere; central
 *     routing disarms after one mark; delete needs a two-tap confirm
 *   - the 350ms tap guard absorbs a double-fire of the same tap
 *   - Notes composer + History contracts unchanged from v3
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

const PRIMARY_KEYS = ["not_home", "interested", "sold", "not_interested"];
const REST_KEYS = FIELD_OUTCOMES.map(o => o.key).filter(k => !PRIMARY_KEYS.includes(k));
const ALL_KEYS = FIELD_OUTCOMES.map(o => o.key);

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

function makeQueryClient() {
  return new QueryClient({
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
}

function renderSheet(overrides: Record<string, any> = {}) {
  const qc = makeQueryClient();
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
  const rerenderSheet = (newProps: Record<string, any>) =>
    view.rerender(
      <QueryClientProvider client={qc}>
        <LeadKnockSheet {...({ ...props, ...newProps } as any)} />
      </QueryClientProvider>,
    );
  return { ...view, props, rerenderSheet, qc };
}

const gridOrder = () =>
  [...screen.getByTestId("knock-status-grid").querySelectorAll("[data-testid^='knock-outcome-']")]
    .map(b => (b as HTMLElement).dataset.testid!.replace("knock-outcome-", ""));

// quick (default) → details via the handle (the keyboard-accessible path).
async function openDetails() {
  await userEvent.click(screen.getByTestId("knock-sheet-handle"));
  expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "details");
}

describe("<LeadKnockSheet /> - three-level model", () => {
  it("QUICK is the default open state for a newly selected lead", () => {
    renderSheet();
    expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "quick");
    // Quick level chrome: utility row + the unified grid are the working surface.
    expect(screen.getByTestId("knock-action-row")).toBeInTheDocument();
    expect(screen.getByTestId("knock-status-grid")).toBeInTheDocument();
    // Details body stays collapsed until the third level.
    expect(screen.getByTestId("knock-details-body")).not.toBeVisible();
  });

  it("the handle cycles quick → details → peek → quick (keyboard-accessible level changes)", async () => {
    renderSheet();
    const handle = screen.getByTestId("knock-sheet-handle");
    await userEvent.click(handle);
    expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "details");
    // Details level: the grid stays in view (all outcomes) and the deep body opens.
    expect(gridOrder()).toEqual(ALL_KEYS);
    expect(screen.getByTestId("knock-details-body")).toBeVisible();
    await userEvent.click(handle);
    expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "peek");
    await userEvent.click(handle);
    expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "quick");
  });

  it("marking a status saves immediately and collapses to Peek", async () => {
    const { props } = renderSheet();
    await userEvent.click(screen.getByTestId("knock-outcome-interested"));
    expect(props.onKnock).toHaveBeenCalledTimes(1);
    expect(props.onKnock).toHaveBeenCalledWith("interested");
    expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "peek");
  });

  it("stays open when the field command is rejected before enqueue", async () => {
    const onKnock = vi.fn(() => false);
    renderSheet({ onKnock });

    await userEvent.click(screen.getByTestId("knock-outcome-interested"));

    expect(onKnock).toHaveBeenCalledWith("interested");
    expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "quick");
  });

  it("stable rendering: a prop-driven status update for the SAME lead never reopens the card", async () => {
    const { props, rerenderSheet } = renderSheet();
    await userEvent.click(screen.getByTestId("knock-outcome-sold"));
    expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "peek");
    // The optimistic round-trip lands: same id, new status — no reopen/jump.
    rerenderSheet({
      lead: baseLead({ leadStatus: "sold", visited: true, lastOutcome: "sold", lastKnockedAt: new Date().toISOString() }),
    });
    expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "peek");
    expect(props.onKnock).toHaveBeenCalledTimes(1);
    // The update is reflected in place (status line + pressed state), not by reopening.
    expect(screen.getByTestId("knock-status-line")).toHaveTextContent("SOLD");
    expect(screen.getByTestId("knock-outcome-sold")).toHaveAttribute("aria-pressed", "true");
  });

  it("selecting a DIFFERENT lead resets to the quick default", async () => {
    const { rerenderSheet } = renderSheet();
    await userEvent.click(screen.getByTestId("knock-sheet-handle")); // → details
    expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "details");
    rerenderSheet({ lead: baseLead({ id: 9, address: "22 Oak Ave" }) });
    expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "quick");
    expect(screen.getByTestId("knock-sheet")).toHaveTextContent("22 Oak Ave");
  });

  it("peek bar: one-line address, one status indicator, freshness cue, ONE primary action, close", async () => {
    const { props } = renderSheet({
      lead: baseLead({ lastOutcome: "not_home", lastKnockedAt: new Date().toISOString(), visited: true }),
    });
    const bar = screen.getByTestId("knock-peek-bar");
    expect(bar).toHaveTextContent("148 Maple St");
    expect(screen.getByTestId("knock-peek-status")).toHaveTextContent("Not Home");
    expect(bar).toHaveTextContent(/Last /); // freshness cue
    expect(screen.getByTestId("peek-action-directions")).toHaveAttribute("href", expect.stringContaining("google.com/maps/dir"));
    await userEvent.click(screen.getByTestId("knock-peek-close"));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("<LeadKnockSheet /> - unified outcomes grid", () => {
  it("ONE grid holds every disposition: primary four lead, the rest follow, fixed order", () => {
    renderSheet();
    expect(screen.getByTestId("knock-sheet")).toHaveTextContent("148 Maple St");
    // Exactly FIELD_OUTCOMES, primary-four-first — one grid, one surface.
    expect(gridOrder()).toEqual(["not_home", "interested", "sold", "not_interested", "already_customer", "follow_up", "prospect"]);
    expect(gridOrder()).toEqual(ALL_KEYS);
    // …and callback / needs_verification are never offered for new marks.
    expect(screen.queryByTestId("knock-outcome-callback")).not.toBeInTheDocument();
    expect(screen.queryByTestId("knock-outcome-needs_verification")).not.toBeInTheDocument();
  });

  it("the More chrome is gone: no toggle, no collapsible section, no second pill area", () => {
    renderSheet();
    expect(screen.queryByTestId("knock-more-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("knock-more-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("knock-details-open")).not.toBeInTheDocument();
    // Every outcome lives in the ONE grid — no outcome button outside it.
    const all = [...document.querySelectorAll("[data-testid^='knock-outcome-']")];
    expect(all.length).toBe(ALL_KEYS.length);
    for (const el of all) {
      expect(screen.getByTestId("knock-status-grid").contains(el)).toBe(true);
    }
  });

  it("a sold door: the Sold cell is pressed IN PLACE (grid order never changes)", () => {
    renderSheet({
      lead: baseLead({ leadStatus: "sold", visited: true, lastOutcome: "sold", lastKnockedAt: new Date().toISOString() }),
    });
    expect(gridOrder()).toEqual(ALL_KEYS);
    expect(screen.getByTestId("knock-outcome-sold")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("knock-status-line")).toHaveTextContent("SOLD");
  });

  it("every outcome is a one-handed tap target (≥44px)", () => {
    renderSheet();
    for (const key of ALL_KEYS) {
      expect(screen.getByTestId(`knock-outcome-${key}`).className).toMatch(/\bh-11\b/);
    }
  });

  it("tapping the primary four fires onKnock immediately with no sub-screen", async () => {
    for (const key of PRIMARY_KEYS) {
      const { props, unmount } = renderSheet();
      await userEvent.click(screen.getByTestId(`knock-outcome-${key}`));
      expect(props.onKnock).toHaveBeenCalledTimes(1);
      expect(props.onKnock).toHaveBeenCalledWith(key);
      // No done phase, no scheduling form.
      expect(screen.getByTestId("knock-status-grid")).toBeInTheDocument();
      expect(screen.queryByTestId("callback-quick-row")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("the remaining outcomes (Follow-up, Prospect) mark through the same one-tap path", async () => {
    for (const key of REST_KEYS) {
      const { props, unmount } = renderSheet();
      await userEvent.click(screen.getByTestId(`knock-outcome-${key}`));
      expect(props.onKnock).toHaveBeenCalledTimes(1);
      expect(props.onKnock).toHaveBeenCalledWith(key);
      unmount();
    }
  });

  it("the active state mirrors the lead: a prospect reset presses the Prospect cell", () => {
    renderSheet({
      lead: baseLead({ leadStatus: "prospect", visited: true, lastOutcome: "prospect", lastKnockedAt: new Date().toISOString() }),
    });
    expect(screen.getByTestId("knock-outcome-prospect")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("knock-outcome-sold")).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps legacy callback history readable without offering a new Callback action", () => {
    renderSheet({
      lead: baseLead({
        leadStatus: "follow_up", visited: true, lastOutcome: "callback",
        lastKnockedAt: new Date().toISOString(),
      }),
    });
    expect(gridOrder()).toEqual(ALL_KEYS); // order is invariant of the active status
    expect(screen.queryByTestId("knock-outcome-callback")).not.toBeInTheDocument();
    expect(screen.getByTestId("knock-status-line")).toHaveTextContent("Callback");
  });
});

describe("<LeadKnockSheet /> - header: one status line, max one badge", () => {
  it("fresh fiber rides the status line as the single badge (no stacked badge rows)", () => {
    renderSheet({ lead: baseLead({ leadTag: "fresh_fiber_confirmed" }) });
    const badges = screen.getAllByTestId("knock-status-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent("Fresh fiber");
    // The badge is INSIDE the one status line, not a stacked row of its own.
    expect(screen.getByTestId("knock-status-line").contains(badges[0])).toBe(true);
  });

  it("a review flag outranks fresh fiber - still exactly one badge", () => {
    renderSheet({ lead: baseLead({ leadStatus: "address_review", leadTag: "fresh_fiber_confirmed" }) });
    const badges = screen.getAllByTestId("knock-status-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent("Needs review");
  });

  it("no badge for an ordinary door", () => {
    renderSheet();
    expect(screen.queryByTestId("knock-status-badge")).not.toBeInTheDocument();
    expect(screen.getByTestId("knock-status-line")).toHaveTextContent("Prospect");
  });
});

describe("<LeadKnockSheet /> - double-submit guard", () => {
  it("a rapid double-fire of the same tap marks ONCE", async () => {
    const { props } = renderSheet();
    const btn = screen.getByTestId("knock-outcome-not_home");
    await userEvent.click(btn);
    await userEvent.click(btn); // within the 350ms guard window
    expect(props.onKnock).toHaveBeenCalledTimes(1);
    expect(props.onKnock).toHaveBeenCalledWith("not_home");
  });
});

describe("<LeadKnockSheet /> - utility row, Call gating", () => {
  it("utility row: Directions (Google, never mapbox) + Copy as icon-sized buttons", () => {
    renderSheet();
    const a = screen.getByTestId("action-directions");
    expect(a).toHaveAttribute("href", expect.stringContaining("google.com/maps/dir"));
    expect(a.getAttribute("href")).toContain("34.9,-79.9");
    expect(a.getAttribute("href")).not.toMatch(/mapbox/i);
    expect(a).toHaveAttribute("aria-label", "Directions");
    // Icon-sized (40px glyph buttons), not competing with the grid.
    // Directions is now a LABELLED pill rather than a bare 40px circle: reps
    // couldn't find an unlabelled arrow sitting between two identical grey
    // circles. Height is still the 40px touch target; the width grows for text.
    expect(a.className).toMatch(/\bh-10\b/);
    expect(a).toHaveTextContent("Directions");
    const copy = screen.getByTestId("action-copy");
    expect(copy).toHaveAttribute("aria-label", "Copy address");
    expect(copy.className).toMatch(/\bh-10\b/);
    expect(screen.queryByTestId("action-text")).not.toBeInTheDocument();
  });

  it("Call is hidden when the lead has no phone", () => {
    const { container } = renderSheet();
    expect(screen.queryByTestId("action-call")).not.toBeInTheDocument();
    expect(container.querySelector('a[href^="tel:"]')).not.toBeInTheDocument();
  });

  it("Call is hidden for a legacy contactPhone field and for invalid numbers", () => {
    const first = renderSheet({ lead: baseLead({ contactPhone: "+1 555 867 5309" }) });
    expect(screen.queryByTestId("action-call")).not.toBeInTheDocument();
    expect(first.container.querySelector('a[href^="tel:"]')).not.toBeInTheDocument();
    expect(first.container).not.toHaveTextContent("555 867 5309");
    first.unmount();

    const second = renderSheet({ lead: baseLead({ phone: "call maybe?" }) });
    expect(screen.queryByTestId("action-call")).not.toBeInTheDocument();
    second.unmount();
  });

  it("Call renders ONLY when a valid phone exists - a tel: link, never the raw number", () => {
    const { container } = renderSheet({ lead: baseLead({ phone: "+1 (555) 867-5309" }) });
    const call = screen.getByTestId("action-call");
    expect(call).toHaveAttribute("href", "tel:+1 (555) 867-5309");
    expect(call).toHaveAttribute("aria-label", "Call this lead");
    expect(container).not.toHaveTextContent("555 867 5309"); // glyph only, no raw number
  });
});

describe("<LeadKnockSheet /> - manager actions (Details only, permission-gated)", () => {
  it("reps never see the manager row - not in quick, not even in Details", async () => {
    renderSheet(); // canManage defaults to false
    expect(screen.queryByTestId("knock-manager-row")).not.toBeInTheDocument();
    await openDetails();
    expect(screen.getByTestId("knock-details-body")).toBeVisible();
    expect(screen.queryByTestId("knock-manager-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("knock-central-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("knock-delete")).not.toBeInTheDocument();
  });

  it("the manager row lives in Details; central mark routes ONE grid tap then disarms", async () => {
    const onCentralMark = vi.fn();
    const { props } = renderSheet({ canManage: true, onCentralMark, onDelete: vi.fn() });
    // Not on the quick surface (mounted with the collapsed Details body, but
    // never visible or interactive there)…
    expect(screen.getByTestId("knock-manager-row")).not.toBeVisible();
    await openDetails();
    expect(screen.getByTestId("knock-manager-row")).toBeVisible();
    await userEvent.click(screen.getByTestId("knock-central-toggle"));
    expect(screen.getByTestId("knock-central-toggle")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByTestId("knock-outcome-not_home"));
    expect(onCentralMark).toHaveBeenCalledTimes(1);
    expect(onCentralMark).toHaveBeenCalledWith("not_home");
    expect(props.onKnock).not.toHaveBeenCalled(); // no rep credit
    // Disarmed: the next mark is a normal knock again. (Wait out the 350ms
    // double-submit guard — a real rep walks to the next door between marks;
    // the card collapsed to Peek after the mark, so re-open it first.)
    await new Promise(r => setTimeout(r, 400));
    await userEvent.click(screen.getByTestId("knock-sheet-handle")); // peek → quick
    await userEvent.click(screen.getByTestId("knock-outcome-interested"));
    expect(props.onKnock).toHaveBeenCalledTimes(1);
    expect(onCentralMark).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed async central mark armed and open for a truthful retry", async () => {
    let resolveMark!: (accepted: boolean) => void;
    const onCentralMark = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveMark = resolve;
    }));
    const { props } = renderSheet({ canManage: true, onCentralMark, onDelete: vi.fn() });
    await openDetails();
    await userEvent.click(screen.getByTestId("knock-central-toggle"));

    void userEvent.click(screen.getByTestId("knock-outcome-not_home"));
    await vi.waitFor(() => expect(onCentralMark).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("knock-central-toggle")).toHaveAttribute("aria-pressed", "true");
    resolveMark(false);
    await vi.waitFor(() =>
      expect(screen.getByTestId("knock-central-toggle")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(props.onKnock).not.toHaveBeenCalled();
    expect(screen.getByTestId("knock-details-body")).toBeVisible();
  });

  it("delete is a two-tap inline confirm in Details", async () => {
    const onDelete = vi.fn();
    renderSheet({ canManage: true, onDelete });
    await openDetails();
    const del = screen.getByTestId("knock-delete");
    await userEvent.click(del); // arms
    expect(onDelete).not.toHaveBeenCalled();
    expect(del).toHaveTextContent("Confirm delete?");
    await userEvent.click(del); // confirms
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  // ── Discoverable per-pin delete (owner report: "each pin usually has delete
  // — I need that"). Delete existed but was a small pill nobody found; it is
  // now a full-width destructive row at the bottom of Details. Same canManage
  // gate, same onDelete handler, same two-step grammar — only discoverability
  // changed. ──
  it("the Delete lead row never renders for a rep, even with a handler wired", async () => {
    renderSheet({ onDelete: vi.fn() }); // canManage defaults to false
    await openDetails();
    expect(screen.queryByTestId("knock-delete")).not.toBeInTheDocument();
  });

  it("reads 'Delete lead' at rest and works on ANY lead - an FCC-imported door included", async () => {
    const onDelete = vi.fn();
    renderSheet({ canManage: true, onDelete, lead: baseLead({ leadTag: "fcc_fresh_block" }) });
    await openDetails();
    const del = screen.getByTestId("knock-delete");
    expect(del).toHaveTextContent("Delete lead");
    await userEvent.click(del);
    await userEvent.click(del);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("an armed delete auto-disarms after 4s - a stale confirm can never fire", () => {
    vi.useFakeTimers();
    try {
      const onDelete = vi.fn();
      renderSheet({ canManage: true, onDelete });
      fireEvent.click(screen.getByTestId("knock-sheet-handle")); // quick → details
      expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "details");
      const del = screen.getByTestId("knock-delete");
      fireEvent.click(del); // arms
      expect(del).toHaveTextContent("Confirm delete?");
      act(() => { vi.advanceTimersByTime(4100); });
      expect(del).toHaveTextContent("Delete lead"); // disarmed
      fireEvent.click(del); // only re-arms — never fires from a cold tap
      expect(onDelete).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("no decorative emojis anywhere in the card copy", async () => {
    renderSheet({ canManage: true, onCentralMark: vi.fn(), onDelete: vi.fn() });
    await openDetails();
    expect(screen.getByTestId("knock-sheet").textContent).not.toMatch(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
    );
  });
});

describe("<LeadKnockSheet /> - notes and history (unchanged model)", () => {
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

  it("history is ONE timeline in Details: actor+verb + right-aligned RELATIVE time, three kinds", async () => {
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

describe("<LeadKnockSheet /> - perceived latency: instant open, instant close", () => {
  // Deferred query client: detail + history promises stay PENDING until flush()
  // — proving the shell never waits on the network.
  function deferredRender(overrides: Record<string, any> = {}) {
    let resolvers: Array<() => void> = [];
    const qc = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          queryFn: ({ queryKey }) =>
            new Promise((resolve) => {
              resolvers.push(() => {
                const key = String(queryKey[0] ?? "");
                resolve(key.endsWith("/history")
                  ? HISTORY
                  : { id: 7, notes: "", updatedAt: "2026-07-08T19:00:00.000Z" });
              });
            }),
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
    const rerenderSheet = (newProps: Record<string, any>) =>
      view.rerender(
        <QueryClientProvider client={qc}>
          <LeadKnockSheet {...({ ...props, ...newProps } as any)} />
        </QueryClientProvider>,
      );
    return { ...view, props, rerenderSheet, flush: () => { resolvers.forEach(r => r()); resolvers = []; } };
  }

  it("renders the FULL shell synchronously while detail + history are still pending", () => {
    deferredRender();
    // No awaits before any of these: the working surface exists on the open
    // frame, built from the pin payload alone.
    const sheet = screen.getByTestId("knock-sheet");
    expect(sheet).toHaveAttribute("data-snap", "quick");
    expect(sheet).toHaveTextContent("148 Maple St");
    expect(screen.getByTestId("knock-address-locality")).toHaveTextContent("Rockwell, NC 28138");
    expect(screen.getByTestId("knock-status-line")).toHaveTextContent("Prospect");
    expect(screen.getByTestId("knock-action-row")).toBeInTheDocument();
    expect(screen.getByTestId("knock-status-grid")).toBeInTheDocument();
    expect(screen.getByTestId("note-add-chip")).toBeInTheDocument();
  });

  it("never shows a sheet-wide spinner - pending history gets a per-section skeleton in Details", async () => {
    const { flush } = deferredRender();
    // Nothing spins anywhere while both queries are pending.
    expect(document.querySelector(".animate-spin")).toBeNull();
    await openDetails();
    expect(document.querySelector(".animate-spin")).toBeNull();
    // The History SECTION shows quiet pulse placeholders inside its own list…
    const list = screen.getByTestId("knock-history-list");
    expect(list.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    // …and the rest of the sheet stays fully interactive around it.
    expect(screen.getByTestId("knock-status-grid")).toBeInTheDocument();
    // Data streams in behind the skeleton once the fetch lands.
    flush();
    const rows = await screen.findAllByTestId(/knock-history-item-/);
    expect(rows).toHaveLength(4);
    expect(list.querySelectorAll(".animate-pulse")).toHaveLength(0);
  });

  it("a status tap works IMMEDIATELY - before any fetch has resolved", async () => {
    const { props } = deferredRender();
    await userEvent.click(screen.getByTestId("knock-outcome-not_home"));
    expect(props.onKnock).toHaveBeenCalledWith("not_home");
    expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "peek");
  });

  it("entry/exit chrome: 200ms GPU transform only - no transition-all, nothing >=300ms", () => {
    deferredRender();
    const cls = screen.getByTestId("knock-sheet").className;
    expect(cls).toMatch(/\btransition-transform\b/);
    expect(cls).toMatch(/\bduration-200\b/);
    expect(cls).toMatch(/\bwill-change-transform\b/);
    expect(cls).not.toMatch(/\btransition-all\b/);
    expect(cls).not.toMatch(/\bduration-3\d\d\b|\bduration-[5-9]\d\d\b/);
  });

  it("close is instant: pointer events drop the moment lead clears, then the sheet unmounts", async () => {
    const { rerenderSheet } = deferredRender();
    rerenderSheet({ lead: null });
    // Same tick as the close: the exit animation may still run, but the map
    // underneath must already receive every tap.
    const sheet = screen.getByTestId("knock-sheet");
    expect(sheet.className).toMatch(/\bpointer-events-none\b/);
    // The shell keeps its content while sliding out (no blank flash)…
    expect(sheet).toHaveTextContent("148 Maple St");
    // …and fully unmounts after the 200ms exit window.
    await waitFor(() => expect(screen.queryByTestId("knock-sheet")).not.toBeInTheDocument());
  });
});

describe("<LeadKnockSheet /> - do-not-knock banner", () => {
  it("renders a prominent alert at the top of the body when the lead is flagged", () => {
    renderSheet({ lead: baseLead({ doNotKnock: 1 }) }); // server sends 0/1
    const banner = screen.getByTestId("dnk-banner");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent("Do not knock - resident asked us not to return");
    // Must read as a hard stop, not a status chip. `destructive` IS that
    // meaning; it used to be spelled `rose`, a raw palette step chosen against
    // the old dark default that landed near 2:1 on the light one.
    expect(banner.className).toMatch(/\bborder-destructive|bg-destructive|text-destructive\b/);
  });

  it("no banner when the flag is absent, falsy, or null (server rollout in flight)", () => {
    for (const doNotKnock of [undefined, false, 0, null]) {
      const view = renderSheet({ lead: baseLead({ doNotKnock }) });
      expect(screen.queryByTestId("dnk-banner")).not.toBeInTheDocument();
      view.unmount();
    }
  });
});

describe("<LeadKnockSheet /> - chrome and lifecycle", () => {
  it("the assign row is capability-gated OFF for reps (fail-closed without lead.assign)", async () => {
    renderSheet(); // test auth context has no user → useCan fails closed
    await openDetails();
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

// ── FCC-reported fiber chip ──────────────────────────────────────────────────
// Any lead whose tag is in the `fcc` family (fcc_fresh_block, fcc_fiber_d25)
// carries the carrier's filing, not a door verification — the card warns the
// rep inline, one amber chip under the status line, no new section.
describe("FCC-reported fiber chip", () => {
  it("renders the amber verify-at-door chip for fcc_fresh_block", () => {
    renderSheet({ lead: baseLead({ leadTag: "fcc_fresh_block" }) });
    const chip = screen.getByTestId("fcc-fiber-chip");
    expect(chip.textContent).toBe("FCC-reported fiber - verify at door");
  });

  it("renders the chip for fcc_fiber_d25 (same fcc family)", () => {
    renderSheet({ lead: baseLead({ leadTag: "fcc_fiber_d25" }) });
    expect(screen.getByTestId("fcc-fiber-chip")).toBeInTheDocument();
  });

  it("does NOT render for non-FCC or untagged leads", () => {
    const view = renderSheet({ lead: baseLead({ leadTag: "fresh_fiber_confirmed" }) });
    expect(screen.queryByTestId("fcc-fiber-chip")).toBeNull();
    view.unmount();
    renderSheet({ lead: baseLead({ leadTag: null }) });
    expect(screen.queryByTestId("fcc-fiber-chip")).toBeNull();
  });

  it("coexists with the single status badge (chip is not a status badge)", () => {
    // fresh_fiber_confirmed would take the badge slot; an FCC tag takes the
    // chip — one inline element each, no stacked badge row.
    renderSheet({ lead: baseLead({ leadTag: "fcc_fresh_block", leadStatus: "address_review" }) });
    expect(screen.getByTestId("knock-status-badge").textContent).toBe("Needs review");
    expect(screen.getByTestId("fcc-fiber-chip")).toBeInTheDocument();
  });
});

// ── Skip-trace contacts ─────────────────────────────────────────────────────
// The contact panel shipped reading `renderedLead.phones`, which comes from the
// map pin payload — and MapPinRow carries no phones or ownerName, by design
// (payload size, and it would broadcast every household's numbers to every
// client). So the panel could never render. Contacts now come from the per-lead
// fetch instead. These tests pin that, and pin the id guard that keeps one
// door's numbers off another door's card.
describe("LeadKnockSheet - traced contacts", () => {
  const DAY = 86_400_000;
  const CONTACTS = {
    id: 7,
    notes: null,
    updatedAt: "2026-07-08T19:00:00.000Z",
    ownerName: "Dana Reyes",
    phones: [
      { number: "+19195550142", lineType: "wireless", confidence: 0.9, dncFlags: {}, scrubbedAtMs: Date.now() - DAY },
      { number: "+19195557788", lineType: "landline", confidence: 0.8, dncFlags: { federalDnc: true }, scrubbedAtMs: Date.now() - DAY },
    ],
  };

  /** Serves the detail payload for ONE lead id, so a mismatch is observable. */
  function renderWithContacts(detailForId: number) {
    const qc = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          queryFn: async ({ queryKey }) => {
            const key = String(queryKey[0] ?? "");
            if (key.endsWith("/history")) return [];
            return { ...CONTACTS, id: detailForId };
          },
        },
      },
    });
    return render(
      <QueryClientProvider client={qc}>
        <LeadKnockSheet
          {...({
            lead: baseLead(), onKnock: vi.fn(), onClose: vi.fn(),
            onSaveNote: vi.fn().mockResolvedValue({ status: "saved" }),
          } as any)}
        />
      </QueryClientProvider>,
    );
  }

  it("renders traced numbers from the per-lead fetch, not the pin payload", async () => {
    renderWithContacts(7);
    expect(await screen.findByTestId("knock-contacts")).toBeInTheDocument();
    expect(screen.getByTestId("lead-phone-+19195550142")).toBeInTheDocument();
  });

  it("shows the traced owner name in the header so the rep knows who to ask for", async () => {
    renderWithContacts(7);
    expect(await screen.findByTestId("knock-owner-name")).toHaveTextContent("Dana Reyes");
  });

  it("makes a clear number tappable and a DNC number inert", async () => {
    const { container } = renderWithContacts(7);
    await screen.findByTestId("knock-contacts");
    expect(screen.getByTestId("lead-phone-+19195550142").tagName).toBe("A");
    expect(screen.getByTestId("lead-phone-+19195557788").closest("a")).toBeNull();
    // One number cleared, one blocked — exactly one dialable link on the door.
    expect(container.querySelectorAll('a[href^="tel:"]')).toHaveLength(1);
  });

  // The guard that matters: a rep must never see the PREVIOUS household's
  // number under this door's address.
  it("renders NO contacts when the detail payload is for a different lead", async () => {
    renderWithContacts(999);
    await screen.findByTestId("knock-status-grid");
    expect(screen.queryByTestId("knock-contacts")).toBeNull();
    expect(screen.queryByTestId("knock-owner-name")).toBeNull();
  });
});
