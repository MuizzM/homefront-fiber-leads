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

// The live proximity chip captures one GPS fix per sheet open. jsdom has no
// geolocation, so the module is mocked; each test sets what the "device" sees.
const mockFix = vi.hoisted(() => ({ current: { repLat: null as number | null, repLng: null as number | null, gpsAccuracy: null as number | null } }));
vi.mock("@/lib/geoFix", () => ({
  captureFieldFix: vi.fn(() => Promise.resolve({ ...mockFix.current })),
}));

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

describe("<OutcomeSheet /> - one disposition surface, all discs", () => {
  it("every field disposition renders as the same disc in ONE grid, fixed order, no strip", () => {
    renderSheet();
    const grid = screen.getByTestId("outcome-grid");
    expect(screen.queryByTestId("outcome-strip")).not.toBeInTheDocument();
    for (const o of FIELD_OUTCOMES) {
      const disc = screen.getByTestId(`outcome-${o.key}`);
      expect(grid.contains(disc)).toBe(true);
      expect(disc.querySelector(".w-11.h-11.rounded-full")).not.toBeNull();
      expect(disc).toHaveTextContent(o.short);
      expect(disc).toHaveAccessibleName(o.label);
    }
    const order = [...grid.querySelectorAll("[data-testid^='outcome-']")]
      .map(b => (b as HTMLElement).dataset.testid!.replace("outcome-", ""));
    expect(order).toEqual(FIELD_OUTCOMES.map(o => o.key));
    expect(order.slice(0, 4)).toEqual(PRIMARY);
    expect(order.slice(4)).toEqual(STRIP_KEYS);
  });

  it("a disc logs through the same one-tap path, carrying the typed note", async () => {
    const { props } = renderSheet();
    await userEvent.click(screen.getByText("Add a note"));
    await userEvent.type(screen.getByTestId("outcome-note"), "gate code 4411");
    await userEvent.click(screen.getByTestId("outcome-competitor"));
    expect(props.onLog).toHaveBeenCalledTimes(1);
    expect(props.onLog).toHaveBeenCalledWith("competitor", {
      notes: "gate code 4411", callbackDate: null, callbackTime: null,
    });
  });

  it("mirrors the door's current state: a COMP door presses the COMP disc in place", () => {
    renderSheet({ lead: baseLead({ leadStatus: "not_interested", visited: 1, lastOutcome: "competitor" }) });
    expect(screen.getByTestId("outcome-competitor")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("outcome-not_interested")).toHaveAttribute("aria-pressed", "false");
  });
});

describe("<OutcomeSheet /> - appointment composer", () => {
  it("offers the same one-tap times as the map card; a tap fills the pickers, Set confirms", async () => {
    const { props } = renderSheet();
    await userEvent.click(screen.getByTestId("outcome-appt-open"));
    const slots = screen.getByTestId("appt-slots");
    expect(slots).toBeInTheDocument();
    // BY LABEL, never by index: "Tomorrow 10 AM" is always offered, but it is
    // only slot-1 while the Today chip is present, and quickSlots drops Today
    // after CLOSE_MIN (19:00). An index passes all afternoon and fails in CI.
    const tomorrowChip = Array.from(slots.querySelectorAll("button"))
      .find((c) => /^Tomorrow /i.test(c.textContent ?? ""))!;
    expect(tomorrowChip, "a Tomorrow chip is always offered").toBeTruthy();
    await userEvent.click(tomorrowChip);
    expect(screen.getByTestId("outcome-appt-time")).toHaveValue("10:00");
    expect(screen.getByTestId("outcome-appt-save")).toHaveTextContent("Set for tomorrow 10 AM");
    expect(props.onLog).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("outcome-appt-save"));
    expect(props.onLog).toHaveBeenCalledTimes(1);
    expect(props.onLog.mock.calls[0][1].callbackTime).toBe("10:00");
  });

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

describe("<OutcomeSheet /> - live proximity chip", () => {
  // Same honesty gates as the map card's chip: coordinates on the door, a fix
  // from the device, accuracy tight enough that the number is not fiction.
  const DOOR = { lat: 35.99, lng: -78.919 };

  it("shows At door when the fix is on the doorstep", async () => {
    mockFix.current = { repLat: DOOR.lat, repLng: DOOR.lng, gpsAccuracy: 12 };
    renderSheet({ lead: baseLead(DOOR) });
    const chip = await screen.findByTestId("outcome-proximity");
    expect(chip).toHaveTextContent("At door");
    expect(Number(chip.getAttribute("data-dist-m"))).toBeLessThanOrEqual(60);
  });

  it("shows a distance when the rep is away from the door", async () => {
    // ~0.01 deg latitude is roughly 1.1 km — far outside the 60 m doorstep.
    mockFix.current = { repLat: DOOR.lat + 0.01, repLng: DOOR.lng, gpsAccuracy: 12 };
    renderSheet({ lead: baseLead(DOOR) });
    const chip = await screen.findByTestId("outcome-proximity");
    expect(chip).not.toHaveTextContent("At door");
    expect(Number(chip.getAttribute("data-dist-m"))).toBeGreaterThan(60);
  });

  it("renders no chip without door coordinates, and none on a fix too loose to trust", async () => {
    mockFix.current = { repLat: DOOR.lat, repLng: DOOR.lng, gpsAccuracy: 12 };
    const first = renderSheet();
    expect(screen.queryByTestId("outcome-proximity")).toBeNull();
    first.unmount();
    mockFix.current = { repLat: DOOR.lat, repLng: DOOR.lng, gpsAccuracy: 500 };
    renderSheet({ lead: baseLead(DOOR) });
    // The mocked capture resolves in a microtask; flush it before asserting absence.
    await screen.findByTestId("outcome-sheet");
    await Promise.resolve();
    expect(screen.queryByTestId("outcome-proximity")).toBeNull();
  });
});
