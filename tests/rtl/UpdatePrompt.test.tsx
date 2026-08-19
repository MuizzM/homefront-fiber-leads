import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/pwa", () => ({ applyUpdate: vi.fn() }));

import { applyUpdate } from "@/lib/pwa";
import { UpdatePrompt } from "@/components/UpdatePrompt";

function announceUpdate() {
  act(() => {
    window.dispatchEvent(new CustomEvent("hfs:update-ready"));
  });
}

describe("UpdatePrompt", () => {
  it("stays above the mobile tab bar and can be dismissed", () => {
    render(<UpdatePrompt />);
    expect(screen.queryByTestId("pwa-update-prompt")).toBeNull();

    announceUpdate();
    const prompt = screen.getByRole("region", { name: "Software update available" });
    expect(prompt.className).toContain("bottom-[calc(5.75rem+env(safe-area-inset-bottom))]");
    expect(screen.getByRole("button", { name: "Update" }).className).toContain("min-h-11");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss update notification" }));
    expect(screen.queryByTestId("pwa-update-prompt")).toBeNull();
  });

  it("runs the existing update flow only after the user chooses Update", () => {
    render(<UpdatePrompt />);
    announceUpdate();
    fireEvent.click(screen.getByRole("button", { name: "Update" }));
    expect(vi.mocked(applyUpdate)).toHaveBeenCalledTimes(1);
  });
});
