import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("portal UI and accessibility contracts", () => {
  it("keeps one page-level heading in the scanner workspace", () => {
    expect(read("client/src/pages/Scanners.tsx").match(/<h1\b/g)).toHaveLength(1);
    for (const file of ["CityScanner.tsx", "USAScanner.tsx", "KineticScanner.tsx"]) {
      expect(read(`client/src/pages/${file}`)).not.toMatch(/<h1\b/);
    }
  });

  it("gives the calling queue a page heading without duplicating the lead heading", () => {
    expect(read("client/src/pages/CallingQueue.tsx")).toContain("<CallingChrome pageTitle>");
    expect(read("client/src/pages/CallingLead.tsx")).toContain("<CallingChrome>");
    expect(read("client/src/components/calling/CallingChrome.tsx")).toContain("<h1");
  });

  it("shows an honest map boot state instead of a blank canvas", () => {
    const map = read("client/src/pages/MapView.tsx");
    expect(map).toContain('data-testid="map-boot-status"');
    expect(map).toContain("!mapReady && !noToken");
    expect(map).toContain("Preparing your field map");
  });

  it("does not tell a user to share an unavailable referral link", () => {
    const referrals = read("client/src/pages/Referrals.tsx");
    expect(referrals).not.toContain("Share your link to get started.");
    expect(referrals).toContain("No referral activity yet.");
  });

  it("makes long navigation sections collapsible and accessible", () => {
    const layout = read("client/src/pages/Layout.tsx");
    expect(layout).toContain("aria-expanded={groupOpen}");
    expect(layout).toContain("aria-controls={groupId}");
    expect(layout).toContain("hidden={!groupOpen}");
  });

  it("keeps shared controls explicit about focus, errors, and pointer affordance", () => {
    expect(read("client/src/components/ui/button.tsx")).toContain("cursor-pointer");
    expect(read("client/src/components/ui/button.tsx")).toContain("focus-visible:ring-offset-2");
    expect(read("client/src/components/ui/input.tsx")).toContain("aria-[invalid=true]:border-destructive");
    expect(read("client/src/components/ui/textarea.tsx")).toContain("aria-[invalid=true]:border-destructive");
  });

  it("keeps notifications touch-sized, named, and visually balanced", () => {
    const toast = read("client/src/components/ui/toast.tsx");
    expect(toast).toContain('aria-label="Dismiss notification"');
    expect(toast).toContain("h-11 w-11");
    expect(toast).toContain("min-h-11");
    expect(toast).not.toContain("border-l-2");
  });

  it("uses touch-sized segmented scanner tabs instead of rounded underline tabs", () => {
    const scanner = read("client/src/pages/KineticScanner.tsx");
    expect(scanner).toContain("h-11 shrink-0");
    expect(scanner).toContain("bg-primary/10 text-primary");
    expect(scanner).not.toContain("border-b-2");
  });

  it("keeps metrics tabs touch-sized, focusable, and connected to one panel", () => {
    const metrics = read("client/src/pages/Metrics.tsx");
    expect(metrics).toContain('role="tablist"');
    expect(metrics).toContain('aria-controls="metrics-panel"');
    expect(metrics).toContain('role="tabpanel"');
    expect(metrics).toContain("min-h-11");

    const periods = read("client/src/components/metrics/MyMetrics.tsx");
    expect(periods).toContain('role="group"');
    expect(periods).toContain("aria-pressed={value === p.key}");
  });

  it("keeps commission states on the shared page, empty-state, and skeleton system", () => {
    const commission = read("client/src/pages/MyCommission.tsx");
    expect(commission).toContain('import { EmptyState } from "@/components/EmptyState"');
    expect(commission).toContain('import { PageHeader } from "@/components/ui/page-scaffold"');
    expect(commission).toContain('import { Skeleton } from "@/components/ui/skeleton"');
    expect(commission).not.toContain("function EmptyState(");
    expect(commission).not.toContain("animate-pulse");
  });

  it("uses the dynamic viewport and hides decorative shell icons", () => {
    const layout = read("client/src/pages/Layout.tsx");
    expect(layout).toContain('className="flex h-dvh overflow-hidden bg-background"');
    expect(layout).not.toContain('className="flex h-screen h-dvh');
    expect(layout).toContain('<LogOut className="h-4 w-4" aria-hidden="true"');
  });
});
