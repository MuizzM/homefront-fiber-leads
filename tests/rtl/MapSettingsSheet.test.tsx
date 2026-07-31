// The map settings sheet's contract, pinned.
//
// The sheet must (1) render one row per toggle with its label and optional
// description, (2) report every switch tap through that toggle's onToggle
// without flipping state itself (fully controlled), (3) drive the basemap
// segmented control through onChange with aria-pressed telling the truth,
// and (4) render nothing at all when closed. Dismissal works from both the
// scrim and the header X.
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: undefined,
}));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import { MapSettingsSheet } from "../../client/src/components/map/MapSettingsSheet";

function makeToggles() {
  return [
    {
      key: "leads",
      label: "Lead pins",
      description: "Show every knockable door on the map.",
      on: true,
      onToggle: vi.fn(),
      testId: "map-toggle-leads",
    },
    {
      key: "territories",
      label: "Territories",
      on: false,
      onToggle: vi.fn(),
      testId: "map-toggle-territories",
    },
  ];
}

function renderSheet(over: Partial<React.ComponentProps<typeof MapSettingsSheet>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onBasemapChange = vi.fn();
  const toggles = over.toggles ?? makeToggles();
  const utils = render(
    <QueryClientProvider client={qc}>
      <MapSettingsSheet
        open
        onClose={onClose}
        basemap={{ value: "streets", onChange: onBasemapChange }}
        toggles={toggles}
        {...over}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onClose, onBasemapChange, toggles };
}

beforeEach(() => { apiRequest.mockReset(); toast.mockReset(); });

describe("map settings sheet contract", () => {
  it("renders a labelled modal dialog with one switch row per toggle", () => {
    renderSheet();
    const dialog = screen.getByTestId("map-settings-sheet");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("map-settings-title");
    expect(screen.getByText("Map settings").id).toBe("map-settings-title");

    const leads = screen.getByTestId("map-toggle-leads");
    const territories = screen.getByTestId("map-toggle-territories");
    expect(leads.getAttribute("role")).toBe("switch");
    expect(leads.getAttribute("aria-checked")).toBe("true");
    expect(territories.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Lead pins")).toBeTruthy();
    expect(screen.getByText("Territories")).toBeTruthy();
    expect(screen.getByText("Show every knockable door on the map.")).toBeTruthy();
  });

  it("reports a switch tap through that toggle's onToggle only — no self-flipping", () => {
    const { toggles } = renderSheet();
    fireEvent.click(screen.getByTestId("map-toggle-territories"));
    expect(toggles[1].onToggle).toHaveBeenCalledTimes(1);
    expect(toggles[0].onToggle).not.toHaveBeenCalled();
    // Controlled: aria-checked only moves when the parent re-renders with new props.
    expect(screen.getByTestId("map-toggle-territories").getAttribute("aria-checked")).toBe("false");
  });

  it("basemap segmented control fires onChange and keeps aria-pressed truthful", () => {
    const { onBasemapChange } = renderSheet();
    const streets = screen.getByTestId("map-settings-basemap-streets");
    const satellite = screen.getByTestId("map-settings-basemap-satellite");
    expect(streets.getAttribute("aria-pressed")).toBe("true");
    expect(satellite.getAttribute("aria-pressed")).toBe("false");
    expect(streets.className).toContain("bg-primary");

    fireEvent.click(satellite);
    expect(onBasemapChange).toHaveBeenCalledWith("satellite");
    // Controlled: still streets until the parent passes the new value down.
    expect(streets.getAttribute("aria-pressed")).toBe("true");
  });

  it("omits the segmented control entirely when no basemap prop is wired", () => {
    renderSheet({ basemap: undefined });
    expect(screen.queryByTestId("map-settings-basemap-streets")).toBeNull();
    expect(screen.queryByTestId("map-settings-basemap-satellite")).toBeNull();
    expect(screen.queryByText("Basemap")).toBeNull();
  });

  it("closes from the scrim and from the header X", () => {
    const { onClose } = renderSheet();
    fireEvent.click(screen.getByTestId("map-settings-scrim"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("map-settings-close"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("renders nothing at all when closed", () => {
    renderSheet({ open: false });
    expect(screen.queryByTestId("map-settings-sheet")).toBeNull();
  });
});
