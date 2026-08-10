// ── Map settings sheet ────────────────────────────────────────────────────────
// SalesRabbit-style bottom sheet for the map screen: basemap picker + layer
// toggles, fully controlled by the parent (no internal map state — the sheet
// only reflects and reports). Same container/scrim grammar as ReclaimAllDialog
// so every sheet in the app opens, dims, and dismisses identically.
import { X } from "lucide-react";
import { FOCUS } from "@/lib/a11y";

export type BasemapValue = "streets" | "satellite" | "dark";

export interface MapSettingsToggle {
  key: string;
  label: string;
  description?: string;
  on: boolean;
  onToggle: () => void;
  testId: string;
}

export interface MapSettingsSheetProps {
  open: boolean;
  onClose: () => void;
  basemap?: { value: BasemapValue; onChange: (v: BasemapValue) => void };
  toggles: MapSettingsToggle[];
}

const BASEMAPS: ReadonlyArray<{ value: BasemapValue; label: string }> = [
  { value: "streets", label: "Streets" },
  { value: "satellite", label: "Satellite" },
  { value: "dark", label: "Dark" },
];

export function MapSettingsSheet({ open, onClose, basemap, toggles }: MapSettingsSheetProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="map-settings-title"
      data-testid="map-settings-sheet"
    >
      {/* Scrim */}
      <button
        aria-label="Close"
        onClick={onClose}
        className={`absolute inset-0 bg-overlay ${FOCUS}`}
        data-testid="map-settings-scrim"
      />

      <div className="relative w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-border bg-card p-5 shadow-xl animate-in fade-in slide-in-from-bottom-4 sm:slide-in-from-bottom-0 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between gap-3">
          <h2 id="map-settings-title" className="text-[16px] font-bold text-foreground leading-tight">
            Map settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close map settings"
            data-testid="map-settings-close"
            className={`-mr-2 -my-2 w-11 h-11 flex items-center justify-center rounded-xl text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors ${FOCUS}`}
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Basemap — segmented control, only when the parent wires it */}
        {basemap && (
          <div className="mt-3">
            <div
              id="map-settings-basemap-label"
              className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              Basemap
            </div>
            <div
              role="group"
              aria-labelledby="map-settings-basemap-label"
              className="mt-2 grid grid-cols-3 gap-1 rounded-xl border border-border bg-secondary/40 p-1"
            >
              {BASEMAPS.map(o => {
                const selected = basemap.value === o.value;
                return (
                  <button
                    key={o.value}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => basemap.onChange(o.value)}
                    data-testid={`map-settings-basemap-${o.value}`}
                    className={`h-11 rounded-lg text-[14px] font-semibold transition-colors ${selected ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary"} ${FOCUS}`}
                  >
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Layer toggles */}
        <ul className="mt-3 divide-y divide-border">
          {toggles.map(t => {
            const descId = t.description ? `map-settings-desc-${t.key}` : undefined;
            return (
              <li key={t.key} className="flex min-h-tap items-center justify-between gap-3 py-1.5">
                <span className="min-w-0">
                  <span className="block text-[14px] font-semibold text-foreground">{t.label}</span>
                  {t.description && (
                    <span id={descId} className="block text-[12px] text-muted-foreground mt-0.5">
                      {t.description}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={t.on}
                  aria-label={t.label}
                  aria-describedby={descId}
                  onClick={t.onToggle}
                  data-testid={t.testId}
                  className={`relative h-11 w-11 shrink-0 rounded-full ${FOCUS}`}
                >
                  {/* Track (w-11 h-6) with translating thumb; button stays h-11 for the tap target */}
                  <span
                    aria-hidden="true"
                    className={`absolute inset-x-0 top-1/2 -translate-y-1/2 h-6 rounded-full transition-colors ${t.on ? "bg-primary" : "bg-muted-foreground/30"}`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${t.on ? "translate-x-5" : "translate-x-0"}`}
                    />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export default MapSettingsSheet;
