import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { elapsedShiftMinutes, isSuspiciousShiftDuration } from "../../client/src/lib/shiftDuration";

const root = path.resolve(__dirname, "../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("live portal UI audit regressions", () => {
  it("keeps the audited route headings and searches accessible", () => {
    expect(read("client/src/pages/Today.tsx")).toContain('<h1 className="sr-only">Today</h1>');
    expect(read("client/src/pages/MapView.tsx")).toContain('<h1 className="sr-only">Field map</h1>');
    expect(read("client/src/pages/Leads.tsx")).toContain('aria-label="Search leads"');
    expect(read("client/src/pages/Applications.tsx")).toContain('aria-label="Search candidates"');
  });

  it("associates scanner and import controls with accessible names", () => {
    const scanner = read("client/src/pages/CityScanner.tsx");
    expect(scanner).toContain('htmlFor="city-scanner-city"');
    expect(scanner).toContain('id="city-scanner-city"');
    expect(scanner).toContain('htmlFor="city-scanner-state"');
    expect(scanner).toContain('id="city-scanner-state"');

    const imports = read("client/src/pages/OrderImports.tsx");
    expect(imports).toContain('aria-label="Choose a PerfectVision order export"');
    expect(imports).toContain('aria-label="Sale ID to link this order"');
    expect(imports).toContain("min-h-11 md:min-h-9");
  });

  it("labels messaging controls and contains long configuration names on mobile", () => {
    const messaging = read("client/src/pages/OrderMessaging.tsx");
    expect(messaging).toContain("const id = useId()");
    expect(messaging).toContain("<Label htmlFor={id}");
    expect(messaging).toContain("<Switch aria-label={label}");
    expect(messaging).toContain("[overflow-wrap:anywhere]");
  });

  it("aligns the reverse-proxy referrer policy with the application", () => {
    const caddy = read("Caddyfile");
    expect(caddy).toMatch(/Referrer-Policy\s+no-referrer/);
    expect(caddy).not.toMatch(/Referrer-Policy\s+strict-origin-when-cross-origin/);
  });

  it("flags implausibly long sessions without modifying their recorded time", () => {
    expect(isSuspiciousShiftDuration(16 * 60)).toBe(false);
    expect(isSuspiciousShiftDuration(16 * 60 + 1)).toBe(true);
    expect(isSuspiciousShiftDuration(null)).toBe(false);
    expect(elapsedShiftMinutes("2026-08-18T10:00:00.000Z", Date.parse("2026-08-18T12:30:00.000Z"))).toBe(150);
    expect(elapsedShiftMinutes("not-a-date")).toBe(0);

    const clock = read("client/src/pages/ClockIn.tsx");
    expect(clock).toContain('needsReview ? "Review time" : "Active"');
    expect(clock).toContain('needsReview ? " · Review" : ""');
    expect(clock).toContain("formatSessionDateRange(s.clockedIn, s.clockedOut)");
    expect(clock).not.toContain("before payroll is finalized");
  });

  it("keeps contractor compensation wording and rep empty states accurate", () => {
    const today = read("client/src/pages/Today.tsx");
    expect(today).toContain("Records field activity; this is not hourly pay");
    expect(today).toContain("View your weekly commission statement");
    expect(today).not.toContain("Your hours count toward payroll");

    const leads = read("client/src/pages/Leads.tsx");
    expect(leads).toContain('isRep ? "No leads assigned yet"');
    expect(leads).toContain("Ask your team lead for a territory. Assigned doors will appear here and on the Field Map.");
  });
});
