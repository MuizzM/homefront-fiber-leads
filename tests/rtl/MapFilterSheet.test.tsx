// The Field Map filter sheet's contract, pinned.
//
// The sheet must (1) render one chip per statusOrder entry with the shared
// STATE_LABELS vocabulary and the caller's counts, (2) report taps — a fresh
// tap filters, a tap on the active chip returns to "all", (3) offer "Clear
// all" only while a filter is active, (4) list reps with Unassigned first and
// report rep taps, and (5) render nothing when closed. Scrim and X both close.
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: undefined,
}));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import { MapFilterSheet } from "../../client/src/components/map/MapFilterSheet";
import { STATE_LABELS } from "../../shared/knock";

const ORDER = ["unworked", "not_home", "interested", "follow_up", "sold", "not_interested"];
const COUNTS = { unworked: 41, not_home: 7, interested: 3, follow_up: 2, sold: 1, not_interested: 5 };
const REPS = [
  { id: 11, name: "Rep Ann", count: 30 },
  { id: 12, name: "Rep Bo", count: 18 },
];

function renderSheet(over: Partial<React.ComponentProps<typeof MapFilterSheet>> = {}) {
  const onClose = vi.fn(), onStatus = vi.fn(), onRep = vi.fn(), onClearAll = vi.fn();
  const utils = render(
    <MapFilterSheet
      open
      onClose={onClose}
      statusOrder={ORDER}
      statusCounts={COUNTS}
      activeStatus="all"
      onStatus={onStatus}
      activeRep="all"
      onRep={onRep}
      onClearAll={onClearAll}
      shown={59}
      total={59}
      {...over}
    />,
  );
  return { ...utils, onClose, onStatus, onRep, onClearAll };
}

beforeEach(() => { apiRequest.mockReset(); toast.mockReset(); });

describe("map filter sheet contract", () => {
  it("renders one chip per statusOrder entry with shared labels and the caller's counts", () => {
    renderSheet();
    for (const s of ORDER) {
      const chip = screen.getByTestId(`map-filter-status-${s}`);
      expect(chip.textContent).toContain(STATE_LABELS[s as keyof typeof STATE_LABELS]);
      expect(chip.textContent).toContain(String(COUNTS[s as keyof typeof COUNTS]));
    }
    expect(screen.getByTestId("map-filter-summary").textContent).toBe("Showing 59 of 59 doors");
  });

  it("tapping a chip filters; tapping the active chip returns to all", () => {
    const { onStatus } = renderSheet({ activeStatus: "sold" });
    fireEvent.click(screen.getByTestId("map-filter-status-interested"));
    expect(onStatus).toHaveBeenLastCalledWith("interested");
    expect(screen.getByTestId("map-filter-status-sold")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("map-filter-status-sold"));
    expect(onStatus).toHaveBeenLastCalledWith("all");
  });

  it("offers Clear all only while a filter is active, and it fires onClearAll", () => {
    const first = renderSheet();
    expect(screen.queryByTestId("map-filter-clear-all")).toBeNull();
    first.unmount();

    const second = renderSheet({ activeStatus: "not_home" });
    fireEvent.click(screen.getByTestId("map-filter-clear-all"));
    expect(second.onClearAll).toHaveBeenCalledTimes(1);
    second.unmount();

    renderSheet({ activeRep: "12" });
    expect(screen.getByTestId("map-filter-clear-all")).toBeInTheDocument();
  });

  it("lists reps with Unassigned first, reports taps, and highlights the active row", () => {
    const { onRep } = renderSheet({ reps: REPS, unassignedCount: 11, activeRep: "12" });
    const rows = screen.getAllByTestId(/^map-filter-rep-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "map-filter-rep-unassigned", "map-filter-rep-11", "map-filter-rep-12",
    ]);
    expect(screen.getByTestId("map-filter-rep-unassigned").textContent).toContain("Unassigned");
    expect(screen.getByTestId("map-filter-rep-unassigned").textContent).toContain("11");
    expect(screen.getByTestId("map-filter-rep-12")).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByTestId("map-filter-rep-11"));
    expect(onRep).toHaveBeenLastCalledWith("11");
    fireEvent.click(screen.getByTestId("map-filter-rep-unassigned"));
    expect(onRep).toHaveBeenLastCalledWith("unassigned");
    fireEvent.click(screen.getByTestId("map-filter-rep-12")); // active row toggles off
    expect(onRep).toHaveBeenLastCalledWith("all");
  });

  it("hides the Rep section entirely when no reps prop is given", () => {
    renderSheet();
    expect(screen.queryByTestId("map-filter-rep-unassigned")).toBeNull();
  });

  it("is a labelled modal dialog; scrim and X both close it", () => {
    const { onClose } = renderSheet();
    const dialog = screen.getByTestId("map-filter-sheet");
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "map-filter-title");
    expect(screen.getByText("Filters").id).toBe("map-filter-title");

    fireEvent.click(screen.getByTestId("map-filter-scrim"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("map-filter-close"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renders nothing at all when closed", () => {
    renderSheet({ open: false });
    expect(screen.queryByTestId("map-filter-sheet")).toBeNull();
  });
});

