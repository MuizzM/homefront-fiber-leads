// The Add-Lead sheet's perceived-latency contract, pinned.
//
// The sheet must (1) render the full prefilled form synchronously — no fetch
// gates the open and no sheet-wide spinner exists, (2) on submit, CLOSE on the
// same tap and run the POST in the background — never an in-sheet "Adding…"
// phase, (3) call onCreated with the real server id once the response lands
// (the map's camera fly is a follow-on, not the perceived add), (4) surface a
// destructive toast when the background save fails so the door is never
// silently dropped, and (5) keep the submit button disabled for the one frame
// before close so a double tap can't post twice.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";

const apiRequest = vi.fn();
vi.mock("@/lib/queryClient", () => ({
  apiRequest: (...a: any[]) => apiRequest(...a),
  queryClient: undefined,
}));
const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

import {
  AddLeadSheet,
  planExistingLead,
  hiddenStatusPlain,
  type LeadVisibility,
} from "../../client/src/components/AddLeadSheet";

// Emoji / pictographic detector — the honest surfacing copy is plain text only.
// Extended_Pictographic matches every emoji glyph but NOT the em dash / ellipsis
// / apostrophes the plain-language strings legitimately use.
const EMOJI = /\p{Extended_Pictographic}/u;
const vis = (over: Partial<LeadVisibility>): LeadVisibility => ({
  geocoded: true, hiddenStatus: null, inYourScope: true,
  assignedRepName: null, reason: "visible", ...over,
});

// jsdom lacks the pointer APIs Radix's dismissable layer touches.
beforeAll(() => {
  const proto = Element.prototype as any;
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!window.HTMLElement.prototype.scrollIntoView) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  }
});

const INITIAL = {
  address: "402 Nard Ln", city: "Inman", state: "SC", zip: "29349",
  lat: 35.05, lng: -82.09,
};

function renderSheet(over: Record<string, any> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onCreated = vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <AddLeadSheet initial={INITIAL} onClose={onClose} onCreated={onCreated} {...over} />
    </QueryClientProvider>,
  );
  return { ...utils, onClose, onCreated, qc };
}

beforeEach(() => { apiRequest.mockReset(); toast.mockReset(); });

describe("add-lead sheet perceived-latency contract", () => {
  it("renders the full prefilled form synchronously — no fetch gate, no sheet-wide spinner", () => {
    renderSheet();
    expect(screen.getByTestId("add-lead-sheet")).toBeInTheDocument();
    expect(screen.getByTestId("add-lead-address")).toHaveValue("402 Nard Ln");
    expect(screen.getByTestId("add-lead-city")).toHaveValue("Inman");
    expect(screen.getByTestId("add-lead-zip")).toHaveValue("29349");
    expect(screen.getByTestId("add-lead-state-sc")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("add-lead-submit")).toBeEnabled();
    // Opening never touches the network, and nothing spins while idle.
    expect(apiRequest).not.toHaveBeenCalled();
    expect(document.querySelector(".animate-spin")).toBeNull();
  });

  it("submit closes the sheet on the SAME tap — before the POST resolves — with no Adding… phase", async () => {
    let resolvePost!: (v: unknown) => void;
    apiRequest.mockReturnValue(new Promise((resolve) => { resolvePost = resolve; }));
    const { onClose, onCreated } = renderSheet();

    await userEvent.click(screen.getByTestId("add-lead-submit"));

    // Closed immediately, POST still in flight.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(apiRequest).toHaveBeenCalledTimes(1);
    expect(apiRequest).toHaveBeenCalledWith("POST", "/api/leads", expect.objectContaining({
      address: "402 Nard Ln", city: "Inman", state: "SC", zip: "29349",
      lat: 35.05, lng: -82.09,
    }));
    expect(onCreated).not.toHaveBeenCalled();
    // No loading copy ever renders; the button just disables for the frame
    // before close (double-submit guard).
    const btn = screen.getByTestId("add-lead-submit");
    expect(btn).toHaveTextContent("Add lead");
    expect(btn).not.toHaveTextContent("Adding");
    expect(btn).toBeDisabled();
    expect(btn.querySelector(".animate-spin")).toBeNull();

    // The real id arrives later and drives the follow-on (map fly + toast).
    resolvePost({ json: async () => ({ id: 42, existed: false, address: "402 Nard Ln", lat: 35.05, lng: -82.09 }) });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(42, expect.objectContaining({ existed: false })));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Lead added" }));
  });

  it("a duplicate hands the server visibility straight to onCreated and does NOT toast itself", async () => {
    // The reason-aware honest message + open-by-id is MapView's job now (it can
    // flash a real pin or explain an off-map lead); the sheet must not fire the
    // old blanket "opening it" toast, which lied for ungeocoded/suppressed/
    // out-of-scope duplicates. It just forwards visibility + address.
    const visibility = {
      geocoded: false, hiddenStatus: null, inYourScope: true,
      assignedRepName: null, reason: "ungeocoded" as const,
    };
    apiRequest.mockResolvedValue({ json: async () => ({ id: 7, existed: true, visibility }) });
    const { onClose, onCreated } = renderSheet();
    await userEvent.click(screen.getByTestId("add-lead-submit"));
    expect(onClose).toHaveBeenCalledTimes(1); // never blocked on the dedupe
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(7, expect.objectContaining({
      existed: true, visibility, address: "402 Nard Ln",
    })));
    // No self-toast on a duplicate — and never the removed "opening it" copy.
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({
      title: "Already in the system — opening it",
    }));
    expect(toast).not.toHaveBeenCalled();
  });

  it("a failed background save fires a destructive toast naming the door — never a silent drop", async () => {
    apiRequest.mockRejectedValue(new Error("400: address failed validation"));
    const { onClose, onCreated } = renderSheet();
    await userEvent.click(screen.getByTestId("add-lead-submit"));
    expect(onClose).toHaveBeenCalledTimes(1); // still closed instantly
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Couldn't add lead",
      variant: "destructive",
      description: expect.stringContaining("402 Nard Ln"),
    })));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      description: expect.stringContaining("address failed validation"),
    }));
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("the large sheet surface animates on GPU keyframes only — no transition-all, nothing >=300ms", () => {
    renderSheet();
    const cls = screen.getByTestId("add-lead-sheet").className;
    expect(cls).toMatch(/\btransition-none\b/);
    expect(cls).not.toMatch(/\btransition-all\b|(^|\s)transition(\s|$)/);
    expect(cls).toMatch(/\bwill-change-transform\b/);
    expect(cls).toMatch(/data-\[state=open\]:duration-200/);
    expect(cls).toMatch(/data-\[state=closed\]:duration-150/);
    expect(cls).not.toMatch(/\bduration-3\d\d\b|\bduration-[5-9]\d\d\b/);
  });

  it("renders nothing at all when closed", () => {
    renderSheet({ initial: null });
    expect(screen.queryByTestId("add-lead-sheet")).not.toBeInTheDocument();
  });
});

