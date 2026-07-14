import { useState } from "react";
import { Radar, Globe, ScanSearch, ChevronRight } from "lucide-react";
import CityScanner from "./CityScanner";
import USAScanner from "./USAScanner";
import CnsScanner from "./CnsScanner";

// One Scanner hub — City / USA / Nightly tabs replace three separate nav pages.
export type ScannerTab = "city" | "usa" | "cns";

const TABS: { id: ScannerTab; label: string; hint: string; Icon: React.ElementType }[] = [
  { id: "city", label: "City Scan",    hint: "Fresh fiber: Yes, No, or Recheck",   Icon: Radar },
  { id: "usa",  label: "USA Batch",    hint: "Run the same verdict across cities", Icon: Globe },
  { id: "cns",  label: "Nightly Auto", hint: "Recheck for newly fresh fiber",       Icon: ScanSearch },
];

export default function Scanners({ initialTab = "city" }: { initialTab?: ScannerTab }) {
  const [tab, setTab] = useState<ScannerTab>(initialTab);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Launcher — entry cards for each scan tool */}
      <div className="flex-shrink-0 border-b border-border bg-card px-4 pt-5 pb-4 sm:px-6">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">Scanners</div>
        <h1 className="mt-1 text-lg font-semibold tracking-tight text-foreground">
          Choose a scan tool
        </h1>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {TABS.map(({ id, label, hint, Icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                onClick={() => setTab(id)}
                title={hint}
                data-testid={`scanner-tab-${id}`}
                aria-pressed={active}
                className={`group flex items-start gap-3 rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                  active
                    ? "border-primary bg-primary/5"
                    : "border-border bg-background hover:border-primary/40 hover:bg-secondary/40"
                }`}
              >
                <span
                  className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border ${
                    active
                      ? "border-primary/30 bg-primary/10 text-primary"
                      : "border-border bg-card text-muted-foreground group-hover:text-foreground"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span
                      className={`text-sm font-semibold tracking-tight ${
                        active ? "text-primary" : "text-foreground"
                      }`}
                    >
                      {label}
                    </span>
                    <ChevronRight
                      className={`h-4 w-4 flex-shrink-0 transition-transform ${
                        active
                          ? "text-primary"
                          : "text-muted-foreground group-hover:translate-x-0.5"
                      }`}
                    />
                  </span>
                  <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                    {hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Active scanner */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === "city" && <CityScanner />}
        {tab === "usa" && <USAScanner />}
        {tab === "cns" && <CnsScanner />}
      </div>
    </div>
  );
}
