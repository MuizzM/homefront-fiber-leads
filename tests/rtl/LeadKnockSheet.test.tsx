import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LeadKnockSheet } from "@/components/LeadKnockSheet";
import { OUTCOMES } from "@shared/knock";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * CONTRACT (UI agent, client/src/components/LeadKnockSheet.tsx).
 * Props: { lead, saveState, savedOutcome, onKnock, onSaveNote, onRetrySave?,
 *          onClose, onNextDoor, onSkip, nextDoorHint?, hasNext?, canAssign?,
 *          reps?, onAssignRep? }
 * lead: { id, address, city, state, zip, leadStatus, lat, lng, contactPhone?,
 *         visited?, knockCount?, lastOutcome?, lastKnockedAt? } | null
 * Requirements exercised here (testids are the API):
 *   - [knock-sheet] with the address; one [knock-outcome-{key}] per OUTCOMES
 *   - tapping an outcome calls onKnock(outcome) — EXCEPT callback, which is a
 *     two-step: [callback-quick-row] chips → onKnock("callback", {callbackDate,
 *     callbackTime}); [callback-chip-tomorrow-am] means tomorrow at 09:00
 *   - savedOutcome set = done phase: [next-door-btn] + [knock-change-outcome]
 *     replace the grid; change-outcome brings the grid back; hasNext={false}
 *     disables next-door
 *   - [knock-save-state] mirrors saveState via data-state; in "error" it is
 *     tappable and fires onRetrySave
 *   - quick actions: [action-call]/[action-text] aria-disabled without a
 *     phone, tel: href with one; [action-directions] links to Google Maps
 *     (NEVER mapbox — geocoding billing guardrail)
 *   - [knock-skip] → onSkip, [knock-sheet-close] → onClose
 *   - [assign-rep-select] rendered only when canAssign
 *   - lead null renders nothing
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
  // The sheet lazily queries knock history when expanded; give the test
  // client a benign default queryFn so an eager fetch can never explode.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, queryFn: async () => [] } },
  });
  const props = {
    lead: baseLead(),
    saveState: "idle",
    savedOutcome: null,
    onKnock: vi.fn(),
    onSaveNote: vi.fn(),
    onRetrySave: vi.fn(),
    onClose: vi.fn(),
    onNextDoor: vi.fn(),
    onSkip: vi.fn(),
    ...overrides,
  };
  const view = render(
    <QueryClientProvider client={qc}>
      <LeadKnockSheet {...(props as any)} />
    </QueryClientProvider>,
  );
  return { ...view, props };
}

