// The centralized notification service: dedupe, capped visible stack with
// instant replace, severity-driven timing (EVERYTHING auto-dismisses — routine
// ~2.5s, important ~6s; explicit duration:null is the only persist), the
// variant→severity bridge, and the durable error center.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  toast, reducer, resolveDuration, dedupeSignature,
  getErrorNotifications, __resetToastsForTest,
  SUCCESS_DISMISS_MS, ERROR_DISMISS_MS,
} from "@/hooks/use-toast";

// The `toast()` side effects mutate the module singleton; we assert via the
// reducer + exported helpers to keep the suite React-free.
beforeEach(() => { __resetToastsForTest(); vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); __resetToastsForTest(); });

describe("timing by severity — everything auto-dismisses", () => {
  it("routine ~2.5s; important ~6s (longer beat, still temporary)", () => {
    expect(resolveDuration({ severity: "success" })).toBe(SUCCESS_DISMISS_MS);
    expect(resolveDuration({ severity: "info" })).toBe(SUCCESS_DISMISS_MS);
    expect(SUCCESS_DISMISS_MS).toBe(2500);
    expect(resolveDuration({ severity: "error" })).toBe(ERROR_DISMISS_MS);
    expect(resolveDuration({ severity: "warning" })).toBe(ERROR_DISMISS_MS);
    expect(resolveDuration({ severity: "offline" })).toBe(ERROR_DISMISS_MS);
    expect(resolveDuration({ severity: "payment" })).toBe(ERROR_DISMISS_MS);
    expect(ERROR_DISMISS_MS).toBe(6000);
  });
  it("explicit duration overrides severity; null is the only persist", () => {
    expect(resolveDuration({ severity: "error", duration: 1000 })).toBe(1000);
    expect(resolveDuration({ severity: "success", duration: null })).toBeNull();
    expect(resolveDuration({ severity: "error", duration: null })).toBeNull();
    // loading is lifecycle-bound (caller updates/dismisses it), not timed
    expect(resolveDuration({ severity: "loading" })).toBeNull();
    // no severity at all defaults to the routine window
    expect(resolveDuration({})).toBe(SUCCESS_DISMISS_MS);
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

describe("reducer — instant replace, max two visible", () => {
  const mk = (id: string, over: any = {}) => ({ id, title: id, open: true, ...over });
  it("a second toast shows IMMEDIATELY alongside the first (no queueing)", () => {
    let s = { toasts: [] } as any;
    s = reducer(s, { type: "ADD_TOAST", toast: mk("a") } as any);
    s = reducer(s, { type: "ADD_TOAST", toast: mk("b") } as any);
    expect(s.toasts.map((t: any) => t.id)).toEqual(["b", "a"]); // newest first
    expect(s.toasts.every((t: any) => t.open)).toBe(true);       // both visible
  });
  it("a third toast pushes the oldest into its exit — never three open", () => {
    let s = { toasts: [] } as any;
    s = reducer(s, { type: "ADD_TOAST", toast: mk("a") } as any);
    s = reducer(s, { type: "ADD_TOAST", toast: mk("b") } as any);
    s = reducer(s, { type: "ADD_TOAST", toast: mk("c") } as any);
    // the new toast is open instantly; the evicted oldest is closing
    const open = s.toasts.filter((t: any) => t.open !== false).map((t: any) => t.id);
    expect(open).toEqual(["c", "b"]);
    expect(s.toasts.find((t: any) => t.id === "a")?.open).toBe(false);
    // ...and the evicted toast unmounts after its short exit window
    vi.runOnlyPendingTimers();
  });
  it("dismiss closes (open:false) and removal later drops it from state", () => {
    let s = { toasts: [mk("a"), mk("b")] } as any;
    s = reducer(s, { type: "DISMISS_TOAST", toastId: "b" } as any);
    expect(s.toasts.find((t: any) => t.id === "b")?.open).toBe(false);
    s = reducer(s, { type: "REMOVE_TOAST", toastId: "b" } as any);
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

  it("success leaves at ~2.5s; error stays for its longer ~6s beat, then leaves too", () => {
    const s = toast({ title: "Saved", severity: "success" });
    const e = toast({ title: "Save failed", severity: "error" });
    // After the routine window the success dismiss has fired but the error's
    // has not (its window is longer)...
    vi.advanceTimersByTime(SUCCESS_DISMISS_MS + 500);
    expect(vi.getTimerCount()).toBeGreaterThan(0); // error dismiss still pending
    // ...and after the long beat NOTHING is pending — the error left as well.
    vi.advanceTimersByTime(ERROR_DISMISS_MS);
    vi.runOnlyPendingTimers(); // flush exit-animation removals
    expect(vi.getTimerCount()).toBe(0);
    // The failure is still recoverable from the durable error center.
    const log = getErrorNotifications();
    expect(log.some(n => n.title === "Save failed")).toBe(true);
    expect(log.some(n => n.title === "Saved")).toBe(false);
    e.dismiss(); s.dismiss();
  });

  it("explicit duration:null is the opt-out — that toast never auto-dismisses", () => {
    toast({ title: "Stay put", severity: "error", duration: null });
    vi.advanceTimersByTime(ERROR_DISMISS_MS * 10);
    expect(vi.getTimerCount()).toBe(0); // no dismiss was ever scheduled
  });

  it("updating a loading toast to a terminal severity re-arms auto-dismiss", () => {
    // The loading→done pattern: the handle's update() changes the severity,
    // and the toast must then leave on the NEW severity's window instead of
    // keeping loading's persist-forever schedule from creation time.
    const h = toast({ title: "Saving…", severity: "loading" })
    vi.advanceTimersByTime(ERROR_DISMISS_MS * 2)
    expect(vi.getTimerCount()).toBe(0) // loading persists — nothing scheduled
    h.update({ title: "Saved", severity: "success" })
    expect(vi.getTimerCount()).toBeGreaterThan(0) // dismiss now armed
    vi.advanceTimersByTime(SUCCESS_DISMISS_MS + 1)
    vi.runOnlyPendingTimers() // flush the exit-animation removal
    expect(vi.getTimerCount()).toBe(0) // gone for good
  })

  it("an update that does not touch timing leaves the existing schedule alone", () => {
    toast({ title: "Stay", severity: "error", duration: null }).update({ title: "Still here" })
    vi.advanceTimersByTime(ERROR_DISMISS_MS * 10)
    expect(vi.getTimerCount()).toBe(0) // duration:null opt-out survives the update
  })

  it("legacy variant:'destructive' is treated as an error (logged + long beat)", () => {
    toast({ title: "Boom", variant: "destructive" });
    const log = getErrorNotifications();
    expect(log[0].title).toBe("Boom");
    expect(log[0].severity).toBe("error");
    // it auto-dismisses on the error window like any other error
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    vi.advanceTimersByTime(ERROR_DISMISS_MS + 1);
    vi.runOnlyPendingTimers();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the error center keeps only errors/warnings/offline/payment, newest first", () => {
    toast({ title: "ok", severity: "success" });
    toast({ title: "warn", severity: "warning" });
    toast({ title: "down", severity: "offline" });
    const titles = getErrorNotifications().map(n => n.title);
    expect(titles).toEqual(["down", "warn"]);   // newest first, success excluded
  });
});
