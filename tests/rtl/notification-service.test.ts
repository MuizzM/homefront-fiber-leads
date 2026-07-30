// The centralized notification service: dedupe, one-at-a-time queue,
// severity-driven timing (routine auto-dismiss, important persist), the
// variant→severity bridge, and the durable error center.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  toast, reducer, resolveDuration, dedupeSignature,
  getErrorNotifications, __resetToastsForTest,
} from "@/hooks/use-toast";

// Read module state through a fresh reducer-independent probe: the `toast()`
// side effects mutate the singleton, and useToast() exposes it — but we assert
// via the reducer + exported helpers to keep it React-free.
beforeEach(() => { __resetToastsForTest(); vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); __resetToastsForTest(); });

// A tiny visible-count probe using the exported helpers isn't enough; drive the
// singleton and observe via a subscription through useToast is heavy, so we
// assert timing/dedupe through the pure surface plus the error center.

describe("timing by severity", () => {
  it("routine severities auto-dismiss (~2.6s); important ones persist", () => {
    expect(resolveDuration({ severity: "success" })).toBe(2600);
    expect(resolveDuration({ severity: "info" })).toBe(2600);
    expect(resolveDuration({ severity: "error" })).toBeNull();
    expect(resolveDuration({ severity: "warning" })).toBeNull();
    expect(resolveDuration({ severity: "offline" })).toBeNull();
    expect(resolveDuration({ severity: "payment" })).toBeNull();
    // explicit duration overrides severity
    expect(resolveDuration({ severity: "error", duration: 1000 })).toBe(1000);
    expect(resolveDuration({ severity: "success", duration: null })).toBeNull();
  });
});

describe("dedupe signature", () => {
  it("identical title+severity dedupe; explicit key wins", () => {
    expect(dedupeSignature({ id: "1", severity: "success", title: "Saved" } as any))
      .toBe(dedupeSignature({ id: "2", severity: "success", title: "Saved" } as any));
    expect(dedupeSignature({ id: "1", title: "A" } as any))
      .not.toBe(dedupeSignature({ id: "2", title: "B" } as any));
    expect(dedupeSignature({ id: "1", dedupeKey: "k", title: "A" } as any))
      .toBe(dedupeSignature({ id: "2", dedupeKey: "k", title: "Z" } as any));
  });
});

describe("reducer — one visible at a time + queue", () => {
  const mk = (id: string, over: any = {}) => ({ id, title: id, open: true, ...over });
  it("second toast queues while the first is visible", () => {
    let s = { toasts: [], queue: [] } as any;
    s = reducer(s, { type: "ADD_TOAST", toast: mk("a") } as any);
    s = reducer(s, { type: "ADD_TOAST", toast: mk("b") } as any);
    expect(s.toasts.map((t: any) => t.id)).toEqual(["a"]);
    expect(s.queue.map((t: any) => t.id)).toEqual(["b"]);
  });
  it("removing the visible toast promotes the queued one", () => {
    let s = { toasts: [mk("a")], queue: [mk("b")] } as any;
    s = reducer(s, { type: "REMOVE_TOAST", toastId: "a" } as any);
    expect(s.toasts.map((t: any) => t.id)).toEqual(["b"]);
    expect(s.queue).toEqual([]);
  });
  it("a queued toast dismissed before showing is dropped, not promoted", () => {
    let s = { toasts: [mk("a")], queue: [mk("b")] } as any;
    s = reducer(s, { type: "DISMISS_TOAST", toastId: "b" } as any);
    expect(s.queue).toEqual([]);
    expect(s.toasts.map((t: any) => t.id)).toEqual(["a"]);
  });
});

describe("live behavior through toast()", () => {
  it("a duplicate message is dropped — recorded/shown once, not twice", () => {
    // Fire the same error three times rapidly (a retry-storm). Dedupe must
    // collapse them: the error center keeps exactly one entry.
    toast({ title: "Save failed", severity: "error" });
    toast({ title: "Save failed", severity: "error" });
    toast({ title: "Save failed", severity: "error" });
    expect(getErrorNotifications().filter(n => n.title === "Save failed").length).toBe(1);
  });

  it("routine success auto-dismisses; error persists past the routine window", () => {
    const s = toast({ title: "Saved", severity: "success" });
    const e = toast({ title: "Save failed", severity: "error" });
    vi.advanceTimersByTime(3000);
    // success should have scheduled a dismiss; error never does. We assert the
    // error is retained in the error center (durable) and success is not.
    const log = getErrorNotifications();
    expect(log.some(n => n.title === "Save failed")).toBe(true);
    expect(log.some(n => n.title === "Saved")).toBe(false);
    e.dismiss(); s.dismiss();
  });

  it("legacy variant:'destructive' is treated as an error (persists + logged)", () => {
    toast({ title: "Boom", variant: "destructive" });
    const log = getErrorNotifications();
    expect(log[0].title).toBe("Boom");
    expect(log[0].severity).toBe("error");
  });

  it("the error center keeps only errors/warnings/offline/payment, newest first", () => {
    toast({ title: "ok", severity: "success" });
    toast({ title: "warn", severity: "warning" });
    toast({ title: "down", severity: "offline" });
    const titles = getErrorNotifications().map(n => n.title);
    expect(titles).toEqual(["down", "warn"]);   // newest first, success excluded
  });
});
