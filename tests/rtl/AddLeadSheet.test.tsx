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

import { AddLeadSheet } from "../../client/src/components/AddLeadSheet";

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
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(42, { existed: false }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Lead added" }));
  });

  it("a duplicate address reconciles in the background — onCreated(existing id, existed:true)", async () => {
    apiRequest.mockResolvedValue({ json: async () => ({ id: 7, existed: true }) });
    const { onClose, onCreated } = renderSheet();
    await userEvent.click(screen.getByTestId("add-lead-submit"));
    expect(onClose).toHaveBeenCalledTimes(1); // never blocked on the dedupe
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(7, { existed: true }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Already in the system — opening it",
    }));
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
