import { useState } from "react";
import { Radar, Globe, ScanSearch } from "lucide-react";
import CityScanner from "./CityScanner";
import USAScanner from "./USAScanner";
import CnsScanner from "./CnsScanner";

// One Scanner hub — City / USA / Nightly tabs replace three separate nav pages.
export type ScannerTab = "city" | "usa" | "cns";

const TABS: { id: ScannerTab; label: string; hint: string; Icon: React.ElementType }[] = [
  { id: "city", label: "City Scan",    hint: "Scan one city for new fiber",        Icon: Radar },
  { id: "usa",  label: "USA Batch",    hint: "Queue many cities across the USA",   Icon: Globe },
  { id: "cns",  label: "Nightly Auto", hint: "Automatic overnight CNS re-scan",    Icon: ScanSearch },
];

export default function Scanners({ initialTab = "city" }: { initialTab?: ScannerTab }) {
  const [tab, setTab] = useState<ScannerTab>(initialTab);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-4 pt-3 pb-0 border-b border-border bg-card flex-shrink-0">
        {TABS.map(({ id, label, hint, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            title={hint}
            data-testid={`scanner-tab-${id}`}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
              tab === id
                ? "border-primary text-primary bg-primary/5"
                : "border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary/50"
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
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