describe("<LeadKnockSheet /> — outcome grid", () => {
  it("renders the sheet with the address and exactly the 6 rep outcome buttons", () => {
    renderSheet();

    const sheet = screen.getByTestId("knock-sheet");
    expect(sheet).toHaveTextContent("148 Maple St");
    // Owner's rule: 4-6 buttons max on the rep card. needs_verification stays in
    // shared/knock.ts for server/history back-compat but is NOT offered to reps.
    for (const o of OUTCOMES.filter(o => o.key !== "needs_verification")) {
      expect(screen.getByTestId(`knock-outcome-${o.key}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId("knock-outcome-needs_verification")).not.toBeInTheDocument();
  });

  it("tapping an outcome fires onKnock with that outcome", async () => {
    const { props } = renderSheet();
    await userEvent.click(screen.getByTestId("knock-outcome-interested"));

    expect(props.onKnock).toHaveBeenCalledTimes(1);
    expect(props.onKnock.mock.calls[0][0]).toBe("interested");
  });

  it("callback is a two-step: chip row first, then onKnock with date+time", async () => {
    const { props } = renderSheet();

    await userEvent.click(screen.getByTestId("knock-outcome-callback"));
    // No knock yet — a callback without a time is useless to the rep.
    expect(props.onKnock).not.toHaveBeenCalled();
    expect(screen.getByTestId("callback-quick-row")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("callback-chip-tomorrow-am"));
    expect(props.onKnock).toHaveBeenCalledTimes(1);
    const [outcome, extra] = props.onKnock.mock.calls[0];
    expect(outcome).toBe("callback");
    expect(extra.callbackDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(extra.callbackTime).toBe("09:00");
  });
});

describe("<LeadKnockSheet /> — done phase", () => {
  it("savedOutcome swaps the grid for Next Door + Change outcome", async () => {
    const { props } = renderSheet({ savedOutcome: "interested", hasNext: true });

    expect(screen.getByTestId("next-door-btn")).toBeInTheDocument();
    expect(screen.getByTestId("knock-change-outcome")).toBeInTheDocument();
    expect(screen.queryByTestId("knock-outcome-sold")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("next-door-btn"));
    expect(props.onNextDoor).toHaveBeenCalledTimes(1);
  });

  it("Change outcome brings the outcome grid back", async () => {
    renderSheet({ savedOutcome: "interested", hasNext: true });

    await userEvent.click(screen.getByTestId("knock-change-outcome"));
    expect(screen.getByTestId("knock-outcome-sold")).toBeInTheDocument();
  });

  it("disables Next Door when there is no next unworked lead", () => {
    renderSheet({ savedOutcome: "sold", hasNext: false });
    expect(screen.getByTestId("next-door-btn")).toBeDisabled();
  });
});

describe("<LeadKnockSheet /> — save state indicator", () => {
  it("mirrors saving and queued states via data-state", () => {
    const first = renderSheet({ saveState: "saving" });
    expect(screen.getByTestId("knock-save-state")).toHaveAttribute("data-state", "saving");
    first.unmount();

    renderSheet({ saveState: "queued" });
    expect(screen.getByTestId("knock-save-state")).toHaveAttribute("data-state", "queued");
  });

  it("error state is tappable and fires onRetrySave", async () => {
    const { props } = renderSheet({ saveState: "error" });

    const indicator = screen.getByTestId("knock-save-state");
    expect(indicator).toHaveAttribute("data-state", "error");
    await userEvent.click(indicator);
    expect(props.onRetrySave).toHaveBeenCalledTimes(1);
  });
});

describe("<LeadKnockSheet /> — quick actions", () => {
  it("call/text are aria-disabled without a phone, live tel: link with one", () => {
    const first = renderSheet(); // baseLead has no contactPhone
    expect(screen.getByTestId("action-call")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("action-text")).toHaveAttribute("aria-disabled", "true");
    first.unmount();

    renderSheet({ lead: baseLead({ contactPhone: "704-555-0101" }) });
    expect(screen.getByTestId("action-call").getAttribute("href")).toContain("tel:");
  });

  it("directions deep-link to Google Maps at the lead's coords — never mapbox", () => {
    renderSheet();
    const href = screen.getByTestId("action-directions").getAttribute("href") ?? "";
    expect(href).toContain("google.com/maps/dir");
    expect(href).toContain("34.9");
    expect(href).toContain("-79.9");
    expect(href.toLowerCase()).not.toContain("mapbox");
  });
});

describe("<LeadKnockSheet /> — chrome and gating", () => {
  it("skip and close fire their callbacks", async () => {
    const { props } = renderSheet();

    await userEvent.click(screen.getByTestId("knock-skip"));
    expect(props.onSkip).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByTestId("knock-sheet-close"));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the assign-rep select only when canAssign AND expanded (peek stays clean)", async () => {
    const reps = [
      { id: 3, name: "Dana Reyes" },
      { id: 4, name: "Malik Byrd" },
    ];
    const first = renderSheet({ canAssign: true, reps, onAssignRep: vi.fn() });
    // Peek shows knocking essentials only — admin controls live behind expand.
    expect(screen.queryByTestId("assign-rep-select")).not.toBeInTheDocument();
    // Tapping the handle toggles peek → expanded (one-hand alternative to drag).
    await userEvent.click(screen.getByTestId("knock-sheet-handle"));
    expect(screen.getByTestId("assign-rep-select")).toBeInTheDocument();
    first.unmount();

    renderSheet({ reps }); // no canAssign → reps alone must not leak the control
    expect(screen.queryByTestId("assign-rep-select")).not.toBeInTheDocument();
  });

  it("renders nothing when lead is null", () => {
    renderSheet({ lead: null });
    expect(screen.queryByTestId("knock-sheet")).not.toBeInTheDocument();
  });
});

describe("<LeadKnockSheet /> — porch-simple peek", () => {
  it("never shows the word 'Unworked'; a fresh door shows its city instead", () => {
    renderSheet(); // baseLead: fresh, city Rockwell
    expect(screen.getByTestId("knock-sheet")).not.toHaveTextContent(/unworked/i);
    expect(screen.getByTestId("knock-sheet")).toHaveTextContent("Rockwell");
  });

  it("keeps the note field out of peek; after a save + expand it appears", async () => {
    const { props } = renderSheet({ savedOutcome: "interested" });
    // Peek: no form controls, calm card.
    expect(screen.queryByTestId("knock-note-input")).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId("knock-sheet-handle")); // expand
    expect(screen.getByTestId("knock-note-input")).toBeInTheDocument();
    expect(props).toBeTruthy();
  });

  it("without a saved outcome there is no note field even when expanded", async () => {
    renderSheet();
    await userEvent.click(screen.getByTestId("knock-sheet-handle"));
    expect(screen.queryByTestId("knock-note-input")).not.toBeInTheDocument();
  });

  it("shows the 🔥 chip only for hot leads (score ≥ 80)", () => {
    const hot = renderSheet({ lead: baseLead({ leadScore: 85 }) });
    expect(screen.getByTestId("knock-hot-chip")).toBeInTheDocument();
    hot.unmount();
    renderSheet({ lead: baseLead({ leadScore: 40 }) });
    expect(screen.queryByTestId("knock-hot-chip")).not.toBeInTheDocument();
  });
});
