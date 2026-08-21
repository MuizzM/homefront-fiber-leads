// OutcomeSheet — the shared Today/PropertyDetail disposition sheet, now
// carrying the SAME two-tier surface as the map card: primary four as big
// cells (Sold emphasized), every other disposition as a status-coded disc, an
// active-state mirror, and the appointment composer. One vocabulary, one
// grammar, whichever surface a door gets marked from.
import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OutcomeSheet } from "@/components/OutcomeSheet";
import { FIELD_OUTCOMES, OUTCOME_META } from "@shared/knock";

beforeAll(() => {
  // Radix Sheet needs these jsdom gaps filled.
  if (!window.HTMLElement.prototype.scrollIntoView) window.HTMLElement.prototype.scrollIntoView = () => {};
  if (!window.HTMLElement.prototype.hasPointerCapture) (window.HTMLElement.prototype as any).hasPointerCapture = () => false;
  (window.HTMLElement.prototype as any).releasePointerCapture ??= () => {};
  window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as any;
});

const PRIMARY = ["not_home", "interested", "sold", "not_interested"];
const STRIP_KEYS = FIELD_OUTCOMES.map(o => o.key).filter(k => !PRIMARY.includes(k));

function baseLead(overrides: Record<string, unknown> = {}) {
  return { id: 5, address: "77 Fiber Way", city: "Conroe", zip: "77304", leadStatus: "prospect", ...overrides };
}

function renderSheet(overrides: Record<string, any> = {}) {
  const props = { lead: baseLead(), onClose: vi.fn(), onLog: vi.fn(), ...overrides };
  const view = render(<OutcomeSheet {...(props as any)} />);
  return { ...view, props };
}

describe("<OutcomeSheet /> - two-tier disposition surface", () => {
  it("primary four render as big cells; every other disposition is a strip disc", () => {
    renderSheet();
    for (const k of PRIMARY) expect(screen.getByTestId(`outcome-${k}`)).toBeInTheDocument();
    const strip = screen.getByTestId("outcome-strip");
    for (const o of FIELD_OUTCOMES) {
      if (PRIMARY.includes(o.key)) continue;
      const disc = screen.getByTestId(`knock-outcome-${o.key}`);
      expect(strip.contains(disc)).toBe(true);
      expect(disc).toHaveTextContent(o.short);
      expect(disc).toHaveAccessibleName(o.label);
    }
  });

  it("a strip disc logs through the same one-tap path, carrying the typed note", async () => {
    const { props } = renderSheet();
    await userEvent.click(screen.getByText("Add a note"));
    await userEvent.type(screen.getByTestId("outcome-note"), "gate code 4411");
    await userEvent.click(screen.getByTestId("knock-outcome-competitor"));
    expect(props.onLog).toHaveBeenCalledTimes(1);
    expect(props.onLog).toHaveBeenCalledWith("competitor", {
      notes: "gate code 4411", callbackDate: null, callbackTime: null,
    });
  });

  it("mirrors the door's current state: a COMP door presses the COMP disc in place", () => {
    renderSheet({ lead: baseLead({ leadStatus: "not_interested", visited: 1, lastOutcome: "competitor" }) });
    expect(screen.getByTestId("knock-outcome-competitor")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("outcome-not_interested")).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps every disposition in the shared FIELD order across tiers", () => {
    renderSheet();
    const stripOrder = [...screen.getByTestId("outcome-strip").querySelectorAll("[data-testid^='knock-outcome-']")]
      .map(b => (b as HTMLElement).dataset.testid!.replace("knock-outcome-", ""));
    expect(stripOrder).toEqual(STRIP_KEYS);
  });
});

describe("<OutcomeSheet /> - appointment composer", () => {
  it("chip → editor; Set disabled until a date; confirming logs ONE follow-up with the schedule", async () => {
    const { props } = renderSheet();
    await userEvent.click(screen.getByTestId("outcome-appt-open"));
    expect(screen.getByTestId("outcome-appt-save")).toBeDisabled();
    fireEvent.change(screen.getByTestId("outcome-appt-date"), { target: { value: "2026-08-29" } });
    fireEvent.change(screen.getByTestId("outcome-appt-time"), { target: { value: "18:30" } });
    await userEvent.click(screen.getByTestId("outcome-appt-save"));
    expect(props.onLog).toHaveBeenCalledTimes(1);
    expect(props.onLog).toHaveBeenCalledWith("follow_up", {
      notes: null, callbackDate: "2026-08-29", callbackTime: "18:30",
    });
  });

  it("a Go Back door keeps GB when scheduled - same rule as the map card", async () => {
    const { props } = renderSheet({ lead: baseLead({ leadStatus: "follow_up", visited: 1, lastOutcome: "go_back" }) });
    await userEvent.click(screen.getByTestId("outcome-appt-open"));
    // The editor's helper copy names the disposition the schedule will carry.
    expect(screen.getByTestId("outcome-appt-editor")).toHaveTextContent(OUTCOME_META.go_back.label);
    fireEvent.change(screen.getByTestId("outcome-appt-date"), { target: { value: "2026-08-29" } });
    await userEvent.click(screen.getByTestId("outcome-appt-save"));
    expect(props.onLog).toHaveBeenCalledWith("go_back", {
      notes: null, callbackDate: "2026-08-29", callbackTime: null,
    });
  });
});
