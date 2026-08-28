import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LeadKnockSheet, UNDO_WINDOW_MS } from "@/components/LeadKnockSheet";
import { FIELD_OUTCOMES } from "@shared/knock";
import { STATUS_CONFIG } from "@shared/statusConfig";
import { outcomeFillTextColor } from "@/components/lead-sheet/OutcomeButton";

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
 *            with a valid phone), distance chip] → ONE disposition surface
 *            [knock-status-grid]: EVERY field disposition as a 44px disc, fixed order,
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
  { id: "k12", type: "status_change", actor: "Muizz Muhammad", changedAt: "2026-07-08T19:12:00.000Z", status: "sold", verification: "verified", distanceM: 12, gpsAccuracyM: 8 },
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
          if (key.endsWith("/photos")) return [];
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
  it("keeps tablet content clear of the persistent sidebar", () => {
    renderSheet();
    expect(screen.getByTestId("knock-sheet").className).toContain("md:left-[264px]");
  });

  it("uses the dark-sheet status override and readable ink for filled outcomes", () => {
    renderSheet();
    // Idle disc: the CODE beneath reads in the dark-sheet-legible status colour.
    const soldCode = screen.getByTestId("knock-outcome-sold").querySelector("span:last-child") as HTMLElement;
    expect(soldCode).toHaveTextContent("SOLD");
    expect(soldCode).toHaveStyle({ color: STATUS_CONFIG.sold.onDark });
    // The active disc (default lead is an unworked prospect): the disc wears
    // the status fill with the white pin glyph; the code label goes white.
    const prospectDisc = screen.getByTestId("knock-outcome-prospect");
    expect(prospectDisc).toHaveAttribute("aria-pressed", "true");
    expect(prospectDisc.querySelector("svg")).not.toBeNull();
    expect(outcomeFillTextColor(STATUS_CONFIG.prospect.color)).toBe("#07111B");
    expect(outcomeFillTextColor(STATUS_CONFIG.interested.color)).toBe("#07111B");
    expect(screen.getByTestId("knock-outcome-interested").querySelector("svg")).not.toBeNull();
  });

  it("ONE surface holds every disposition as the same disc, fixed order, no strip, no rectangular cells", () => {
    renderSheet();
    expect(screen.getByTestId("knock-sheet")).toHaveTextContent("148 Maple St");
    // Exactly FIELD_OUTCOMES, verbatim — the four most likely reads lead.
    expect(gridOrder()).toEqual([
      "not_home", "interested", "sold", "not_interested",
      "follow_up", "go_back", "already_customer",
      "competitor", "renter", "moving", "no_soliciting", "prospect",
    ]);
    expect(gridOrder()).toEqual(ALL_KEYS);
    // Owner call 2026-08-22: every disposition is a circle. No second tier.
    expect(screen.queryByTestId("knock-status-strip")).not.toBeInTheDocument();
    const grid = screen.getByTestId("knock-status-grid");
    expect(grid).toHaveAttribute("role", "group");
    expect(grid.className).toMatch(/\bgrid-cols-6\b/);
    for (const o of FIELD_OUTCOMES) {
      const disc = screen.getByTestId(`knock-outcome-${o.key}`);
      expect(grid.contains(disc)).toBe(true);
      expect(disc.querySelector(".w-11.h-11.rounded-full")).not.toBeNull();
      expect(disc).toHaveTextContent(o.short);
      expect(disc).toHaveAccessibleName(o.label);
    }
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
      const btn = screen.getByTestId(`knock-outcome-${key}`);
      // Grid cells are h-11 buttons; strip discs carry a 44px (w-11 h-11) disc
      // inside the button, so both forms meet the touch floor.
      const meets = /\bh-11\b/.test(btn.className) || btn.querySelector(".w-11.h-11") != null;
      expect(meets, `${key} misses the 44px touch floor`).toBe(true);
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
  it("action row: Directions (Google, never mapbox) as the 44px primary; the duplicate copy circle is gone", () => {
    renderSheet();
    const a = screen.getByTestId("action-directions");
    expect(a).toHaveAttribute("href", expect.stringContaining("google.com/maps/dir"));
    expect(a.getAttribute("href")).toContain("34.9,-79.9");
    expect(a.getAttribute("href")).not.toMatch(/mapbox/i);
    expect(a).toHaveAttribute("aria-label", "Directions");
    // A labelled 44px pill that takes the row's width: the one thing a rep on a
    // sidewalk needs instantly. Text only (no decorative glyph).
    expect(a.className).toMatch(/\bh-11\b/);
    expect(a.className).toMatch(/\bflex-1\b/);
    expect(a).toHaveTextContent("Directions");
    expect(a.querySelector("svg")).toBeNull();
    // ONE copy control on the card: the header disc. No second copy button.
    expect(screen.queryByTestId("action-copy")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Copy address" })).toHaveLength(1);
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

describe("<LeadKnockSheet /> - where they stood", () => {
  it("a verified history row opens its distance diagram on demand, one row at a time", async () => {
    renderSheet();
    const rows = await screen.findAllByTestId(/knock-history-item-/);
    expect(rows.length).toBeGreaterThan(0);
    const where = screen.getAllByTestId(/history-where-/);
    // Only rows that carry a measured distance offer it.
    expect(where.length).toBeGreaterThan(0);
    expect(where.length).toBeLessThanOrEqual(rows.length);
    expect(screen.queryByTestId("distance-diagram")).not.toBeInTheDocument();
    await userEvent.click(where[0]);
    expect(where[0]).toHaveAttribute("aria-expanded", "true");
    expect(where[0]).toHaveTextContent("Hide");
    expect(screen.getAllByTestId("distance-diagram")).toHaveLength(1);
    await userEvent.click(where[0]);
    expect(screen.queryByTestId("distance-diagram")).not.toBeInTheDocument();
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
  it("renders a prominent alert and blocks every field outcome when the lead is flagged", async () => {
    const { props } = renderSheet({ lead: baseLead({ doNotKnock: 1 }) }); // server sends 0/1
    const banner = screen.getByTestId("dnk-banner");
    expect(banner).toHaveAttribute("role", "alert");
    expect(banner).toHaveTextContent("Do not knock - resident asked us not to return");
    // Must read as a hard stop, not a status chip. `destructive` IS that
    // meaning; it used to be spelled `rose`, a raw palette step chosen against
    // the old dark default that landed near 2:1 on the light one.
    expect(banner.className).toMatch(/\bborder-destructive|bg-destructive|text-destructive\b/);
    for (const outcome of FIELD_OUTCOMES) {
      expect(screen.getByTestId(`knock-outcome-${outcome.key}`)).toBeDisabled();
    }
    expect(screen.getByText(/outcome logging is blocked/i)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("knock-outcome-sold"));
    expect(props.onKnock).not.toHaveBeenCalled();
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
  it("focuses the modeless sheet, restores the trigger on close, and keeps quick actions scrollable", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open lead";
    document.body.appendChild(trigger);
    trigger.focus();
    try {
      const { rerenderSheet } = renderSheet();
      const sheet = screen.getByTestId("knock-sheet");
      await waitFor(() => expect(sheet).toHaveFocus());
      expect(screen.getByTestId("knock-sheet-body").className).toContain("overflow-y-auto");

      rerenderSheet({ lead: null });
      await waitFor(() => expect(trigger).toHaveFocus());
    } finally {
      trigger.remove();
    }
  });

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

describe("<LeadKnockSheet /> - competition dispositions (strip)", () => {
  it("each strip disposition marks through the same one-tap path", async () => {
    for (const key of ["competitor", "renter", "moving", "no_soliciting", "go_back"]) {
      const { props, unmount } = renderSheet();
      await userEvent.click(screen.getByTestId(`knock-outcome-${key}`));
      expect(props.onKnock).toHaveBeenCalledTimes(1);
      expect(props.onKnock).toHaveBeenCalledWith(key);
      expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "peek");
      unmount();
    }
  });

  it("a competitor door presses the COMP disc in place and says Competitor on the status line", () => {
    renderSheet({
      lead: baseLead({
        leadStatus: "not_interested", visited: true, lastOutcome: "competitor",
        lastKnockedAt: new Date().toISOString(),
      }),
    });
    expect(screen.getByTestId("knock-outcome-competitor")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("knock-outcome-not_interested")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("knock-status-line")).toHaveTextContent("Competitor");
  });

  it("a go-back door presses GB, not Follow-up, though both store follow_up", () => {
    renderSheet({
      lead: baseLead({
        leadStatus: "follow_up", visited: true, lastOutcome: "go_back",
        lastKnockedAt: new Date().toISOString(),
      }),
    });
    expect(screen.getByTestId("knock-outcome-go_back")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("knock-outcome-follow_up")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("knock-status-line")).toHaveTextContent("Go Back");
  });
});

describe("<LeadKnockSheet /> - appointment composer", () => {
  it("collapsed chip → editor; Set stays disabled until a date is picked", async () => {
    renderSheet();
    expect(screen.queryByTestId("appt-editor")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("appt-open"));
    expect(screen.getByTestId("appt-editor")).toBeInTheDocument();
    expect(screen.getByTestId("appt-save")).toBeDisabled();
  });

  it("confirming logs ONE follow-up knock carrying the chosen date and time, then collapses to Peek", async () => {
    const { props } = renderSheet();
    await userEvent.click(screen.getByTestId("appt-open"));
    fireEvent.change(screen.getByTestId("appt-date"), { target: { value: "2026-08-29" } });
    fireEvent.change(screen.getByTestId("appt-time"), { target: { value: "18:30" } });
    await userEvent.click(screen.getByTestId("appt-save"));
    expect(props.onKnock).toHaveBeenCalledTimes(1);
    expect(props.onKnock).toHaveBeenCalledWith("follow_up", { callbackDate: "2026-08-29", callbackTime: "18:30" });
    await waitFor(() =>
      expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "peek"));
  });

  it("time is optional - a date alone schedules with callbackTime null", async () => {
    const { props } = renderSheet();
    await userEvent.click(screen.getByTestId("appt-open"));
    fireEvent.change(screen.getByTestId("appt-date"), { target: { value: "2026-08-29" } });
    await userEvent.click(screen.getByTestId("appt-save"));
    expect(props.onKnock).toHaveBeenCalledWith("follow_up", { callbackDate: "2026-08-29", callbackTime: null });
  });

  it("a Go Back door keeps its GB disposition when an appointment is added", async () => {
    const { props } = renderSheet({
      lead: baseLead({
        leadStatus: "follow_up", visited: true, lastOutcome: "go_back",
        lastKnockedAt: new Date().toISOString(),
      }),
    });
    await userEvent.click(screen.getByTestId("appt-open"));
    fireEvent.change(screen.getByTestId("appt-date"), { target: { value: "2026-08-29" } });
    await userEvent.click(screen.getByTestId("appt-save"));
    expect(props.onKnock).toHaveBeenCalledWith("go_back", { callbackDate: "2026-08-29", callbackTime: null });
  });

  it("a rejected command keeps the editor open with the picked values intact", async () => {
    renderSheet({ onKnock: vi.fn(() => false) });
    await userEvent.click(screen.getByTestId("appt-open"));
    fireEvent.change(screen.getByTestId("appt-date"), { target: { value: "2026-08-29" } });
    await userEvent.click(screen.getByTestId("appt-save"));
    expect(screen.getByTestId("appt-editor")).toBeInTheDocument();
    expect(screen.getByTestId("appt-date")).toHaveValue("2026-08-29");
    expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "quick");
  });

  it("no appointment affordance on a do-not-knock door - an appointment IS a knock", () => {
    renderSheet({ lead: baseLead({ doNotKnock: 1 }) });
    expect(screen.queryByTestId("knock-appointment")).not.toBeInTheDocument();
  });
});

describe("<LeadKnockSheet /> - undo the last mark", () => {
  it("a fresh door marked Not Home offers Undo; Undo puts it back to Prospect through the knock path", async () => {
    const { props } = renderSheet();
    expect(screen.queryByTestId("knock-undo")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("knock-outcome-not_home"));
    expect(props.onKnock).toHaveBeenCalledTimes(1);
    // The card collapsed to Peek, and the status line there carries Undo.
    const undo = await screen.findByTestId("knock-undo");
    expect(undo).toHaveAccessibleName(/put the door back to Prospect/);
    await userEvent.click(undo);
    expect(props.onKnock).toHaveBeenCalledTimes(2);
    expect(props.onKnock).toHaveBeenLastCalledWith("prospect");
    expect(screen.queryByTestId("knock-undo")).not.toBeInTheDocument();
  });

  it("returns to the disposition the door actually had, not always Prospect", async () => {
    const { props } = renderSheet({
      lead: baseLead({ leadStatus: "interested", visited: true, lastOutcome: "interested", lastKnockedAt: new Date().toISOString() }),
    });
    await userEvent.click(screen.getByTestId("knock-outcome-not_home"));
    await userEvent.click(await screen.findByTestId("knock-undo"));
    expect(props.onKnock).toHaveBeenLastCalledWith("interested");
  });

  it("does not arm for a rejected command", async () => {
    renderSheet({ onKnock: vi.fn(() => false) });
    await userEvent.click(screen.getByTestId("knock-outcome-not_home"));
    expect(screen.queryByTestId("knock-undo")).not.toBeInTheDocument();
  });

  it("does not arm for an appointment: a scheduled visit is deliberate, not a slip", async () => {
    renderSheet();
    await userEvent.click(screen.getByTestId("appt-open"));
    fireEvent.change(screen.getByTestId("appt-date"), { target: { value: "2026-08-29" } });
    await userEvent.click(screen.getByTestId("appt-save"));
    await waitFor(() => expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "peek"));
    expect(screen.queryByTestId("knock-undo")).not.toBeInTheDocument();
  });

  it("clears when the card swaps to another door", async () => {
    const { rerenderSheet } = renderSheet();
    await userEvent.click(screen.getByTestId("knock-outcome-interested"));
    expect(await screen.findByTestId("knock-undo")).toBeInTheDocument();
    rerenderSheet({ lead: baseLead({ id: 8, address: "150 Maple St" }) });
    expect(screen.queryByTestId("knock-undo")).not.toBeInTheDocument();
  });

  it("expires after the undo window", async () => {
    vi.useFakeTimers();
    try {
      renderSheet();
      fireEvent.click(screen.getByTestId("knock-outcome-not_home"));
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByTestId("knock-undo")).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(UNDO_WINDOW_MS + 50); });
      expect(screen.queryByTestId("knock-undo")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("<LeadKnockSheet /> - quick appointment slots", () => {
  it("offers one-tap times; a tap fills the pickers and names the booking on Set, Set still confirms", async () => {
    const { props } = renderSheet();
    await userEvent.click(screen.getByTestId("appt-open"));
    const slots = screen.getByTestId("appt-slots");
    const chips = Array.from(slots.querySelectorAll("button"));
    // Three or four chips: "today" drops out after working hours.
    expect(chips.length).toBeGreaterThanOrEqual(3);
    expect(chips.length).toBeLessThanOrEqual(4);
    expect(props.onKnock).not.toHaveBeenCalled();
    // Pick the chip BY LABEL, never by index. "Tomorrow 10 AM" is always
    // offered but it is only slot-1 while the Today chip is still there, and
    // Today drops out after close - so an index made this assertion pass in the
    // afternoon and fail in CI at 19:21 UTC.
    const tomorrowChip = chips.find((c) => /^Tomorrow /i.test(c.textContent ?? ""))!;
    expect(tomorrowChip, "a Tomorrow chip is always offered").toBeTruthy();
    await userEvent.click(tomorrowChip);
    expect(tomorrowChip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("appt-time")).toHaveValue("10:00");
    expect(screen.getByTestId("appt-date")).not.toHaveValue("");
    expect(screen.getByTestId("appt-save")).toHaveTextContent("Set for tomorrow 10 AM");
    // Nothing is logged until Set.
    expect(props.onKnock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("appt-save"));
    expect(props.onKnock).toHaveBeenCalledTimes(1);
    const [outcome, opts] = props.onKnock.mock.calls[0];
    expect(outcome).toBe("follow_up");
    expect(opts.callbackTime).toBe("10:00");
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const iso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
    expect(opts.callbackDate).toBe(iso);
  });

  it("editing the time by hand un-presses the chip, so a chip only ever claims an exact match", async () => {
    renderSheet();
    await userEvent.click(screen.getByTestId("appt-open"));
    const chip = Array.from(screen.getByTestId("appt-slots").querySelectorAll("button"))
      .find((c) => /^Tomorrow /i.test(c.textContent ?? ""))!;
    await userEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByTestId("appt-time"), { target: { value: "11:15" } });
    expect(chip).toHaveAttribute("aria-pressed", "false");
  });
});

describe("<LeadKnockSheet /> - proximity chip", () => {
  function stubGeolocation(coords: { latitude: number; longitude: number; accuracy: number } | null) {
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: coords == null ? undefined : {
        getCurrentPosition: (ok: PositionCallback) =>
          ok({ coords, timestamp: Date.now() } as GeolocationPosition),
      },
    });
  }
  const clearGeolocation = () =>
    Object.defineProperty(navigator, "geolocation", { configurable: true, value: undefined });

  it("shows the live distance to this door and 'At door' inside 60 m", async () => {
    // baseLead sits at (34.9, -79.9); the fix is right on the doorstep.
    stubGeolocation({ latitude: 34.9, longitude: -79.9, accuracy: 12 });
    try {
      renderSheet();
      const chip = await screen.findByTestId("knock-proximity");
      expect(chip).toHaveTextContent("At door");
    } finally { clearGeolocation(); }
  });

  it("far from the door it reads an honest distance hint", async () => {
    // ~1,112 m north of the lead → "0.7mi".
    stubGeolocation({ latitude: 34.91, longitude: -79.9, accuracy: 12 });
    try {
      renderSheet();
      const chip = await screen.findByTestId("knock-proximity");
      expect(chip).toHaveTextContent("0.7mi");
      expect(chip).not.toHaveTextContent("At door");
    } finally { clearGeolocation(); }
  });

  it("renders NOTHING without GPS, and NOTHING when the fix is too loose to be honest", async () => {
    stubGeolocation(null); // no geolocation API at all
    try {
      const { unmount } = renderSheet();
      await screen.findByTestId("knock-status-grid");
      expect(screen.queryByTestId("knock-proximity")).not.toBeInTheDocument();
      unmount();
    } finally { clearGeolocation(); }

    stubGeolocation({ latitude: 34.9, longitude: -79.9, accuracy: 900 }); // ±900 m fix
    try {
      renderSheet();
      await screen.findByTestId("knock-status-grid");
      // Give the capture a tick to land, then confirm the chip stayed away.
      await act(() => new Promise(r => setTimeout(r, 30)));
      expect(screen.queryByTestId("knock-proximity")).not.toBeInTheDocument();
    } finally { clearGeolocation(); }
  });
});

describe("<LeadKnockSheet /> - details: contact, quick links, photos", () => {
  it("details level carries the contact section, quick links, and the photo strip", async () => {
    renderSheet();
    await openDetails();
    await screen.findByTestId("knock-contact-section");
    expect(screen.getByTestId("knock-quick-links")).toBeInTheDocument();
    expect(screen.getByTestId("knock-photos")).toBeInTheDocument();
  });

  it("quick links deep-link THIS address and open in a new tab", async () => {
    renderSheet();
    await openDetails();
    const sv = screen.getByTestId("quick-link-streetview");
    expect(sv).toHaveAttribute("href", expect.stringContaining("map_action=pano"));
    expect(sv).toHaveAttribute("href", expect.stringContaining("34.9,-79.9"));
    expect(sv).toHaveAttribute("target", "_blank");
    expect(sv).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.getByTestId("quick-link-zillow")).toHaveAttribute(
      "href", expect.stringContaining(encodeURIComponent("148 Maple St")));
    expect(screen.getByTestId("quick-link-fcc")).toHaveAttribute(
      "href", expect.stringContaining("broadbandmap.fcc.gov"));
  });

  it("street view hides without coordinates - never a dead link", async () => {
    renderSheet({ lead: baseLead({ lat: null, lng: null }) });
    await openDetails();
    expect(screen.queryByTestId("quick-link-streetview")).not.toBeInTheDocument();
    expect(screen.getByTestId("quick-link-zillow")).toBeInTheDocument();
  });

  it("contact: Add → editor → save PATCHes name+email and never offers a phone field", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    // @ts-expect-error test stub
    global.fetch = vi.fn(async (url: any, init: any) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null });
      if (u.includes("/photos")) return new Response(JSON.stringify([]), { status: 200 });
      if (u.includes("/contact")) {
        return new Response(JSON.stringify({ id: 7, contactName: "Dana Reyes", contactEmail: "dana@x.com" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 7, notes: "", updatedAt: "2026-07-08T19:00:00.000Z" }), { status: 200 });
    });
    renderSheet();
    await openDetails();
    await userEvent.click(await screen.findByTestId("contact-add"));
    // No phone input anywhere in the editor - numbers live in Calling.
    expect(screen.getByTestId("contact-editor").querySelector('input[type="tel"]')).toBeNull();
    expect(screen.getByTestId("contact-editor")).toHaveTextContent(/Calling/);
    await userEvent.type(screen.getByTestId("contact-name-input"), "Dana Reyes");
    await userEvent.type(screen.getByTestId("contact-email-input"), "dana@x.com");
    await userEvent.click(screen.getByTestId("contact-save"));
    await waitFor(() => {
      const patch = calls.find(c => c.url.includes("/api/leads/7/contact"));
      expect(patch).toBeTruthy();
      expect(patch!.body).toEqual({ contactName: "Dana Reyes", contactEmail: "dana@x.com" });
    });
  });

  it("a captured contact name wins the header's Ask-for line over the traced owner", async () => {
    const qc = makeQueryClient();
    qc.setQueryData(["/api/leads/7"], {
      id: 7, notes: "", updatedAt: "2026-07-08T19:00:00.000Z",
      ownerName: "TRACED OWNER", contactName: "Dana Reyes",
    });
    render(
      <QueryClientProvider client={qc}>
        <LeadKnockSheet lead={baseLead() as any} onKnock={vi.fn()} onSaveNote={vi.fn().mockResolvedValue({ status: "saved", updatedAt: "x" })} onClose={vi.fn()} />
      </QueryClientProvider>,
    );
    const who = await screen.findByTestId("knock-owner-name");
    expect(who).toHaveTextContent(/Dana Reyes/);
    expect(who).not.toHaveTextContent(/TRACED OWNER/);
  });
});

describe("<LeadKnockSheet /> - drag regions never capture a tap", () => {
  // The header, peek bar and handle are drag regions. Capturing the pointer on
  // pointerdown retargets the pointerup AND the compatibility click to the
  // region, so the close / copy buttons inside it never received a mouse or
  // trackpad click (touch only survived because a tap's click is synthesized
  // from the gesture). Reproduced in Chromium 2026-08-22: mouse clicks on
  // knock-sheet-close / knock-copy-address / knock-peek-close all landed on
  // knock-sheet instead. Capture must wait for a real drag.
  function withCaptureSpy<T>(run: (spy: ReturnType<typeof vi.fn>) => T): T {
    const proto = Element.prototype as any;
    const original = proto.setPointerCapture;
    const spy = vi.fn();
    proto.setPointerCapture = spy;
    try { return run(spy); } finally { proto.setPointerCapture = original; }
  }
  // jsdom has no PointerEvent: a MouseEvent carries the coordinates and the
  // pointer fields are pinned on top (React reads them off the native event).
  const pointer = (el: Element, type: string, clientY: number, extra: Record<string, unknown> = {}) => {
    // A press or a move with the button held carries buttons=1; pointerup has 0.
    const buttons = type === "pointerup" ? 0 : 1;
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 300, clientY, buttons });
    for (const [k, v] of Object.entries({ pointerId: 1, isPrimary: true, pointerType: "mouse", ...extra })) {
      Object.defineProperty(ev, k, { value: v });
    }
    return fireEvent(el, ev);
  };

  it("a press on the close button does NOT capture the pointer, so its click still lands", () => {
    withCaptureSpy((spy) => {
      const { props } = renderSheet();
      const close = screen.getByTestId("knock-sheet-close");
      pointer(close, "pointerdown", 500);
      expect(spy).not.toHaveBeenCalled();
      pointer(close, "pointerup", 500);
      fireEvent.click(close);
      expect(props.onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("a press on the header copy button does NOT capture the pointer", () => {
    withCaptureSpy((spy) => {
      renderSheet();
      const copy = screen.getByTestId("knock-copy-address");
      pointer(copy, "pointerdown", 500);
      pointer(copy, "pointermove", 502); // inside the tap slop
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it("a press that ends off the region never becomes a hover drag: a buttonless move is dropped", () => {
    withCaptureSpy((spy) => {
      const { props } = renderSheet();
      const header = screen.getByTestId("knock-sheet-close").closest("[data-drag-region]") as HTMLElement;
      pointer(header, "pointerdown", 500);
      // The release happened off the region (never seen); the next thing the
      // region sees is a hover move with no button held, 80px away.
      pointer(header, "pointermove", 580, { buttons: 0 });
      expect(spy).not.toHaveBeenCalled();
      expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "quick");
      // And the stale press is gone: a real tap on the close button still lands.
      pointer(screen.getByTestId("knock-sheet-close"), "pointerdown", 500);
      pointer(screen.getByTestId("knock-sheet-close"), "pointerup", 500);
      fireEvent.click(screen.getByTestId("knock-sheet-close"));
      expect(props.onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("a right-click never starts a press", () => {
    withCaptureSpy((spy) => {
      renderSheet();
      const header = screen.getByTestId("knock-sheet-close").closest("[data-drag-region]") as HTMLElement;
      pointer(header, "pointerdown", 500, { button: 2 });
      pointer(header, "pointermove", 560, { button: 2, buttons: 2 });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it("after a touch drag (no click follows) the next tap on a region button is NOT swallowed", async () => {
    const { props } = renderSheet();
    const close = screen.getByTestId("knock-sheet-close");
    withCaptureSpy(() => {
      pointer(close, "pointerdown", 500, { pointerType: "touch" });
      pointer(close, "pointermove", 560, { pointerType: "touch" });
      pointer(close, "pointerup", 560, { pointerType: "touch" });
    });
    // No click arrives after a touch drag. The rep taps again a moment later.
    await new Promise<void>(resolve => setTimeout(resolve, 80));
    fireEvent.click(close);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  // ── The phone bug ─────────────────────────────────────────────────────────
  // A mouse click moves 0-1px. A thumb tap on a phone routinely drifts 6-10px,
  // and at TAP_SLOP_PX=6 every one of those promoted the press to a sheet drag,
  // which armed suppressClick, which ate the click in the CAPTURE phase. The
  // copy handler never ran: "the address is not copying on my phone", with the
  // desktop working perfectly the whole time. Two independent guards now, and
  // one test for each so a regression in either is named precisely.
  it("PHONE: a copy tap whose finger drifts 8px still copies (a press on a control never drags the sheet)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    withCaptureSpy((spy) => {
      renderSheet();
      const copy = screen.getByTestId("knock-copy-address");
      pointer(copy, "pointerdown", 500, { pointerType: "touch" });
      pointer(copy, "pointermove", 508, { pointerType: "touch" }); // thumb wobble
      pointer(copy, "pointerup", 508, { pointerType: "touch" });
      // The press never became a drag, so nothing was captured and nothing is
      // armed to swallow the click.
      expect(spy).not.toHaveBeenCalled();
      fireEvent.click(copy);
    });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("148 Maple St, Rockwell, NC 28138"));
  });

  it("PHONE: a close tap that drifts 8px still closes", () => {
    withCaptureSpy(() => {
      const { props } = renderSheet();
      const close = screen.getByTestId("knock-sheet-close");
      pointer(close, "pointerdown", 500, { pointerType: "touch" });
      pointer(close, "pointermove", 508, { pointerType: "touch" });
      pointer(close, "pointerup", 508, { pointerType: "touch" });
      fireEvent.click(close);
      expect(props.onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("PHONE: touch gets a bigger slop than a mouse, so a wobbly handle tap still cycles the level", () => {
    withCaptureSpy((spy) => {
      renderSheet();
      const handle = screen.getByTestId("knock-sheet-handle");
      // The handle opts back IN to dragging (data-drag-handle) - it is the
      // primary drag affordance - so only the touch slop protects its tap.
      pointer(handle, "pointerdown", 500, { pointerType: "touch" });
      pointer(handle, "pointermove", 510, { pointerType: "touch" }); // 10px: a wobble, not a drag
      expect(spy).not.toHaveBeenCalled();
      // The same 10px from a MOUSE is a deliberate drag and still captures.
      pointer(handle, "pointerup", 510, { pointerType: "touch" });
      pointer(handle, "pointerdown", 500, { pointerType: "mouse", pointerId: 2 });
      pointer(handle, "pointermove", 510, { pointerType: "mouse", pointerId: 2 });
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it("the header itself still drags: only CONTROLS are exempt, not the whole region", () => {
    withCaptureSpy((spy) => {
      renderSheet();
      // The address line is chrome, not a control - dragging from it must work.
      const header = screen.getByTestId("knock-status-line");
      pointer(header, "pointerdown", 500, { pointerType: "touch" });
      pointer(header, "pointermove", 560, { pointerType: "touch" });
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // ── The second half of the phone bug ──────────────────────────────────────
  // Guarding the drag was not enough. A browser only synthesizes a click from a
  // touch while the finger stays inside ITS own slop (~8px in Chromium); drift
  // further and the gesture is reclassified as a pan. These discs sit in a
  // `touch-action: none` region, so there is nothing to pan and the tap simply
  // evaporates - no click, no scroll, no feedback. Measured against the running
  // app at 390x844 (verify-copy-phone.mjs): a 16px drift delivered
  // `pointerdown touchstart pointerup touchend` to the Copy disc and no click,
  // and the clipboard kept its previous contents. The discs act on pointerup
  // now, so NONE of these cases fire a click at all.
  it("PHONE: a 16px drift copies even though the browser never sends a click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderSheet();
    const copy = screen.getByTestId("knock-copy-address");
    pointer(copy, "pointerdown", 500, { pointerType: "touch" });
    pointer(copy, "pointerup", 516, { pointerType: "touch" }); // no click follows
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("148 Maple St, Rockwell, NC 28138"));
  });

  it("PHONE: a 16px drift on the close disc still closes, with no click", () => {
    const { props } = renderSheet();
    const close = screen.getByTestId("knock-sheet-close");
    pointer(close, "pointerdown", 500, { pointerType: "touch" });
    pointer(close, "pointerup", 516, { pointerType: "touch" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  // A deliberate swipe is not a tap. The generous slop buys a drifting thumb,
  // not every gesture that happens to start on the disc.
  it("a swipe across the copy disc does not copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderSheet();
    const copy = screen.getByTestId("knock-copy-address");
    pointer(copy, "pointerdown", 500, { pointerType: "touch" });
    pointer(copy, "pointerup", 560, { pointerType: "touch" });
    await Promise.resolve();
    expect(writeText).not.toHaveBeenCalled();
  });

  // Acting on pointerup AND on click would copy twice per tap. The compat click
  // that follows a successful touch has to be swallowed - and a real mouse or
  // keyboard click, which sends no touch pointer at all, must still work.
  it("copies exactly once per tap, by touch and by mouse", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderSheet();
    const copy = screen.getByTestId("knock-copy-address");

    pointer(copy, "pointerdown", 500, { pointerType: "touch" });
    pointer(copy, "pointerup", 502, { pointerType: "touch" });
    fireEvent.click(copy); // the browser's compatibility click
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    pointer(copy, "pointerdown", 500);
    pointer(copy, "pointerup", 500);
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
  });

  // Long-press-to-select is how everybody copies an address on a phone. The
  // drag region switches selection off wholesale; the address opts back in.
  it("the address text stays selectable inside the drag region", () => {
    renderSheet();
    expect(screen.getByTestId("knock-address")).toHaveStyle({ userSelect: "text" });
  });

  it("a real drag (past the tap slop) DOES capture, and its click is swallowed", () => {
    withCaptureSpy((spy) => {
      const { props } = renderSheet();
      // Dragged from the header CHROME, not from a button. A press that starts
      // on a control no longer drags the sheet at all (see the PHONE cases
      // above), so the drag has to begin somewhere a drag can begin - and the
      // invariant under test is unchanged: once a real drag happens, the click
      // it produces must not activate whatever the pointer is over.
      const chrome = screen.getByTestId("knock-status-line");
      pointer(chrome, "pointerdown", 500);
      pointer(chrome, "pointermove", 540); // 40px: a drag, not a tap
      expect(spy).toHaveBeenCalledTimes(1);
      pointer(chrome, "pointerup", 540);
      fireEvent.click(screen.getByTestId("knock-sheet-close"));
      expect(props.onClose).not.toHaveBeenCalled();
    });
  });

  it("a press on a control never drags the sheet, however far the finger travels", () => {
    withCaptureSpy((spy) => {
      const { props } = renderSheet();
      const close = screen.getByTestId("knock-sheet-close");
      pointer(close, "pointerdown", 500);
      pointer(close, "pointermove", 540); // 40px from a BUTTON: still not a drag
      expect(spy).not.toHaveBeenCalled();
      expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "quick");
      pointer(close, "pointerup", 540);
      fireEvent.click(close);
      expect(props.onClose).toHaveBeenCalledTimes(1);
    });
  });
});

describe("<LeadKnockSheet /> - door card v2: header chip, copy feedback, facts", () => {
  it("the header carries the status PIN chip (pin fill + the pin's glyph), not a bare dot", () => {
    renderSheet({
      lead: baseLead({ leadStatus: "interested", visited: true, lastOutcome: "interested", lastKnockedAt: new Date().toISOString() }),
    });
    const chip = screen.getByTestId("knock-status-dot");
    expect(chip).toHaveStyle({ background: STATUS_CONFIG.interested.color });
    expect(chip.querySelector("svg[data-testid='knock-status-icon']")).not.toBeNull();
    // The status LINE keeps the words; the glyph lives on the chip.
    expect(screen.getByTestId("knock-status-line")).toHaveTextContent("Interested");
    expect(screen.getByTestId("knock-status-line").querySelector("svg")).toBeNull();
  });

  it("copy: the disc confirms with a check and the locality line reads Address copied, then returns", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      renderSheet();
      expect(screen.getByTestId("knock-address-locality")).toHaveTextContent("Rockwell, NC 28138");
      await userEvent.click(screen.getByTestId("knock-copy-address"));
      expect(writeText).toHaveBeenCalledWith("148 Maple St, Rockwell, NC 28138");
      expect(screen.getByTestId("knock-address-copied")).toHaveTextContent("Address copied");
      expect(screen.getByTestId("knock-copy-address")).toHaveAccessibleName("Address copied");
      // The address line itself never moved: the feedback replaced the locality.
      expect(screen.queryByTestId("knock-address-locality")).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByTestId("knock-address-locality")).toBeInTheDocument(), { timeout: 2500 });
      expect(screen.getByTestId("knock-copy-address")).toHaveAccessibleName("Copy address");
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    }
  });

  it("copy still works without the Clipboard API (plain http): the execCommand fallback runs", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const seen: string[] = [];
    const exec = vi.fn((cmd: string) => { if (cmd === "copy") seen.push((document.body.lastElementChild as HTMLTextAreaElement).value); return true; });
    (document as any).execCommand = exec;
    try {
      renderSheet();
      await userEvent.click(screen.getByTestId("knock-copy-address"));
      await waitFor(() => expect(screen.getByTestId("knock-address-copied")).toBeInTheDocument());
      expect(seen).toEqual(["148 Maple St, Rockwell, NC 28138"]);
    } finally {
      delete (document as any).execCommand;
    }
  });

  function renderWithDetail(detail: Record<string, unknown>) {
    const qc = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          queryFn: async ({ queryKey }) => {
            const key = String(queryKey[0] ?? "");
            if (key.endsWith("/history")) return [];
            if (key.endsWith("/photos")) return [];
            return { id: 7, updatedAt: "2026-07-08T19:00:00.000Z", ...detail };
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

  it("competitor and occupancy facts show under the header BEFORE the knock (quick level)", async () => {
    renderWithDetail({ competitorName: "Spectrum", competitorTech: "Cable", billingStatus: "N", householdSegmentType: "Single family" });
    const facts = await screen.findByTestId("knock-facts");
    expect(screen.getByTestId("knock-fact-competitor")).toHaveTextContent("Spectrum · Cable");
    expect(screen.getByTestId("knock-fact-occupancy")).toHaveTextContent("No current subscriber");
    // At most the two that change the pitch; segment stays in Details.
    expect(facts.querySelectorAll("[data-testid^='knock-fact-']")).toHaveLength(2);
    expect(screen.getByTestId("knock-premise-facts")).toHaveTextContent("Single family");
  });

  it("renders no facts row when the scanner knows nothing about the door", async () => {
    renderWithDetail({});
    await screen.findByTestId("knock-status-grid");
    expect(screen.queryByTestId("knock-facts")).not.toBeInTheDocument();
  });
});

describe("<LeadKnockSheet /> - post-mark next step (Set a time / Next door)", () => {
  const NEXT = { id: 9, address: "150 Maple St", meters: 38, atDoor: true };

  it("after Not Home the peek lip offers the nearest open door; Open hands the id upstream", async () => {
    const onOpenLead = vi.fn();
    renderSheet({ nextDoor: NEXT, onOpenLead });
    expect(screen.queryByTestId("knock-post-mark")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("knock-outcome-not_home"));
    expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "peek");
    const row = screen.getByTestId("knock-post-mark");
    expect(row).toHaveAttribute("data-kind", "next");
    expect(screen.getByTestId("knock-peek-bar").contains(row)).toBe(true);
    expect(row).toHaveTextContent("150 Maple St");
    expect(row).toHaveTextContent("At door");
    await userEvent.click(screen.getByTestId("knock-next-door-open"));
    expect(onOpenLead).toHaveBeenCalledWith(9);
  });

  it("a far door reads an honest distance hint", async () => {
    renderSheet({ nextDoor: { ...NEXT, meters: 400, atDoor: false }, onOpenLead: vi.fn() });
    await userEvent.click(screen.getByTestId("knock-outcome-sold"));
    expect(screen.getByTestId("knock-post-mark")).toHaveTextContent("0.2mi");
  });

  it("after Interested the next step is a time: Set a time reopens the card with the composer", async () => {
    renderSheet({ nextDoor: NEXT, onOpenLead: vi.fn() });
    await userEvent.click(screen.getByTestId("knock-outcome-interested"));
    expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "peek");
    const row = screen.getByTestId("knock-post-mark");
    expect(row).toHaveAttribute("data-kind", "time");
    expect(screen.queryByTestId("knock-next-door-open")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("knock-set-time"));
    expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "quick");
    expect(screen.getByTestId("appt-editor")).toBeInTheDocument();
    // While the composer is open the suggestion has done its job.
    expect(screen.queryByTestId("knock-post-mark")).not.toBeInTheDocument();
  });

  it("no next door known: a plain mark shows no row; Undo clears a shown one", async () => {
    const first = renderSheet();
    await userEvent.click(screen.getByTestId("knock-outcome-not_home"));
    expect(screen.queryByTestId("knock-post-mark")).not.toBeInTheDocument();
    first.unmount();

    renderSheet({ nextDoor: NEXT, onOpenLead: vi.fn() });
    await userEvent.click(screen.getByTestId("knock-outcome-not_interested"));
    expect(screen.getByTestId("knock-post-mark")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("knock-undo"));
    expect(screen.queryByTestId("knock-post-mark")).not.toBeInTheDocument();
  });

  it("clears on a card swap: the suggestion belonged to the previous door", async () => {
    const { rerenderSheet } = renderSheet({ nextDoor: NEXT, onOpenLead: vi.fn() });
    await userEvent.click(screen.getByTestId("knock-outcome-not_home"));
    expect(screen.getByTestId("knock-post-mark")).toBeInTheDocument();
    rerenderSheet({ lead: baseLead({ id: 8, address: "150 Maple St" }) });
    expect(screen.queryByTestId("knock-post-mark")).not.toBeInTheDocument();
  });

  it("the appointment and note triggers sit side by side as one equal pair", () => {
    renderSheet();
    const row = screen.getByTestId("knock-follow-through").firstElementChild as HTMLElement;
    expect(row.className).toMatch(/\bflex\b/);
    expect(row.contains(screen.getByTestId("appt-open"))).toBe(true);
    expect(row.contains(screen.getByTestId("note-add-chip"))).toBe(true);
    for (const id of ["appt-open", "note-add-chip"]) {
      expect(screen.getByTestId(id).className).toMatch(/\bh-11\b/);
      expect(screen.getByTestId(id).querySelector("svg")).toBeNull();
    }
  });
});

describe("<LeadKnockSheet /> - motion: velocity-matched snaps, pops, exits", () => {
  it("a snap writes a clamped inline duration (120..280ms) and keeps the decel curve", async () => {
    renderSheet();
    const sheet = screen.getByTestId("knock-sheet");
    expect(sheet.className).toMatch(/\btransition-transform\b/);
    await userEvent.click(screen.getByTestId("knock-outcome-not_home"));
    expect(sheet).toHaveAttribute("data-snap", "peek");
    // jsdom has no layout, so every offset is 0 and the settle floors at the minimum.
    const ms = parseInt(sheet.style.transitionDuration, 10);
    expect(ms).toBeGreaterThanOrEqual(120);
    expect(ms).toBeLessThanOrEqual(280);
    expect(sheet.style.transitionTimingFunction).toBe("cubic-bezier(0.32,0.72,0,1)");
  });

  it("the mark moment: the peek chip pops, the column fades, the next step surfaces after the landing", async () => {
    renderSheet({ nextDoor: { id: 9, address: "150 Maple St", meters: 30, atDoor: true }, onOpenLead: vi.fn() });
    await userEvent.click(screen.getByTestId("knock-outcome-not_home"));
    expect(screen.getByTestId("knock-peek-dot").parentElement?.className).toContain("status-pop");
    expect(screen.getByTestId("knock-post-mark").className).toContain("post-mark-in");
    // The quick/details column is faded (class only; jsdom computes no style).
    const column = screen.getByTestId("knock-sheet").lastElementChild as HTMLElement;
    expect(column.className).toContain("opacity-0");
  });

  it("a programmatic close exits faster than it entered, on an accelerating curve", () => {
    const { rerenderSheet } = renderSheet();
    const sheet = screen.getByTestId("knock-sheet");
    rerenderSheet({ lead: null });
    expect(sheet.style.transitionDuration).toBe("160ms");
    expect(sheet.style.transitionTimingFunction).toBe("cubic-bezier(0.4,0,1,1)");
  });

  it("press physics live on the disc, not the column; pills carry the shared utility", () => {
    renderSheet();
    const disc = screen.getByTestId("knock-outcome-sold");
    expect(disc.className).not.toMatch(/active:scale/);
    expect(disc.querySelector(".disc-press.w-11.h-11")).not.toBeNull();
    for (const id of ["knock-copy-address", "knock-sheet-close", "action-directions", "appt-open", "note-add-chip"]) {
      expect(screen.getByTestId(id).className).toContain("tap-press");
      expect(screen.getByTestId(id).className).not.toMatch(/\btransition\b/);
    }
  });
});

describe("<LeadKnockSheet /> - docked panel: the post-mark step lives under the grid", () => {
  function withDocked<T>(run: () => T): T {
    const original = window.matchMedia;
    (window as any).matchMedia = (q: string) => ({
      matches: q.includes("min-width: 1024px"), media: q,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
      onchange: null, dispatchEvent: () => false,
    });
    try { return run(); } finally { (window as any).matchMedia = original; }
  }

  it("renders the Next door row inside the follow-through block, never in the peek bar, and never collapses", async () => {
    await withDocked(async () => {
      const onOpenLead = vi.fn();
      renderSheet({ nextDoor: { id: 9, address: "150 Maple St", meters: 30, atDoor: true }, onOpenLead });
      expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "docked");
      await userEvent.click(screen.getByTestId("knock-outcome-sold"));
      expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "docked");
      const rows = screen.getAllByTestId("knock-post-mark");
      expect(rows).toHaveLength(1);
      expect(screen.getByTestId("knock-follow-through").contains(rows[0])).toBe(true);
      expect(screen.getByTestId("knock-peek-bar").contains(rows[0])).toBe(false);
      await userEvent.click(screen.getByTestId("knock-next-door-open"));
      expect(onOpenLead).toHaveBeenCalledWith(9);
    });
  });

  it("Set a time opens the composer in place (no snap) and the nudge leaves", async () => {
    await withDocked(async () => {
      renderSheet();
      await userEvent.click(screen.getByTestId("knock-outcome-interested"));
      expect(screen.getByTestId("knock-post-mark")).toHaveAttribute("data-kind", "time");
      await userEvent.click(screen.getByTestId("knock-set-time"));
      expect(screen.getByTestId("appt-editor")).toBeInTheDocument();
      expect(screen.getByTestId("knock-sheet")).toHaveAttribute("data-snap", "docked");
      expect(screen.queryByTestId("knock-post-mark")).not.toBeInTheDocument();
    });
  });

  it("the hidden peek bar is inert at every non-peek level, so its buttons are never tab stops", async () => {
    renderSheet();
    const peekWrap = screen.getByTestId("knock-peek-bar").parentElement?.parentElement as HTMLElement;
    expect(peekWrap).toHaveAttribute("inert");
    expect(peekWrap).toHaveAttribute("aria-hidden", "true");
    await userEvent.click(screen.getByTestId("knock-outcome-not_home")); // -> peek
    expect(peekWrap).not.toHaveAttribute("inert");
  });
});

describe("<LeadKnockSheet /> - copy feedback is honest", () => {
  const setClipboard = (value: unknown) => Object.defineProperty(navigator, "clipboard", { configurable: true, value });

  it("a rejected writeText falls back to execCommand and still reports copied with the right text", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")) });
    const seen: string[] = [];
    (document as any).execCommand = vi.fn(() => { seen.push((document.body.lastElementChild as HTMLTextAreaElement).value); return true; });
    try {
      renderSheet();
      await userEvent.click(screen.getByTestId("knock-copy-address"));
      await waitFor(() => expect(screen.getByTestId("knock-address-copied")).toBeInTheDocument());
      expect(seen).toEqual(["148 Maple St, Rockwell, NC 28138"]);
    } finally { setClipboard(undefined); delete (document as any).execCommand; }
  });

  it("when every path fails the card says so instead of flashing copied", async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")) });
    (document as any).execCommand = vi.fn(() => false);
    try {
      renderSheet();
      await userEvent.click(screen.getByTestId("knock-copy-address"));
      await waitFor(() => expect(screen.getByTestId("knock-address-copy-failed")).toHaveTextContent("Could not copy"));
      expect(screen.queryByTestId("knock-address-copied")).not.toBeInTheDocument();
      expect(screen.getByTestId("knock-copy-address")).toHaveAccessibleName("Copy address");
      expect(screen.getByRole("status")).toHaveTextContent("Could not copy the address");
    } finally { setClipboard(undefined); delete (document as any).execCommand; }
  });
});
