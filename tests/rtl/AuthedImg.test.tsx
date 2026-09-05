import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/queryClient", () => ({ apiRequest }));
import { AuthedImg } from "../../client/src/components/AuthedImg";

const observed = new Map<Element, IntersectionObserverCallback>();
const revoke = vi.fn();
const create = vi.fn(() => "blob:fixture");
beforeEach(() => {
  observed.clear(); apiRequest.mockReset(); revoke.mockClear(); create.mockClear();
  apiRequest.mockResolvedValue({ blob: async () => new Blob(["fixture"]) });
  vi.stubGlobal("URL", class extends URL { static createObjectURL = create; static revokeObjectURL = revoke; });
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(element: Element) { observed.set(element, this.callback); }
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function reveal(element: Element) {
  act(() => observed.get(element)?.([{ isIntersecting: true, target: element } as IntersectionObserverEntry], {} as IntersectionObserver));
}

describe("authenticated photo loading", () => {
  it("downloads only visible photos and releases object URLs on unmount", async () => {
    const view = render(<>{Array.from({ length: 24 }, (_, id) => <AuthedImg key={id} photoId={id} alt={`Photo ${id}`} />)}</>);
    expect(apiRequest).not.toHaveBeenCalled();
    reveal(screen.getByRole("img", { name: "Loading Photo 0" }));
    await screen.findByRole("img", { name: "Photo 0" });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    reveal(screen.getByRole("img", { name: "Loading Photo 8" }));
    await screen.findByRole("img", { name: "Photo 8" });
    expect(apiRequest).toHaveBeenCalledTimes(2);
    view.unmount(); expect(revoke).toHaveBeenCalledTimes(2);
  });
  it("loads an explicitly opened lightbox eagerly and supports missing IntersectionObserver", async () => {
    render(<AuthedImg photoId={1} alt="Full photo" loading="eager" />);
    await screen.findByRole("img", { name: "Full photo" });
    expect(apiRequest).toHaveBeenCalledTimes(1);
    cleanup(); vi.stubGlobal("IntersectionObserver", undefined);
    render(<AuthedImg photoId={2} alt="Fallback photo" />);
    await screen.findByRole("img", { name: "Fallback photo" });
  });
  it("does not create an orphan blob URL for a removed image", async () => {
    let finish!: (response: { blob: () => Promise<Blob> }) => void;
    apiRequest.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<AuthedImg photoId={1} alt="Removed" loading="eager" />);
    view.unmount();
    await act(async () => finish({ blob: async () => new Blob() }));
    expect(create).not.toHaveBeenCalled();
  });
  it("preserves a visible accessible placeholder when the file fails", async () => {
    apiRequest.mockRejectedValue(new Error("offline"));
    render(<AuthedImg photoId={1} alt="Door photo" loading="eager" />);
    await waitFor(() => expect(screen.getByRole("img")).toHaveAccessibleName("Door photo: couldn't load photo"));
  });
});
