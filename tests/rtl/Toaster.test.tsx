// The mounted Toaster must not let Radix's OWN close timer fight the
// notification service's timing. Radix Toast runs `durationProp || provider
// default (5000ms)` per toast and only `Infinity` disarms it — so a toast the
// service considers persistent (duration:null, and `loading` by default) was
// force-closed by Radix at 5s, and the 6s error window was cut short. These
// tests drive the REAL component tree (service → Toaster → Radix primitives)
// under fake timers, which the pure reducer suite (notification-service)
// cannot see.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { Toaster } from "@/components/ui/toaster";
import { toast, __resetToastsForTest, ERROR_DISMISS_MS, SUCCESS_DISMISS_MS } from "@/hooks/use-toast";

beforeEach(() => { __resetToastsForTest(); vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); __resetToastsForTest(); });

describe("Toaster vs Radix's built-in close timer", () => {
  it("a persistent toast (duration:null) survives Radix's 5s provider default", () => {
    render(<Toaster />);
    act(() => { toast({ title: "Hold the line", severity: "error", duration: null }); });
    expect(screen.getByText("Hold the line")).toBeInTheDocument();
    // Well past Radix's 5000ms default AND the service's error window — only
    // the explicit opt-out keeps it up, and it must actually stay up.
    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS * 3); });
    expect(screen.getByText("Hold the line")).toBeInTheDocument();
  });

  it("a loading toast persists until updated, then leaves on the NEW severity's window", () => {
    render(<Toaster />);
    let handle: ReturnType<typeof toast>;
    act(() => { handle = toast({ title: "Saving your route", severity: "loading" }); });
    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS * 2); });
    expect(screen.getByText("Saving your route")).toBeInTheDocument(); // not closed by Radix
    act(() => { handle!.update({ title: "Route saved", severity: "success" }); });
    expect(screen.getByText("Route saved")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(SUCCESS_DISMISS_MS + 500); });
    expect(screen.queryByText("Route saved")).not.toBeInTheDocument(); // service timing won
  });

  it("the service's timing governs: success leaves on its own ~2.5s window", () => {
    render(<Toaster />);
    act(() => { toast({ title: "Saved", severity: "success" }); });
    expect(screen.getByText("Saved")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(SUCCESS_DISMISS_MS + 500); });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });
});