// ── Fiber (FCC) source lens ──────────────────────────────────────────────────
// The source pills AND with the status filter; zero-count options are dead UI
// and stay hidden; "All" is always the escape while the section is visible.
import { LEAD_SOURCE_OPTIONS } from "@/lib/leadSourceFilter";

describe("fiber (FCC) source pills", () => {
  const SOURCE_COUNTS = { latest: 51, fcc_fresh: 12, fcc_fiber: 34, field_verified: 5 };

  function renderWithSources(over: Partial<React.ComponentProps<typeof MapFilterSheet>> = {}) {
    const onSource = vi.fn();
    const utils = renderSheet({
      sources: LEAD_SOURCE_OPTIONS,
      sourceCounts: SOURCE_COUNTS,
      activeSource: "latest",
      onSource,
      ...over,
    });
    return { ...utils, onSource };
  }

  it("renders one pill per option WITH pins, plus an All escape, each count shown", () => {
    renderWithSources({ activeSource: "all" });
    expect(screen.getByTestId("map-filter-source-all")).toBeInTheDocument();
    expect(screen.getByTestId("map-filter-source-latest").textContent).toContain("Latest fiber");
    expect(screen.getByTestId("map-filter-source-latest").textContent).toContain("51");
    expect(screen.getByTestId("map-filter-source-fcc_fresh").textContent).toContain("FCC fresh (2025)");
    expect(screen.getByTestId("map-filter-source-fcc_fresh").textContent).toContain("12");
    expect(screen.getByTestId("map-filter-source-fcc_fiber").textContent).toContain("FCC fiber");
    expect(screen.getByTestId("map-filter-source-fcc_fiber").textContent).toContain("34");
    expect(screen.getByTestId("map-filter-source-field_verified").textContent).toContain("Field-verified");
    expect(screen.getByTestId("map-filter-source-field_verified").textContent).toContain("5");
  });

  it("Latest fiber is the FIRST pill, All follows as the escape", () => {
    renderWithSources();
    const pills = screen.getAllByTestId(/^map-filter-source-/);
    expect(pills[0]).toHaveAttribute("data-testid", "map-filter-source-latest");
    expect(pills[1]).toHaveAttribute("data-testid", "map-filter-source-all");
    // …and the default view is the pressed one.
    expect(pills[0]).toHaveAttribute("aria-pressed", "true");
  });

  it("the footprint stays DISCOVERABLE with its count - one tap away from the default", () => {
    const { onSource } = renderWithSources();
    const fiber = screen.getByTestId("map-filter-source-fcc_fiber");
    expect(fiber.textContent).toContain("FCC fiber");
    expect(fiber.textContent).toContain("34");
    fireEvent.click(fiber);
    expect(onSource).toHaveBeenLastCalledWith("fcc_fiber");
    // …and All shows the whole map, footprint included.
    fireEvent.click(screen.getByTestId("map-filter-source-all"));
    expect(onSource).toHaveBeenLastCalledWith("all");
  });

  it("tapping a pill reports its key; the active pill is aria-pressed", () => {
    const { onSource } = renderWithSources({ activeSource: "fcc_fiber" });
    expect(screen.getByTestId("map-filter-source-fcc_fiber")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("map-filter-source-fcc_fresh"));
    expect(onSource).toHaveBeenLastCalledWith("fcc_fresh");
    fireEvent.click(screen.getByTestId("map-filter-source-all"));
    expect(onSource).toHaveBeenLastCalledWith("all");
  });

  it("zero-count options are hidden entirely (no dead UI before the FCC import)", () => {
    const first = renderWithSources({ sourceCounts: { fcc_fiber: 3 } });
    expect(screen.queryByTestId("map-filter-source-fcc_fresh")).toBeNull();
    expect(screen.queryByTestId("map-filter-source-field_verified")).toBeNull();
    expect(screen.getByTestId("map-filter-source-fcc_fiber")).toBeInTheDocument();
    first.unmount();
    // …and with NO FCC data at all the whole section stays out of the sheet.
    renderSheet({ sources: LEAD_SOURCE_OPTIONS, sourceCounts: {}, activeSource: "all", onSource: vi.fn() });
    expect(screen.queryByTestId("map-filter-sources")).toBeNull();
  });

  it("the active option stays visible even at zero count (state is never invisible)", () => {
    renderWithSources({ sourceCounts: {}, activeSource: "fcc_fresh" });
    expect(screen.getByTestId("map-filter-source-fcc_fresh")).toHaveAttribute("aria-pressed", "true");
  });

  it("a zero-FCC tenant: Latest == All effectively, the footprint pill hides (existing zero-count rule)", () => {
    renderWithSources({ sourceCounts: { latest: 8 } });
    expect(screen.getByTestId("map-filter-source-latest")).toBeInTheDocument();
    expect(screen.getByTestId("map-filter-source-all")).toBeInTheDocument();
    expect(screen.queryByTestId("map-filter-source-fcc_fiber")).toBeNull();
    expect(screen.queryByTestId("map-filter-source-fcc_fresh")).toBeNull();
  });

  it("an active source makes the sheet filtered (Clear all appears) and composes with status", () => {
    const { onClearAll } = renderWithSources({ activeSource: "field_verified", activeStatus: "sold" });
    fireEvent.click(screen.getByTestId("map-filter-clear-all"));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it("older callers without source props render unchanged (no section)", () => {
    renderSheet();
    expect(screen.queryByTestId("map-filter-sources")).toBeNull();
  });
});

describe("density-tier zoom hint", () => {
  it("renders the zoomedOutNote only while it applies (no dead UI)", () => {
    const { unmount } = renderSheet({ zoomedOutNote: "Status and field-verified filters apply when zoomed in" });
    const hint = screen.getByTestId("map-filter-zoom-hint");
    expect(hint.textContent).toContain("apply when zoomed in");
    unmount();
    renderSheet(); // default: no note → no hint element at all
    expect(screen.queryByTestId("map-filter-zoom-hint")).toBeNull();
  });

  it("shows the rep-filter wording (a manager's rep lens is named, never silently dropped)", () => {
    // MapView composes "Rep filter applies when zoomed in" when a rep filter
    // is active in the grid tier (the composition is pinned source-level in
    // tests/unit/map-zoom-tiers.test.ts).
    renderSheet({ zoomedOutNote: "Rep filter applies when zoomed in" });
    expect(screen.getByTestId("map-filter-zoom-hint").textContent).toContain("Rep filter applies when zoomed in");
  });
});