// The reason-aware decision behind BOTH existed handlers (one-tap add + the
// AddLeadSheet submit) — pinned as a pure function so the field behavior can't
// silently regress into the "says it exists but there's no pin" phantom.
describe("planExistingLead — honest surfacing of a duplicate lead", () => {
  const ADDR = "402 Nard Ln";

  it("visible: flashes + flies to the real pin and opens it (today's behavior)", () => {
    const plan = planExistingLead(ADDR, vis({ reason: "visible" }));
    expect(plan).toMatchObject({ onMap: true, fly: true, flash: true, open: true });
    expect(plan.toastTitle).toBe("Already on the map");
    expect(plan.severity).toBe("success");
  });

  it("ungeocoded: NO pin work — explains why and OPENS the lead by id (no pin required)", () => {
    const plan = planExistingLead(ADDR, vis({ reason: "ungeocoded", geocoded: false, inYourScope: true }));
    expect(plan.fly).toBe(false);
    expect(plan.flash).toBe(false);
    expect(plan.onMap).toBe(false);
    expect(plan.open).toBe(true); // opens by id regardless of a rendered pin
    expect(plan.toastTitle).toBe("Already a lead — not on your map");
    expect(plan.toastDescription).toContain(ADDR);
    expect(plan.toastDescription).toContain("map coordinates");
    expect(plan.toastDescription).toContain("Opening it");
  });

  it("hidden_status: names the plain reason (competitor / scope / review), opens when in scope", () => {
    const comp = planExistingLead(ADDR, vis({ reason: "hidden_status", hiddenStatus: "competitor_suppressed" }));
    expect(comp.toastDescription).toContain("competitor already serves");
    expect(comp.open).toBe(true);
    const scope = planExistingLead(ADDR, vis({ reason: "hidden_status", hiddenStatus: "scope_suppressed" }));
    expect(scope.toastDescription).toContain("outside the current service area");
    const review = planExistingLead(ADDR, vis({ reason: "hidden_status", hiddenStatus: "address_review" }));
    expect(review.toastDescription).toContain("under review");
  });

  it("out_of_scope: a locked-out caller is told it's another rep's/team's — and is NOT opened (no 404)", () => {
    const locked = planExistingLead(ADDR, vis({ reason: "out_of_scope", inYourScope: false }));
    expect(locked.open).toBe(false); // never fabricate access
    expect(locked.toastDescription).toContain("another rep or team");
    expect(locked.toastDescription).not.toContain("Opening it");
    // With a rep name the caller may know, name them; still not opened.
    const named = planExistingLead(ADDR, vis({ reason: "out_of_scope", inYourScope: false, assignedRepName: "Rory RepB" }));
    expect(named.toastDescription).toContain("Rory RepB");
    expect(named.open).toBe(false);
  });

  it("missing visibility (older server) falls back to today's visible behavior", () => {
    const plan = planExistingLead(ADDR, undefined);
    expect(plan).toMatchObject({ reason: "visible", fly: true, open: true });
  });

  it("no emoji in ANY reason's copy, and hiddenStatusPlain covers every status", () => {
    for (const reason of ["visible", "ungeocoded", "hidden_status", "out_of_scope"] as const) {
      for (const inScope of [true, false]) {
        const p = planExistingLead(ADDR, vis({ reason, inYourScope: inScope, hiddenStatus: "competitor_suppressed", assignedRepName: "Rep" }));
        expect(p.toastTitle).not.toMatch(EMOJI);
        expect(p.toastDescription).not.toMatch(EMOJI);
      }
    }
    for (const s of ["competitor_suppressed", "scope_suppressed", "address_review", "something_new", null]) {
      const words = hiddenStatusPlain(s);
      expect(words.length).toBeGreaterThan(0);
      expect(words).not.toMatch(EMOJI);
    }
  });
});
